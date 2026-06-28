import { Request, Response } from 'express'
import { getConfig } from '../services/config'
import { SessionStore } from '../services/session_store'
import logger from '../services/logger'
import { getAuthHeaderToken } from '../services/security'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { resolveSessionPhoneByMetaId } from '../services/meta_alias'
import { sendGraphError } from '../services/graph_error'
import { generateBusinessAccountId } from '../services/meta_ids'
import { isEmbeddedAccessToken } from '../services/embedded_tokens'
import { clients } from '../services/client'
import { pruneAuthSignalCache } from '../services/redis'

export class PhoneNumberController {
  private getConfig: getConfig
  private sessionStore: SessionStore

  constructor(getConfig: getConfig, sessionStore: SessionStore) {
    this.getConfig = getConfig
    this.sessionStore = sessionStore
  }

  private isAuthorizedToken(token: string, config: any): boolean {
    if (!token) return false
    if ([UNOAPI_AUTH_TOKEN, config?.authToken].includes(token)) return true
    return isEmbeddedAccessToken(token)
  }

  private buildGraphPhone(sessionPhone: string, config: any) {
    const phoneNumberId = `${config?.webhookForward?.phoneNumberId || sessionPhone}`
    const businessAccountId = `${config?.webhookForward?.businessAccountId || generateBusinessAccountId(sessionPhone, phoneNumberId)}`
    const frontend = `${process.env.FRONTEND_URL || ''}`.replace(/\/$/, '')
    return {
      id: phoneNumberId,
      business_account_id: businessAccountId,
      display_phone_number: sessionPhone,
      verified_name: config?.label || sessionPhone,
      quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_250',
      code_verification_status: 'VERIFIED',
      account_mode: 'LIVE',
      name_status: 'APPROVED',
      throughput: { level: 'STANDARD' },
      platform_type: 'CLOUD_API',
      last_onboarded_time: new Date().toISOString(),
      webhook_configuration: frontend ? { application: `${frontend}/webhooks/whatsapp/${sessionPhone}` } : {},
      certificate: null,
    }
  }

  public async get(req: Request, res: Response) {
    logger.debug('phone number get method %s', req.method)
    logger.debug('phone number get headers %s', JSON.stringify(req.headers))
    logger.debug('phone number get params %s', JSON.stringify(req.params))
    logger.debug('phone number get body %s', JSON.stringify(req.body))
    logger.debug('phone number get query', JSON.stringify(req.query))
    try {
      const { phone } = req.params
      const sessionPhone = await resolveSessionPhoneByMetaId(phone)
      const config = await this.getConfig(sessionPhone)
      const store = await config.getStore(sessionPhone, config)
      logger.debug('Session store retrieved!')
      const { sessionStore } = store
      const templates = await store.dataStore.loadTemplates()
      logger.debug('Templates retrieved!')
      const graphPhone = this.buildGraphPhone(sessionPhone, config)
      const fields = `${(req.query as any)?.fields || ''}`.trim()
      if (fields) {
        const selected: any = { id: graphPhone.id }
        for (const field of fields.split(',').map((value) => value.trim()).filter(Boolean)) {
          if (Object.prototype.hasOwnProperty.call(graphPhone, field)) selected[field] = (graphPhone as any)[field]
        }
        return res.status(200).json(selected)
      }
      return res.status(200).json({
        ...graphPhone,
        display_phone_number: sessionPhone,
        status: await sessionStore.getStatus(sessionPhone),
        message_templates: { data: templates },
        ...config,
      })
    } catch (e) {
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async list(req: Request, res: Response) {
    logger.debug('phone number list method %s', req.method)
    logger.debug('phone number list headers %s', JSON.stringify(req.headers))
    logger.debug('phone number list params %s', JSON.stringify(req.params))
    logger.debug('phone number list body %s', JSON.stringify(req.body))
    logger.debug('phone number list query', JSON.stringify(req.query))
    const token = getAuthHeaderToken(req)
    try {
      const wabaId = `${req.params.business_account_id || ''}`.trim()
      if (wabaId) {
        const sessionPhone = await resolveSessionPhoneByMetaId(wabaId)
        const config = await this.getConfig(sessionPhone)
        const authorized = this.isAuthorizedToken(token, config)
        if (!authorized) return res.status(200).json({ data: [] })
        const graphPhone = this.buildGraphPhone(sessionPhone, config)
        return res.status(200).json({ data: [graphPhone] })
      }
      const phones = await this.sessionStore.getPhones()
      const items = await Promise.all(phones.map(async (phone) => {
        const config = await this.getConfig(phone)
        const status = config.provider == 'forwarder' ? 'forwarder' : await this.sessionStore.getStatus(phone)
        if (this.isAuthorizedToken(token, config)) {
          return { ...config, id: phone, phone, display_phone_number: phone, status }
        }
        return undefined
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configs: any[] = items.filter((v) => !!v)
      logger.debug('Configs retrieved!')
      return res.status(200).json({ data: configs })
    } catch (e) {
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async whatsappBusinessAccounts(req: Request, res: Response) {
    logger.debug('waba list method %s', req.method)
    logger.debug('waba list headers %s', JSON.stringify(req.headers))
    logger.debug('waba list params %s', JSON.stringify(req.params))
    logger.debug('waba list body %s', JSON.stringify(req.body))
    logger.debug('waba list query %s', JSON.stringify(req.query))
    const token = getAuthHeaderToken(req)
    try {
      const phones = await this.sessionStore.getPhones()
      const accounts: Map<string, string> = new Map()
      for (const phone of phones) {
        const config = await this.getConfig(phone)
        if (!this.isAuthorizedToken(token, config)) continue
        const wabaId = `${(config as any)?.webhookForward?.businessAccountId || generateBusinessAccountId(phone, `${(config as any)?.webhookForward?.phoneNumberId || phone}`)}`.trim()
        if (wabaId) accounts.set(wabaId, `${(config as any)?.label || phone}`)
      }
      return res.status(200).json({
        data: Array.from(accounts.entries()).map(([id, name]) => ({ id, name })),
      })
    } catch (e) {
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async metaMappings(req: Request, res: Response) {
    logger.debug('meta mappings method %s', req.method)
    logger.debug('meta mappings headers %s', JSON.stringify(req.headers))
    const token = getAuthHeaderToken(req)
    try {
      const phones = await this.sessionStore.getPhones()
      const data: any[] = []
      for (const phone of phones) {
        const config = await this.getConfig(phone)
        if (!this.isAuthorizedToken(token, config)) continue
        const sessionPhone = `${phone}`.replace('+', '')
        const phoneNumberId = `${(config as any)?.webhookForward?.phoneNumberId || sessionPhone}`
        const businessAccountId = `${(config as any)?.webhookForward?.businessAccountId || generateBusinessAccountId(sessionPhone, phoneNumberId)}`
        data.push({
          session_phone: sessionPhone,
          phone_number_id: phoneNumberId,
          business_account_id: businessAccountId,
        })
      }
      return res.status(200).json({ data })
    } catch (e) {
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async resyncAppState(req: Request, res: Response) {
    logger.warn('app-state resync method %s', req.method)
    logger.warn('app-state resync params %s', JSON.stringify(req.params))
    try {
      const sessionPhone = await resolveSessionPhoneByMetaId(req.params.phone)
      const client = clients.get(sessionPhone)
      if (!client) {
        return sendGraphError(res, 404, `Session ${sessionPhone} is not loaded`, { code: 131016, type: 'GraphMethodException' })
      }
      if (typeof client.resyncAppState !== 'function') {
        return sendGraphError(res, 409, `Session ${sessionPhone} does not support app-state resync`, { code: 131016, type: 'GraphMethodException' })
      }
      const forceSnapshot = `${(req.body as any)?.force_snapshot ?? (req.body as any)?.forceSnapshot ?? 'true'}` !== 'false'
      await client.resyncAppState(forceSnapshot)
      return res.status(200).json({
        success: true,
        phone: sessionPhone,
        requested_collections: ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
        initial_sync: true,
        force_snapshot: forceSnapshot,
      })
    } catch (e) {
      logger.error(e as any, 'Failed to force app-state resync')
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async historyOnDemand(req: Request, res: Response) {
    logger.warn('history on-demand method %s', req.method)
    logger.warn('history on-demand params %s body %s', JSON.stringify(req.params), JSON.stringify(req.body))
    try {
      const sessionPhone = await resolveSessionPhoneByMetaId(req.params.phone)
      const client = clients.get(sessionPhone)
      if (!client) {
        return sendGraphError(res, 404, `Session ${sessionPhone} is not loaded`, { code: 131016, type: 'GraphMethodException' })
      }
      if (typeof client.fetchMessageHistory !== 'function') {
        return sendGraphError(res, 409, `Session ${sessionPhone} does not support history on-demand`, { code: 131016, type: 'GraphMethodException' })
      }
      const result = await client.fetchMessageHistory(req.body || {})
      return res.status(200).json({
        success: true,
        phone: sessionPhone,
        ...result,
      })
    } catch (e) {
      logger.error(e as any, 'Failed to request history on-demand')
      return sendGraphError(res, e?.code || 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async pruneAuthCache(req: Request, res: Response) {
    logger.warn('auth cache prune method %s', req.method)
    logger.warn('auth cache prune params %s body %s', JSON.stringify(req.params), JSON.stringify(req.body))
    try {
      const sessionPhone = await resolveSessionPhoneByMetaId(req.params.phone)
      const body: any = req.body || {}
      const types = Array.isArray(body.types)
        ? body.types
        : `${body.types || body.type || ''}`.split(',').map((value) => value.trim()).filter(Boolean)
      const dryRunValue = body.dry_run ?? body.dryRun
      const parseOptionalInt = (value: any): number | undefined => {
        const parsed = Number.parseInt(`${value ?? ''}`, 10)
        return Number.isFinite(parsed) ? parsed : undefined
      }
      const result = await pruneAuthSignalCache(sessionPhone, {
        types,
        dryRun: typeof dryRunValue === 'undefined' ? undefined : `${dryRunValue}` !== 'false',
        maxDelete: parseOptionalInt(body.max_delete ?? body.maxDelete),
        preKeyKeepRecent: parseOptionalInt(body.pre_key_keep_recent ?? body.preKeyKeepRecent),
        scanCount: parseOptionalInt(body.scan_count ?? body.scanCount),
      })
      return res.status(200).json({
        success: true,
        ...result,
      })
    } catch (e) {
      logger.error(e as any, 'Failed to prune auth cache')
      return sendGraphError(res, e?.code || 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async subscribedApps(req: Request, res: Response) {
    logger.debug('subscribed apps method %s', req.method)
    logger.debug('subscribed apps params %s', JSON.stringify(req.params))
    logger.debug('subscribed apps body %s', JSON.stringify(req.body))
    const token = getAuthHeaderToken(req)
    try {
      const id = `${req.params.business_account_id || ''}`.trim()
      const sessionPhone = await resolveSessionPhoneByMetaId(id)
      const config = await this.getConfig(sessionPhone)
      if (!this.isAuthorizedToken(token, config)) return sendGraphError(res, 403, 'Unsupported get request.', { code: 10, type: 'OAuthException' })
      if (req.method === 'DELETE') return res.status(200).json({ success: true })
      if (req.method === 'GET') return res.status(200).json({ data: [{ whitelisted: true }] })
      return res.status(200).json({ success: true })
    } catch (e) {
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async debugToken(req: Request, res: Response) {
    logger.debug('debug token (meta) method %s', req.method)
    const inputToken = `${(req.query as any)?.input_token || (req.query as any)?.access_token || ''}`.trim()
    const appId = `${process.env.EMBEDDED_SIGNUP_APP_ID || 'unoapi'}`
    try {
      const phones = await this.sessionStore.getPhones()
      const targetIds = new Set<string>()
      let isValid = false
      for (const phone of phones) {
        const config = await this.getConfig(phone)
        const wabaId = `${(config as any)?.webhookForward?.businessAccountId || generateBusinessAccountId(phone, `${(config as any)?.webhookForward?.phoneNumberId || phone}`)}`.trim()
        if (wabaId) targetIds.add(wabaId)
        if (this.isAuthorizedToken(inputToken, config)) isValid = true
      }
      if (UNOAPI_AUTH_TOKEN && inputToken === UNOAPI_AUTH_TOKEN) isValid = true
      if (isEmbeddedAccessToken(inputToken)) isValid = true
      return res.status(200).json({
        data: {
          is_valid: isValid,
          app_id: appId,
          application: 'unoapi',
          expires_at: 0,
          scopes: isValid ? ['whatsapp_business_management', 'whatsapp_business_messaging'] : [],
          granular_scopes: isValid ? [
            {
              scope: 'whatsapp_business_management',
              target_ids: Array.from(targetIds),
            },
            {
              scope: 'whatsapp_business_messaging',
              target_ids: Array.from(targetIds),
            },
          ] : [],
        },
      })
    } catch (e) {
      return sendGraphError(res, 500, e.message, { code: 131016, type: 'GraphMethodException' })
    }
  }
}
