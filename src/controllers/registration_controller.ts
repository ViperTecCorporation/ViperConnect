import { Request, Response } from 'express'
import { Webhook, getConfig } from '../services/config'
import { setConfig } from '../services/redis'
import logger from '../services/logger'
import { Logout } from '../services/logout'
import { Reload } from '../services/reload'
import { resolveSessionPhoneByMetaId } from '../services/meta_alias'

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
      await setConfig(phone, req.body)
      const now = Date.now()
      const last = RegistrationController.lastRegisterAtByPhone.get(phone) || 0
      const inFlight = RegistrationController.inFlightByPhone.has(phone)
      const inDebounceWindow = (now - last) < RegistrationController.REGISTER_DEBOUNCE_MS

      if (inFlight || inDebounceWindow) {
        logger.warn(
          'register suppressed for %s (inFlight=%s debounceMs=%s)',
          phone,
          inFlight,
          Math.max(0, RegistrationController.REGISTER_DEBOUNCE_MS - (now - last))
        )
        const config = await this.getConfig(phone)
        return res.status(202).json({ ...config, registerSuppressed: true })
      }

      RegistrationController.inFlightByPhone.add(phone)
      RegistrationController.lastRegisterAtByPhone.set(phone, now)
      this.reload.run(phone)
        .catch((err) => logger.error(`register reload failed for ${phone}: ${err.message}`))
        .finally(() => {
          RegistrationController.inFlightByPhone.delete(phone)
        })

      const config = await this.getConfig(phone)
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

  public async voiceBridgeConfig(req: Request, res: Response) {
    const phone = await resolveSessionPhoneByMetaId(req.params.phone)
    const config = await this.getConfig(phone)
    const serviceUrl = `${config.voipServiceUrl || ''}`.trim()
    const provisionToken = `${config.voipServiceToken || ''}`.trim()
    const slotId = `${config.voipSlotId || ''}`.trim()
    if (!serviceUrl || !provisionToken) {
      return res.status(400).json({ status: 'error', message: 'voip_service_not_configured_for_session' })
    }
    if (!slotId) {
      return res.status(400).json({ status: 'error', message: 'voip_slot_id_not_configured_for_session' })
    }

    try {
      const url = new URL('/v1/bridge/provisioned-config', serviceUrl)
      url.searchParams.set('slotId', slotId)
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${provisionToken}` },
        signal: AbortSignal.timeout(config.voipServiceTimeoutMs || 10_000),
      })
      const text = await response.text()
      const data = text ? JSON.parse(text) : {}
      if (!response.ok) return res.status(response.status).json(data)
      return res.status(200).json({ phone, ...data })
    } catch (error) {
      logger.warn(error as any, 'failed to query voice bridge config for %s', phone)
      return res.status(502).json({ status: 'error', message: `${error instanceof Error ? error.message : error}` })
    }
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
      const rest = { ...(webhook as any) }
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

  private resolveWebhookEnabled(body: any): boolean | undefined {
    if (typeof body?.enabled === 'boolean') return body.enabled
    if (typeof body?.disabled === 'boolean') return !body.disabled
    return undefined
  }
}
