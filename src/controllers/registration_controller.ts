import { Request, Response } from 'express'
import { Webhook, getConfig, type connectionType } from '../services/config'
import { getConfig as getStoredConfig, setConfig } from '../services/redis'
import logger from '../services/logger'
import { Logout } from '../services/logout'
import { Reload } from '../services/reload'
import { resolveSessionPhoneByMetaId } from '../services/meta_alias'
import { resolveSessionProvider, resolveWhatsAppEngine } from '../services/providers/provider_resolver'
import { resolveRegistrationConnectionType } from '../services/providers/connection_type_policy'
import { isProviderRuntimeEnabled } from '../services/providers/provider_runtime_policy'
import { isWebhookOnlyUpdate } from '../services/webhook_only_update'

export class RegistrationController {
  private static readonly REGISTER_DEBOUNCE_MS = 15000
  private static readonly inFlightByPhone: Set<string> = new Set()
  private static readonly lastRegisterAtByPhone: Map<string, number> = new Map()

  private getConfig: getConfig
  private logout: Logout
  private reload: Reload

  constructor(getConfig: getConfig, reload: Reload, logout: Logout) {
    this.getConfig = getConfig
    this.reload = reload
    this.logout = logout
  }

  public async register(req: Request, res: Response) {
    logger.debug('register method %s', req.method)
    logger.debug('register headers %s', JSON.stringify(req.headers))
    logger.debug('register params %s', JSON.stringify(req.params))
    logger.debug('register body %s', JSON.stringify(req.body))
    logger.debug('register query %s', JSON.stringify(req.query))
    const phone = await resolveSessionPhoneByMetaId(req.params.phone)
    try {
      const previousConfig = await this.getConfig(phone)
      const storedConfig = await getStoredConfig(phone)
      if (storedConfig && !isProviderRuntimeEnabled(previousConfig.provider)) {
        return res.status(409).json({
          status: 'error',
          message: 'baileys_provider_disabled_deregister_required',
        })
      }
      const connectionType = resolveRegistrationConnectionType({
        hasStoredConfig: !!storedConfig,
        previousProvider: resolveWhatsAppEngine(previousConfig.provider),
        previousConnectionType: previousConfig.connectionType,
        requestedConnectionType: req.body.connectionType as connectionType | undefined,
      })
      const requestedProvider = req.body.provider ?? previousConfig.provider
      const provider = !storedConfig && !isProviderRuntimeEnabled(requestedProvider)
        ? resolveSessionProvider(undefined)
        : requestedProvider
      if (provider !== requestedProvider) {
        logger.warn(
          'Replaced disabled provider %s with %s for new session %s',
          requestedProvider,
          provider,
          phone,
        )
      }
      const requestedConfig = {
        ...req.body,
        provider,
        ...(connectionType.value ? { connectionType: connectionType.value } : {}),
      }
      if (connectionType.locked) {
        logger.warn(
          'Ignored connectionType change for existing Zapo session %s (%s -> %s); deregister is required',
          phone,
          previousConfig.connectionType,
          req.body.connectionType,
        )
      }
      await setConfig(phone, requestedConfig)
      const config = await this.getConfig(phone)
      if (storedConfig && config.provider === 'zapo' && Array.isArray(req.body.webhooks) && isWebhookOnlyUpdate(previousConfig, config)) {
        // setConfig publishes cache invalidation to every process. The webhook
        // pipeline reads the fresh config; the WhatsApp socket need not restart.
        logger.info('Applied webhook configuration without reconnect phone=%s', phone)
        return res.status(200).json(config)
      }
      const providerChanged = resolveWhatsAppEngine(previousConfig.provider) !== resolveWhatsAppEngine(config.provider)
      const now = Date.now()
      const last = RegistrationController.lastRegisterAtByPhone.get(phone) || 0
      const inFlight = RegistrationController.inFlightByPhone.has(phone)
      const inDebounceWindow = (now - last) < RegistrationController.REGISTER_DEBOUNCE_MS

      if (!providerChanged && (inFlight || inDebounceWindow)) {
        logger.warn(
          'register suppressed for %s (inFlight=%s debounceMs=%s)',
          phone,
          inFlight,
          Math.max(0, RegistrationController.REGISTER_DEBOUNCE_MS - (now - last))
        )
        return res.status(202).json({ ...config, registerSuppressed: true })
      }

      RegistrationController.inFlightByPhone.add(phone)
      RegistrationController.lastRegisterAtByPhone.set(phone, now)
      this.reload.run(phone)
        .catch((err) => logger.error(`register reload failed for ${phone}: ${err.message}`))
        .finally(() => {
          RegistrationController.inFlightByPhone.delete(phone)
        })

      return res.status(200).json(config)
    } catch (e) {
      return res.status(400).json({ status: 'error', message: `${phone} could not create, error: ${e.message}` })
    }
  }

  public async deregister(req: Request, res: Response) {
    logger.debug('deregister method %s', req.method)
    logger.debug('deregister headers %s', JSON.stringify(req.headers))
    logger.debug('deregister params %s', JSON.stringify(req.params))
    logger.debug('deregister body %s', JSON.stringify(req.body))
    logger.debug('deregister query %s', JSON.stringify(req.query))
    const phone = await resolveSessionPhoneByMetaId(req.params.phone)
    await this.logout.run(phone)
    return res.status(204).send()
  }

  public async updateWebhook(req: Request, res: Response) {
    logger.debug('updateWebhook method %s', req.method)
    logger.debug('updateWebhook params %s', JSON.stringify(req.params))
    logger.debug('updateWebhook body %s', JSON.stringify(req.body))
    const phone = await resolveSessionPhoneByMetaId(req.params.phone)
    const webhookId = `${req.params.webhook_id || ''}`.trim()
    const enabled = this.resolveWebhookEnabled(req.body)

    if (!webhookId) {
      return res.status(400).json({ status: 'error', message: 'webhook_id is required' })
    }
    if (enabled === undefined) {
      return res.status(400).json({ status: 'error', message: 'enabled or disabled boolean is required' })
    }

    const config = await this.getConfig(phone)
    const webhooks = (config.webhooks || []) as Webhook[]
    const index = webhooks.findIndex((webhook) => webhook.id === webhookId)

    if (index < 0) {
      return res.status(404).json({ status: 'error', message: `webhook ${webhookId} not found` })
    }

    const updatedWebhooks = webhooks.map((webhook, currentIndex) => {
      if (currentIndex !== index) return webhook
      const rest = { ...webhook }
      delete rest.disabled
      return { ...rest, enabled }
    })

    await setConfig(phone, { webhooks: updatedWebhooks, overrideWebhooks: true })
    const updatedConfig = await this.getConfig(phone)
    return res.status(200).json({
      status: 'ok',
      phone,
      webhook: updatedConfig.webhooks.find((webhook) => webhook.id === webhookId),
      webhooks: updatedConfig.webhooks,
    })
  }

  private resolveWebhookEnabled(body: unknown): boolean | undefined {
    const value = body as { enabled?: unknown, disabled?: unknown } | undefined
    if (typeof value?.enabled === 'boolean') return value.enabled
    if (typeof value?.disabled === 'boolean') return !value.disabled
    return undefined
  }
}
