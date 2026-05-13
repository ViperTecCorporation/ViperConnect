import { Outgoing } from './outgoing'
import fetch, { Response, RequestInit } from 'node-fetch'
import { Webhook, getConfig, isWebhookEnabled } from './config'
import logger from './logger'
import { completeCloudApiWebHook, isGroupMessage, isOutgoingMessage, isNewsletterMessage, isUpdateMessage, extractDestinyPhone, normalizeWebhookValueIds, jidToPhoneNumber, jidToRawPhoneNumber, formatJid, isValidPhoneNumber } from './transformer'
import { WEBHOOK_ASYNC, WEBHOOK_PREFER_PN_OVER_LID, WEBHOOK_CB_ENABLED, WEBHOOK_CB_FAILURE_THRESHOLD, WEBHOOK_CB_OPEN_MS, WEBHOOK_CB_FAILURE_TTL_MS, WEBHOOK_CB_REQUEUE_DELAY_MS, WEBHOOK_CB_LOCAL_CLEANUP_INTERVAL_MS } from '../defaults'
import { jidNormalizedUser, isPnUser } from '@whiskeysockets/baileys'
import { addToBlacklist, isInBlacklist } from './blacklist'
import { PublishOption } from '../amqp'
import { isWebhookCircuitOpen, openWebhookCircuit, closeWebhookCircuit, bumpWebhookCircuitFailure } from './redis'

class WebhookCircuitOpenError extends Error {
  public code = 'WEBHOOK_CB_OPEN'
  public delayMs: number
  constructor(message: string, delayMs: number) {
    super(message)
    this.delayMs = delayMs
  }
}

const isChatwootWebhook = (webhook: Webhook) => {
  const u1 = `${webhook?.url || ''}`.toLowerCase()
  const u2 = `${webhook?.urlAbsolute || ''}`.toLowerCase()
  const hasChatwoot = u1.includes('chatwoot') || u2.includes('chatwoot')
  const hasWhatsWebhook = u1.includes('/webhooks/whatsapp') || u2.includes('/webhooks/whatsapp')
  return hasChatwoot || hasWhatsWebhook
}

const mapStatusMediaTypeToCloud = (rawType?: string, mimeType?: string) => {
  const t = `${rawType || ''}`
  if (t === 'imageMessage' || t === 'image') return 'image'
  if (t === 'videoMessage' || t === 'video' || t === 'ptvMessage' || t === 'ptv') return 'video'
  if (t === 'audioMessage' || t === 'audio') return 'audio'
  if (t === 'documentMessage' || t === 'document') return 'document'
  if (t === 'stickerMessage' || t === 'sticker') return 'sticker'
  const m = `${mimeType || ''}`.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.includes('pdf') || m.startsWith('application/')) return 'document'
  return undefined
}

const adaptStatusReplyMediaForChatwoot = (message: any) => {
  try {
    const value = message?.entry?.[0]?.changes?.[0]?.value
    if (!Array.isArray(value?.messages) || !value.messages.length) return message
    const patched: any[] = []
    for (const original of value.messages) {
      patched.push(original)
      const contextStatus = original?.context?.status
      const media = contextStatus?.media
      const mediaUrl = `${media?.url || ''}`.trim()
      const originalType = `${original?.type || ''}`.trim()
      if (!mediaUrl || originalType !== 'text') continue
      const cloudType = mapStatusMediaTypeToCloud(contextStatus?.type, media?.mime_type)
      if (!cloudType) continue
      const mediaMessage: any = JSON.parse(JSON.stringify(original))
      const baseId = `${original?.id || contextStatus?.id || ''}`.trim()
      mediaMessage.id = baseId ? `${baseId}-status-media` : `${Date.now()}-status-media`
      mediaMessage.type = cloudType
      const replyText = `${original?.text?.body || ''}`.trim()
      const mediaPayload: any = {
        id: `${contextStatus?.id || mediaMessage.id || ''}`.trim(),
        url: mediaUrl,
      }
      if (replyText) mediaPayload.caption = replyText
      if (media?.mime_type) mediaPayload.mime_type = `${media.mime_type}`
      if (media?.file_name) mediaPayload.filename = `${media.file_name}`
      mediaMessage[cloudType] = mediaPayload
      try { delete mediaMessage.text } catch {}
      patched.push(mediaMessage)
    }
    value.messages = patched
  } catch (e) {
    logger.warn(e as any, 'Unable to adapt status reply media for Chatwoot')
  }
  return message
}
// Ajusta payload para schema Cloud API estrito (Typebot)
const normalizePayloadForTypebot = (payload: any, phone: string) => {
  try {
    const data = JSON.parse(JSON.stringify(payload))
    const value = data?.entry?.[0]?.changes?.[0]?.value
    if (value?.metadata) {
      const phoneWithPlus = phone.startsWith('+') ? phone : `+${phone}`
      value.metadata.display_phone_number = phoneWithPlus
      value.metadata.phone_number_id = phoneWithPlus
    }
    if (value?.messages && Array.isArray(value.messages)) {
      const allowedTypes = new Set(['text', 'image', 'video', 'audio', 'document', 'sticker', 'ptv'])
      value.messages = value.messages.map((m: any) => {
        const mm = { ...m }
        // Descartar mensagens sem tipo ou tipos nao suportados pelo schema Typebot (ex.: call).
        if (!mm.type || !allowedTypes.has(mm.type)) {
          logger.debug('TYPEBOT normalize: dropping unsupported message type %s', mm.type || '<none>')
          return null
        }
        const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker', 'ptv']
        for (const mt of mediaTypes) {
          if (mm[mt]) {
            const media = { ...mm[mt] }
            const rawId = `${media.id || ''}`
            const cleanUuid = rawId.includes('/') ? rawId.split('/').pop() : rawId
            // Preservar phone no id para poder resolver download: formata phone-uuid
            media.id = cleanUuid ? `${phone}-${cleanUuid}` : (rawId || '')
            if (media.filename !== undefined) delete media.filename
            if (media.url !== undefined) delete media.url
            if (media.sha256 !== undefined) delete media.sha256
            if (media.caption === null) delete media.caption
            // sha256 deve ser string
            try {
              const v = media.sha256
              if (v && typeof v !== 'string') {
                media.sha256 = Buffer.isBuffer(v) ? v.toString('base64') : Buffer.from(v).toString('base64')
              }
            } catch { media.sha256 = undefined }
            mm[mt] = media
          }
        }
        // Forçar id de mensagem apenas como uuid (sem phone/)
        try {
          const raw = `${mm.id || ''}`
          if (raw.includes('/')) mm.id = raw.split('/').pop()
        } catch {}
        return mm
      }).filter(Boolean)
      if (value.messages.length === 0) {
        logger.debug('TYPEBOT normalize: dropping payload without supported messages')
        return undefined
      }
    }
    if (value?.contacts && Array.isArray(value.contacts)) {
      value.contacts = value.contacts.map((c: any) => {
        const cc = { ...c }
        try {
          if (cc.profile && cc.profile.picture !== undefined) {
            delete cc.profile.picture
          }
        } catch {}
        return cc
      })
    }
    if (value?.statuses && Array.isArray(value.statuses)) {
      value.statuses = value.statuses.map((s: any) => {
        const ss = { ...s }
        // id apenas o uuid (sem phone/)
        try {
          const raw = `${ss.id || ''}`
          if (raw.includes('/')) ss.id = raw.split('/').pop()
        } catch {}
        // timestamp como string
        try {
          if (typeof ss.timestamp !== 'string') ss.timestamp = `${ss.timestamp || ''}`
        } catch {}
        // recipient_id somente dígitos
        try {
          if (typeof ss.recipient_id === 'string') ss.recipient_id = ss.recipient_id.replace(/\D/g, '')
        } catch {}
        // errors: manter apenas code/title/message/error_data
        try {
          if (Array.isArray(ss.errors)) {
            ss.errors = ss.errors.map((e: any) => {
              const out: any = {}
              if (typeof e?.code !== 'undefined') out.code = e.code
              if (typeof e?.title !== 'undefined') out.title = e.title
              if (typeof e?.message !== 'undefined') out.message = e.message
              const details =
                (e?.error_data && e.error_data.details) ||
                e?.message ||
                e?.title ||
                ''
              if (details) {
                out.error_data = { details: `${details}` }
              }
              return out
            })
          }
        } catch {}
        return ss
      })
    }
    return data
  } catch (e) {
    logger.warn(e as any, 'Unable to normalize payload for typebot (session=%s)', phone)
    return payload
  }
}

export class OutgoingCloudApi implements Outgoing {
  private getConfig: getConfig
  private isInBlacklist: isInBlacklist
  private addToBlacklist: addToBlacklist

  constructor(getConfig: getConfig, isInBlacklist: isInBlacklist, addToBlacklist: addToBlacklist) {
    this.getConfig = getConfig
    this.isInBlacklist = isInBlacklist
    this.addToBlacklist = addToBlacklist
  }

  public async formatAndSend(phone: string, to: string, message: object) {
    const data = completeCloudApiWebHook(phone, to, message)
    return this.send(phone, data)
  }

  public async send(phone: string, message: object) {
    const config = await this.getConfig(phone)
    if (WEBHOOK_ASYNC) {
      config.webhooks.forEach((w) => {
        this.sendHttp(phone, w, message).catch((error) => {
          logger.error('WEBHOOK_ASYNC: send failed (phone=%s webhook=%s)', phone, w?.id || '<none>')
          logger.error(error)
        })
      })
      return
    }
    const promises = config.webhooks.map(async (w) => this.sendHttp(phone, w, message))
    await Promise.all(promises)
  }

  public async sendHttp(phone: string, webhook: Webhook, message: any, _options: Partial<PublishOption> = {}) {
    if (!isWebhookEnabled(webhook)) {
      logger.info(`Session phone %s webhook %s configured as disabled`, phone, webhook?.id || '<none>')
      return
    }
    const cbEnabled = !!WEBHOOK_CB_ENABLED && WEBHOOK_CB_FAILURE_THRESHOLD > 0 && WEBHOOK_CB_OPEN_MS > 0
    const cbId = (webhook && (webhook.id || webhook.url || webhook.urlAbsolute)) ? `${webhook.id || webhook.url || webhook.urlAbsolute}` : 'default'
    const cbKey = `${phone}:${cbId}`
    const now = Date.now()
    if (cbEnabled) {
      let open = false
      try {
        open = process.env.REDIS_URL
          ? await isWebhookCircuitOpen(phone, cbId)
          : isCircuitOpenLocal(cbKey, now)
      } catch {}
      if (open) {
        logger.warn('WEBHOOK_CB open: skipping send (phone=%s webhook=%s)', phone, cbId)
        throw new WebhookCircuitOpenError(`WEBHOOK_CB open for ${cbId}`, this.cbRequeueDelayMs())
      }
    }
    // Clone to avoid cross-webhook mutations
    try { message = JSON.parse(JSON.stringify(message)) } catch {}
    const destinyPhone = await this.isInBlacklist(phone, webhook.id, message)
    if (destinyPhone) {
      logger.info(`Session phone %s webhook %s and destiny phone %s are in blacklist`, phone, webhook.id, destinyPhone)
      return
    }
    if (!webhook.sendGroupMessages && isGroupMessage(message)) {
      logger.info(`Session phone %s webhook %s configured to not send group message for this webhook`, phone, webhook.id)
      return
    }
    if (!webhook.sendNewsletterMessages && isNewsletterMessage(message)) {
      logger.info(`Session phone %s webhook %s configured to not send newsletter message for this webhook`, phone, webhook.id)
      return
    }
    if (isOutgoingMessage(message)) {
      if (webhook.addToBlackListOnOutgoingMessageWithTtl) {
        logger.info(`Session phone %s webhook %s configured to add to blacklist when outgoing message for this webhook`, phone, webhook.id)
        const to = extractDestinyPhone(message, false)
        await this.addToBlacklist(phone, webhook.id, to, webhook.addToBlackListOnOutgoingMessageWithTtl!)
      }
      if (!webhook.sendOutgoingMessages) {
        logger.info(`Session phone %s webhook %s configured to not send outgoing message for this webhook`, phone, webhook.id)
        return
      }
    }
    if (!webhook.sendUpdateMessages && isUpdateMessage(message)) {
      logger.info(`Session phone %s webhook %s configured to not send update message for this webhook`, phone, webhook.id)
      return
    }
    if (!webhook.sendIncomingMessages) {
      logger.info(`Session phone %s webhook %s configured to not send incoming message for this webhook`, phone, webhook.id)
      return
    }
    if (isChatwootWebhook(webhook)) {
      message = adaptStatusReplyMediaForChatwoot(message)
    }
    const v: any = (message as any)?.entry?.[0]?.changes?.[0]?.value || {}
    // Keep Cloud API phone fields phone-only. LID/BSUID must travel in user_id/from_user_id.
    try {
      const phoneOnly = (value?: string): string => {
        const raw = `${value || ''}`.trim()
        if (!raw || raw.includes('@lid')) return ''
        const digits = raw.replace(/\D/g, '')
        return digits ? raw : ''
      }
      if (Array.isArray(v.contacts) && v.contacts.length > 0) {
        const c = v.contacts[0] || {}
        const raw = (c.wa_id || '').toString().trim()
        if (raw.includes('@lid')) {
          c.wa_id = ''
        }
        if (!c.wa_id) {
          let fallback: string | undefined
          try {
            if (Array.isArray(v.statuses) && v.statuses[0]?.recipient_id) {
              fallback = phoneOnly(`${v.statuses[0].recipient_id}`)
            }
          } catch {}
          try {
            if (!fallback && Array.isArray(v.messages) && v.messages[0]?.from) {
              fallback = phoneOnly(`${v.messages[0].from}`)
            }
          } catch {}
          if (fallback && fallback.toString().trim()) {
            c.wa_id = fallback.toString().trim()
          }
        }
      }
    } catch {}
    // Sanitize phone fields ONLY right before sending (do not affect routing decisions)
    try { normalizeWebhookValueIds(v) } catch {}
    // Mapping preferences are applied below only where a field is not a Cloud API phone field.
    // wa_id/from remain phone-only; LID/BSUID belongs in user_id/from_user_id.
    if (!WEBHOOK_PREFER_PN_OVER_LID) try {
      const config = await this.getConfig(phone)
      const store = await config.getStore(phone, config)
      const ds: any = store?.dataStore
      const v: any = (message as any)?.entry?.[0]?.changes?.[0]?.value || {}
      const toLidIfMapped = async (x?: string): Promise<string> => {
        const val = `${x || ''}`
        if (!val) return val
        if (val.includes('@')) return val
        // digits-only -> try PN JID mapping to LID
        const pnJid = `${val.replace(/\D/g, '')}@s.whatsapp.net`
        try {
          const lid = await ds?.getLidForPn?.(phone, pnJid)
          if (typeof lid === 'string' && lid.endsWith('@lid')) return lid
        } catch {}
        return val
      }
      // wa_id/from are Cloud API phone fields now; do not convert them to @lid.
      if (Array.isArray(v.statuses)) {
        for (const s of v.statuses) {
          if (s && typeof s.recipient_id === 'string') s.recipient_id = await toLidIfMapped(s.recipient_id)
        }
      }
    } catch {} 
    // Optionally convert @lid to PN when explicitly enabled
    if (WEBHOOK_PREFER_PN_OVER_LID) {
      try {
        const config = await this.getConfig(phone)
        const store = await config.getStore(phone, config)
        const ds: any = store?.dataStore
        const v: any = (message as any)?.entry?.[0]?.changes?.[0]?.value || {}
        const toPnIfMapped = async (x?: string): Promise<string> => {
          let val = `${x || ''}`
          if (!val) return val
          if (val.includes('@g.us')) return val
          // If LID and we have a PN mapping, prefer PN digits; otherwise keep @lid
          if (val.includes('@lid')) {
            // sanitize device suffix (e.g., 1134:18@lid -> 1134@lid) to maximize cache hit
            let base = val
            try { base = formatJid(val) } catch {}
            try {
              const mapped = (await ds?.getPnForLid?.(phone, base)) || (await ds?.getPnForLid?.(phone, val))
              // Somente converte quando o mapeamento aponta para um PN JID vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡lido
              if (mapped && isPnUser(mapped)) { const digits = jidToPhoneNumber(mapped, '') .replace('\+',''); if (isValidPhoneNumber(digits, true)) return digits }
            } catch {}
            // TambÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â©m tentar via contact-info (pn jÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡ resolvido anteriormente)
            try {
              const info = await ds?.getContactInfo?.(base)
              const pnDigits = `${info?.pn || ''}`.replace(/\D/g, '')
              if (pnDigits) return pnDigits
            } catch {}
            // Fallback: normalizar via jidNormalizedUser quando não houver mapping/contact-info
            try {
              const norm = jidNormalizedUser(base)
              if (norm && isPnUser(norm)) {
                const digits = jidToPhoneNumber(norm, '').replace('+','')
                if (isValidPhoneNumber(digits, true)) return digits
              }
            } catch {}
            // Sem mapping nem contact-info confiÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡vel: preserva @lid (nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o gerar dÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­gitos nus)
            return val
            // Fallback: tentar normalizar o LID via Baileys
            try {
              const norm = jidNormalizedUser(base)
              if (norm && isPnUser(norm)) return jidToPhoneNumber(norm, '')
            } catch {}
            return val
          }
          // If PN JID, convert to digits-only PN
          try {
            if (val.includes('@s.whatsapp.net')) return jidToPhoneNumber(val, '')
          } catch {}
          return val
        }
        if (Array.isArray(v.contacts)) {
          for (const c of v.contacts) {
            if (c && typeof c.wa_id === 'string') c.wa_id = await toPnIfMapped(c.wa_id)
          }
        }
        if (Array.isArray(v.messages)) {
          for (const m of v.messages) {
            if (m && typeof m.from === 'string') m.from = await toPnIfMapped(m.from)
          }
        }
        if (Array.isArray(v.statuses)) {
          for (const s of v.statuses) {
            if (s && typeof s.recipient_id === 'string') s.recipient_id = await toPnIfMapped(s.recipient_id)
          }
        }
      } catch {}
    }
    // Enriquecimento do cache de contatos: para cada contato/from, tente preencher pnJid, lidJid e pn
    try {
      const config = await this.getConfig(phone)
      const store = await config.getStore(phone, config)
      const ds: any = store?.dataStore
      const v: any = (message as any)?.entry?.[0]?.changes?.[0]?.value || {}
      const cleanJid = (j?: string) => {
        if (!j) return ''
        try { return formatJid(j) } catch { return j }
      }
      const ensurePnDigits = (pnJid?: string) => {
        try { return pnJid ? jidToRawPhoneNumber(pnJid, '').replace('+','') : '' } catch { return '' }
      }
      const enrichOne = async (id?: string, name?: string) => {
        const raw = `${id || ''}`
        if (!raw) return
        let pnJid = ''
        let lidJid = ''
        if (raw.includes('@')) {
          const jid = cleanJid(raw)
          if (jid.toLowerCase().endsWith('@lid')) {
            lidJid = jid
            try { const mapped = await ds?.getPnForLid?.(phone, jid); if (mapped) pnJid = cleanJid(mapped) } catch {}
          } else {
            pnJid = jid
            try { const mapped = await ds?.getLidForPn?.(phone, jid); if (mapped) lidJid = cleanJid(mapped) } catch {}
          }
        } else {
          // digits-only -> assumir PN JID para lookup
          pnJid = `${raw.replace(/\D/g,'')}@s.whatsapp.net`
          try { const mapped = await ds?.getLidForPn?.(phone, pnJid); if (mapped) lidJid = cleanJid(mapped) } catch {}
        }
        if (!pnJid && lidJid) {
          // tentar derivar PN JID a partir de LID normalizado
          try { const mapped = await ds?.getPnForLid?.(phone, lidJid); if (mapped) pnJid = cleanJid(mapped) } catch {}
        }
        if (!pnJid && !lidJid) return
        const pn = ensurePnDigits(pnJid)
        const info: any = { pnJid: pnJid || undefined, lidJid: lidJid || undefined, pn: pn || undefined }
        if (name && typeof name === 'string' && name.trim()) info.name = name
        try { if (pnJid) await ds?.setContactInfo?.(pnJid, info) } catch {}
        try { if (lidJid) await ds?.setContactInfo?.(lidJid, info) } catch {}
      }
      if (Array.isArray(v.contacts)) {
        for (const c of v.contacts) {
          const name = (c?.profile?.name || '').toString()
          await enrichOne(c?.wa_id, name)
        }
      }
      if (Array.isArray(v.messages)) {
        for (const m of v.messages) {
          await enrichOne(m?.from, undefined)
        }
      }
    } catch {}
    // wa_id/from are intentionally left blank when no valid phone is available.
    // Aplicar schema Typebot (Cloud API estrito) se habilitado no webhook
    if (webhook.typebot) {
      message = normalizePayloadForTypebot(message, phone)
      if (!message) return
    }
    const body = JSON.stringify(message)
    const headers = {
      'Content-Type': 'application/json; charset=utf-8'
    }
    if (webhook.header && webhook.token) {
      headers[webhook.header] = webhook.token
    }
    // Garantir que o endpoint do Chatwoot use o mesmo phone da sessÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o (metadata.phone_number_id)
    let url = webhook.urlAbsolute || `${webhook.url}/${phone}`
    try {
      const m = url.match(/\/webhooks\/whatsapp\/(\d+)$/)
      if (m && m[1] !== `${phone}`) {
        // Reescreve para URL base + phone
        url = `${webhook.url}/${phone}`
      }
    } catch {}
    try {
      const v: any = (message as any)?.entry?.[0]?.changes?.[0]?.value || {}
      const m = Array.isArray(v.messages) ? v.messages[0] : undefined
      if (m?.type === 'interactive') {
        logger.info(
          'INTERACTIVE webhook: id=%s to=%s subtype=%s url=%s',
          m?.id || '<none>',
          m?.to || '<none>',
          m?.interactive?.type || '<none>',
          url,
        )
      }
    } catch {}
    logger.debug(`Send url ${url} with headers %s and body %s`, JSON.stringify(headers), body)
    let response: Response
    try {
      const options: RequestInit = { method: 'POST', body, headers }
      if (webhook.timeoutMs) {
        options.signal = AbortSignal.timeout(webhook.timeoutMs)
      }
      response = await fetch(url, options)
    } catch (error) {
      logger.error('Error on send to url %s with headers %s and body %s', url, JSON.stringify(headers), body)
      logger.error(error)
      if (cbEnabled) {
        const opened = await this.handleCircuitFailure(phone, cbId, cbKey, error as any)
        if (opened) {
          throw new WebhookCircuitOpenError(`WEBHOOK_CB opened for ${cbId}`, this.cbRequeueDelayMs())
        }
      }
      throw error
    }
    logger.debug('Response: %s', response?.status)
    if (!response?.ok) {
      const errText = await response?.text()
      const err = new Error(`Webhook response ${response?.status} ${response?.statusText}: ${errText}`)
      if (cbEnabled) {
        const opened = await this.handleCircuitFailure(phone, cbId, cbKey, err)
        if (opened) {
          throw new WebhookCircuitOpenError(`WEBHOOK_CB opened for ${cbId}`, this.cbRequeueDelayMs())
        }
      }
      throw err
    }
    if (cbEnabled) {
      try {
        if (process.env.REDIS_URL) {
          await closeWebhookCircuit(phone, cbId)
        } else {
          resetCircuitLocal(cbKey)
        }
      } catch {}
    }
  }

  private cbRequeueDelayMs() {
    return WEBHOOK_CB_REQUEUE_DELAY_MS || WEBHOOK_CB_OPEN_MS || 120000
  }

  private async handleCircuitFailure(phone: string, cbId: string, cbKey: string, error: any): Promise<boolean> {
    try {
      const threshold = WEBHOOK_CB_FAILURE_THRESHOLD || 1
      const openMs = WEBHOOK_CB_OPEN_MS || 120000
      const ttlMs = WEBHOOK_CB_FAILURE_TTL_MS || openMs
      const count = process.env.REDIS_URL
        ? await bumpWebhookCircuitFailure(phone, cbId, ttlMs)
        : bumpCircuitFailureLocal(cbKey, ttlMs)
      if (count >= threshold) {
        if (process.env.REDIS_URL) {
          await openWebhookCircuit(phone, cbId, openMs)
        } else {
          openCircuitLocal(cbKey, openMs)
        }
        logger.warn('WEBHOOK_CB opened (phone=%s webhook=%s count=%s openMs=%s)', phone, cbId, count, openMs)
        return true
      } else {
        logger.warn('WEBHOOK_CB failure (phone=%s webhook=%s count=%s/%s)', phone, cbId, count, threshold)
        try { logger.warn(error as any, 'WEBHOOK_CB send failed (phone=%s webhook=%s)', phone, cbId) } catch {}
        return false
      }
    } catch (e) {
      logger.warn(e as any, 'WEBHOOK_CB failure handler error (phone=%s webhook=%s)', phone, cbId)
      try { logger.warn(error as any, 'WEBHOOK_CB original error (phone=%s webhook=%s)', phone, cbId) } catch {}
      // If the CB handler fails, fall back to the original error path (no circuit open)
      return false
    }
  }
}

const cbOpenUntil: Map<string, number> = new Map()
const cbFailState: Map<string, { count: number; exp: number }> = new Map()
let cbLastCleanup = 0
const CB_CLEANUP_INTERVAL_MS = WEBHOOK_CB_LOCAL_CLEANUP_INTERVAL_MS || 60 * 60 * 1000

const isCircuitOpenLocal = (key: string, now: number) => {
  maybeCleanupLocalCircuit(now)
  const until = cbOpenUntil.get(key)
  if (!until) return false
  if (now >= until) {
    cbOpenUntil.delete(key)
    return false
  }
  return true
}

const openCircuitLocal = (key: string, openMs: number) => {
  maybeCleanupLocalCircuit(Date.now())
  cbOpenUntil.set(key, Date.now() + Math.max(1, openMs || 0))
}

const resetCircuitLocal = (key: string) => {
  maybeCleanupLocalCircuit(Date.now())
  cbOpenUntil.delete(key)
  cbFailState.delete(key)
}

const bumpCircuitFailureLocal = (key: string, ttlMs: number): number => {
  const now = Date.now()
  maybeCleanupLocalCircuit(now)
  const ttl = Math.max(1, ttlMs || 0)
  const current = cbFailState.get(key)
  if (!current || now >= current.exp) {
    cbFailState.set(key, { count: 1, exp: now + ttl })
    return 1
  }
  current.count += 1
  return current.count
}

const maybeCleanupLocalCircuit = (now: number) => {
  if (now - cbLastCleanup < CB_CLEANUP_INTERVAL_MS) return
  cbLastCleanup = now
  for (const [key, until] of cbOpenUntil) {
    if (now >= until) cbOpenUntil.delete(key)
  }
  for (const [key, st] of cbFailState) {
    if (now >= st.exp) cbFailState.delete(key)
  }
}
