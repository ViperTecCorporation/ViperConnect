/*
curl -X  POST \
 'https://graph.facebook.com/v13.0/FROM_PHONE_NUMBER_ID/messages' \
 -H 'Authorization: Bearer ACCESS_TOKEN' \
 -d '{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "PHONE_NUMBER",
  "type": "text",
  "text": { // the text object
    "preview_url": false,
    "body": "MESSAGE_CONTENT"
  }
}'

{
    "messaging_product": "whatsapp",
    "contacts": [
        {
            "input": "16505076520",
            "wa_id": "16505076520"
        }
    ],
    "messages": [
        {
            "id": "wamid.HBgLMTY1MDUwNzY1MjAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA"
        }
    ]
}
*/
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#successful-response
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#text-messages
// https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read

import { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { Response as ResponseUno } from '../services/response'
import { Incoming } from '../services/incoming'
import { Outgoing } from '../services/outgoing'
import logger from '../services/logger'
import { phoneNumberToJid } from '../services/transformer'
import { allowSend } from '../services/rate_limit'
import { CONTACT_SYNC_SCAN_COUNT } from '../defaults'
import { BASE_KEY, getRedis } from '../services/redis'
import { resolveSessionPhoneByMetaId } from '../services/meta_alias'
import { sendGraphError } from '../services/graph_error'

export class MessagesController {
  protected endpoint = 'messages'
  private incoming: Incoming
  private outgoing: Outgoing

  constructor(incoming: Incoming, outgoing: Outgoing) {
    this.incoming = incoming
    this.outgoing = outgoing
  }

  private normalizeBaileysRawPayload(payload: any) {
    if (
      payload &&
      !payload.type &&
      typeof payload.jid === 'string' &&
      payload.jid.trim() &&
      payload.message &&
      typeof payload.message === 'object'
    ) {
      return {
        ...payload,
        to: payload.to || payload.jid,
        type: 'baileys',
      }
    }
    return payload
  }

  private async loadStatusRecipientsFromContactInfo(phone: string): Promise<string[]> {
    const prefix = `${BASE_KEY}contact-info:${phone}:`
    const pattern = `${prefix}*`
    const count = Math.max(10, CONTACT_SYNC_SCAN_COUNT || 500)
    const out: string[] = []
    try {
      const redis: any = await getRedis()
      let cursor = '0'
      do {
        const res: any = await redis.scan(cursor, { MATCH: pattern, COUNT: count })
        cursor = (typeof res.cursor !== 'undefined') ? `${res.cursor}` : `${res[0]}`
        const keys: string[] = Array.isArray(res.keys) ? res.keys : (res[1] || [])
        for (const key of keys || []) {
          if (!key.startsWith(prefix)) continue
          const jid = key.substring(prefix.length)
          if (!/^\d+@s\.whatsapp\.net$/.test(jid)) continue
          const pn = jid.split('@')[0]
          if (pn) out.push(pn)
        }
      } while (cursor !== '0')
    } catch (e) {
      logger.warn(e as any, 'Failed to load contact-info recipients for %s', phone)
      return []
    }
    return Array.from(new Set(out))
  }

  public async index(req: Request, res: Response) {
    logger.debug('%s method %s', this.endpoint, req.method)
    logger.debug('%s headers %s', this.endpoint, JSON.stringify(req.headers))
    logger.debug('%s params %s', this.endpoint, JSON.stringify(req.params))
    logger.debug('%s body %s', this.endpoint, JSON.stringify(req.body))
    const phone = `${req.params.phone || req.params.phone_number_id || ''}`
    const sessionPhone = await resolveSessionPhoneByMetaId(phone)
    const payload: any = this.normalizeBaileysRawPayload(req.body)
    const requestIdHeader = req.headers['x-request-id'] || req.headers['x-correlation-id']
    const requestId = `${Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader || randomUUID()}`
    payload._requestId = requestId
    try {
      const options: any = { endpoint: this.endpoint }
      options.requestId = requestId
      res.setHeader('x-request-id', requestId)
      logger.info('messages requestId=%s phone=%s to=%s type=%s', requestId, sessionPhone, `${payload?.to || ''}`, `${payload?.type || ''}`)
      const bodyOptions = (payload && payload.options) || {}
      const rawTo = `${payload?.to || ''}`.trim().toLowerCase()
      const rawType = `${payload?.type || ''}`.trim().toLowerCase()
      const rawStatusList = typeof payload?.statusJidList !== 'undefined' ? payload.statusJidList : bodyOptions.statusJidList
      const isBlankStatusList = (value: any) => {
        if (value === null || typeof value === 'undefined') return true
        if (Array.isArray(value)) {
          return value.map((v) => `${v ?? ''}`.trim()).filter((v) => !!v).length === 0
        }
        if (typeof value === 'string') return value.trim().length === 0
        return false
      }
      if (rawTo === 'status@broadcast' && (rawType === 'image' || rawType === 'video')) {
        if (isBlankStatusList(rawStatusList)) {
          const statusRecipients = await this.loadStatusRecipientsFromContactInfo(sessionPhone)
          payload.statusJidList = statusRecipients
          logger.info('Status@broadcast auto statusJidList for %s: %d recipient(s)', sessionPhone, statusRecipients.length)
        }
      }
      // Allow passing Baileys options via body (e.g., for Stories/Broadcast)
      // Accept both top-level and nested under `options`
      const statusJidList = payload.statusJidList || bodyOptions.statusJidList
      if (Array.isArray(statusJidList)) {
        // Accept plain numbers or full JIDs; normalize to JIDs
        options.statusJidList = statusJidList
          .map((v: unknown) => `${v ?? ''}`.trim())
          .filter((v: string) => !!v)
          .map((v: string) => phoneNumberToJid(v))
      }
      if (typeof payload.broadcast !== 'undefined') {
        options.broadcast = payload.broadcast
      } else if (typeof bodyOptions.broadcast !== 'undefined') {
        options.broadcast = bodyOptions.broadcast
      }
      if (typeof payload.backgroundColor !== 'undefined') {
        options.backgroundColor = payload.backgroundColor
      } else if (typeof bodyOptions.backgroundColor !== 'undefined') {
        options.backgroundColor = bodyOptions.backgroundColor
      }
      if (typeof payload.font !== 'undefined') {
        options.font = payload.font
      } else if (typeof bodyOptions.font !== 'undefined') {
        options.font = bodyOptions.font
      }
      // Anti-spam: enforce per-session and per-destination minute limits
      const toValue = `${payload?.to || ''}`.trim()
      const isUsernameTo = !!toValue && !toValue.includes('@s.whatsapp.net') && !toValue.includes('@lid') && !toValue.includes('@g.us') && !/^\+?\d+$/.test(toValue)
      const to = toValue ? (isUsernameTo ? `username:${toValue.replace(/^@/, '').toLowerCase()}` : phoneNumberToJid(toValue)) : ''
      const decision = await allowSend(sessionPhone, to || '')
      if (!decision.allowed) {
        // Não retorna 429: agenda o envio via fila com atraso
        const retrySec = decision.retryAfterSec || 60
        options.delay = retrySec * 1000
        logger.warn('Rate limited %s -> %s; scheduling in %ss', sessionPhone, to, retrySec)
      }
      const response: ResponseUno = await this.incoming.send(sessionPhone, payload, options)
      logger.debug('%s response %s', this.endpoint, JSON.stringify(response.ok))
      await res.status(200).json(response.ok)
      if (response.error) {
        logger.debug('%s return status %s', this.endpoint, JSON.stringify(response.error))
        await this.outgoing.send(sessionPhone, response.error)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      try { res.setHeader('x-request-id', requestId) } catch {}
      return sendGraphError(res, 400, e.message, { code: 131000, type: 'GraphMethodException' })
    }
  }

  public async recoverDelivery(req: Request, res: Response) {
    logger.debug('%s recover_delivery method %s', this.endpoint, req.method)
    logger.debug('%s recover_delivery params %s', this.endpoint, JSON.stringify(req.params))
    logger.debug('%s recover_delivery body %s', this.endpoint, JSON.stringify(req.body))
    const phone = `${req.params.phone || req.params.phone_number_id || ''}`
    const sessionPhone = await resolveSessionPhoneByMetaId(phone)
    const requestIdHeader = req.headers['x-request-id'] || req.headers['x-correlation-id']
    const requestId = `${Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader || randomUUID()}`
    const payload: any = this.normalizeBaileysRawPayload({
      ...(req.body || {}),
      message_id: req.params.messageId || req.body?.message_id || req.body?.messageId || req.body?.id,
    })
    payload._requestId = requestId
    const options: any = {
      endpoint: this.endpoint,
      requestId,
      forceDeliveryRecovery: true,
      forceSessionRefresh: true,
      forceDeviceList: payload?.force_device_list !== false && payload?.forceDeviceList !== false,
      useUserDevicesCache: false,
    }
    try {
      res.setHeader('x-request-id', requestId)
      if (typeof this.incoming.recoverDelivery !== 'function') {
        return sendGraphError(res, 400, 'delivery_recovery_not_supported', { code: 131000, type: 'GraphMethodException' })
      }
      logger.warn(
        'messages recover_delivery requestId=%s phone=%s to=%s messageId=%s type=%s',
        requestId,
        sessionPhone,
        `${payload?.to || ''}`,
        `${payload?.message_id || ''}`,
        `${payload?.type || ''}`,
      )
      const response = await this.incoming.recoverDelivery(sessionPhone, payload, options)
      await res.status(200).json(response.ok)
      if (response.error) {
        await this.outgoing.send(sessionPhone, response.error)
      }
    } catch (e: any) {
      try { res.setHeader('x-request-id', requestId) } catch {}
      return sendGraphError(res, 400, e.message, { code: 131000, type: 'GraphMethodException' })
    }
  }
}
