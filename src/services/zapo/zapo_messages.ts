/* eslint-disable @typescript-eslint/no-explicit-any */
import type { WaClient, WaMessageKey, WaSendMessageContent, WaSendMessageOptions, WaStoreSession } from 'zapo-js'
import { v1 as uuid } from 'uuid'
import type { DataStore } from '../data_store'
import type { Response } from '../response'
import { SendError } from '../send_error'
import { phoneNumberToJid } from '../transformer/jid'
import { ZapoIdentity } from './zapo_identity'
import { toZapoMessageContent } from './zapo_message_mapper'
import { resolveProviderMessageId } from '../message_id_map'

type ZapoMessagesOptions = {
  customMessageCharactersFunction?: (message: string) => string
  composingMessage?: boolean
  store?: WaStoreSession
  phone?: string
  bindTemplate?: (payload: any) => Promise<any>
}

const toJid = (value: string) => {
  const target = `${value || ''}`.trim()
  if (!target) throw new SendError(400, 'message_recipient_required')
  if (target.includes('@')) return target
  return phoneNumberToJid(target)
}

export class ZapoMessages {
  private readonly identity?: ZapoIdentity
  private readonly customMessageCharactersFunction: (message: string) => string
  private readonly composingMessage: boolean
  private readonly bindTemplate?: (payload: any) => Promise<any>

  constructor(
    private readonly client: WaClient,
    private readonly dataStore: DataStore,
    options: ZapoMessagesOptions = {},
  ) {
    this.customMessageCharactersFunction = options.customMessageCharactersFunction || ((message) => message)
    this.composingMessage = options.composingMessage || false
    this.bindTemplate = options.bindTemplate
    if (options.store) this.identity = new ZapoIdentity(client, options.store, options.phone || '')
  }

  private async expandTemplate(payload: any) {
    if (`${payload?.type || ''}` !== 'template') return payload
    if (!this.bindTemplate) throw new SendError(400, 'zapo_template_binder_unavailable')
    const bound = await this.bindTemplate(payload)
    if (typeof bound?.text === 'string') return { ...payload, type: 'text', text: { body: bound.text } }
    if (bound?.nativeCarousel) {
      const carousel = bound.nativeCarousel
      return {
        ...payload,
        type: 'interactive',
        interactive: {
          type: 'carousel',
          body: carousel.text ? { text: carousel.text } : undefined,
          action: {
            carousel: {
              cards: (carousel.cards || []).map((card: any) => ({
                header: card.image
                  ? { type: 'image', image: { link: card.image.url || card.image } }
                  : (card.video ? { type: 'video', video: { link: card.video.url || card.video } } : undefined),
                body: card.body ? { text: card.body } : undefined,
                footer: card.footer ? { text: card.footer } : undefined,
                action: { buttons: card.buttons || [] },
              })),
            },
          },
        },
      }
    }
    throw new SendError(400, 'unsupported_zapo_template_result')
  }

  private async canonicalJid(value: string): Promise<string> {
    return this.identity ? this.identity.resolve(value) : toJid(value)
  }

  private async canonicalJids(values: readonly string[]): Promise<string[]> {
    const resolved = this.identity
      ? await this.identity.resolveMany(values)
      : await Promise.all(values.map((value) => this.canonicalJid(value)))
    return Array.from(new Set(resolved))
  }

  private async resolveKey(messageId: string): Promise<WaMessageKey> {
    const providerId = await resolveProviderMessageId(this.dataStore, messageId)
    const key = await this.dataStore.loadKey(providerId || messageId)
    if (!key?.id || !key.remoteJid) throw new SendError(404, `message_not_found: ${messageId}`)
    return {
      id: providerId || key.id,
      remoteJid: key.remoteJid,
      fromMe: !!key.fromMe,
      ...(key.participant ? { participant: key.participant } : {}),
    }
  }

  async updateStatus(payload: any): Promise<Response> {
    const status = `${payload?.status || ''}`
    const messageId = `${payload?.message_id || payload?.messageId || ''}`
    if (!['sent', 'delivered', 'failed', 'progress', 'read', 'deleted'].includes(status)) {
      throw new SendError(400, `unknown_message_status: ${status}`)
    }
    if (status === 'read' || status === 'deleted') {
      const key = await this.resolveKey(messageId)
      if (status === 'read') await this.client.message.sendReceipt(key.remoteJid, key.id, { type: 'read' })
      else await this.client.message.send(key.remoteJid, { type: 'revoke', target: key })
    }
    await this.dataStore.setStatus(messageId, status as never)
    return { ok: { success: true } }
  }

  async recoverDelivery(payload: any, baseOptions: Record<string, unknown> = {}): Promise<Response> {
    const messageId = `${payload?.message_id || payload?.messageId || payload?.id || ''}`.trim()
    if (!messageId) throw new SendError(400, 'delivery_recovery_message_id_required')
    const providerId = `${await resolveProviderMessageId(this.dataStore, messageId) || ''}`.trim() || messageId
    const key = await this.dataStore.loadKey(providerId) || await this.dataStore.loadKey(messageId)
    const targetRaw = `${payload?.to || key?.remoteJid || ''}`.trim()
    if (!targetRaw) throw new SendError(404, `delivery_recovery_target_not_found: ${messageId}`)
    const target = await this.canonicalJid(targetRaw)

    let content: WaSendMessageContent | undefined
    let mappedOptions: Record<string, unknown> = {}
    if (payload?.type) {
      const mapped = await toZapoMessageContent(this.client, payload, this.customMessageCharactersFunction)
      content = mapped.content
      mappedOptions = mapped.options
    } else {
      const stored: any = await this.dataStore.loadMessage(key?.remoteJid || target, providerId)
        || await this.dataStore.loadMessage(target, messageId)
      content = stored?.message
    }
    if (!content) throw new SendError(404, `delivery_recovery_message_content_not_found: ${messageId}`)

    const result = await this.client.message.send(target, content, {
      ...baseOptions,
      ...mappedOptions,
      id: providerId,
    } as WaSendMessageOptions)
    await this.dataStore.setUnoId(result.id, messageId)
    const sentKey = { remoteJid: target, id: result.id, fromMe: true }
    await this.dataStore.setKey(result.id, sentKey)
    await this.dataStore.setMessage(target, { key: sentKey, message: content } as never)
    return {
      ok: {
        messaging_product: 'whatsapp',
        messages: [{ id: messageId }],
        recovery: {
          attempted: true,
          message_id: messageId,
          provider_id: providerId,
          sent_provider_id: result.id,
          target,
          provider_managed_sessions: true,
        },
      },
    }
  }

  async send(payload: any, baseOptions: Record<string, unknown> = {}): Promise<Response> {
    if (payload?.status) return this.updateStatus(payload)
    payload = await this.expandTemplate(payload)
    const type = `${payload?.type || ''}`
    let target = await this.canonicalJid(payload?.to)
    let content
    const requestedUnoId = `${baseOptions.unoMessageId || ''}`.trim()
    const options: Record<string, unknown> = { ...baseOptions }
    delete options.unoMessageId
    delete options.endpoint
    delete options.requestId

    if (type === 'reaction') {
      const messageId = `${payload?.reaction?.message_id || payload?.reaction?.messageId || payload?.message_id || payload?.context?.message_id || ''}`
      const key = await this.resolveKey(messageId)
      target = key.remoteJid
      content = { type: 'reaction' as const, emoji: `${payload?.reaction?.emoji ?? payload?.reaction?.text ?? ''}`, target: key }
    } else {
      const mapped = await toZapoMessageContent(this.client, payload, this.customMessageCharactersFunction)
      content = mapped.content
      Object.assign(options, mapped.options)
      if (Array.isArray(options.mentions)) {
        options.mentions = await this.canonicalJids(options.mentions.map((jid) => `${jid}`))
      }
      const contextId = type === 'message_edit'
        ? `${payload?.context?.message_id || payload?.edit?.message_id || payload?.message_id || ''}`
        : `${payload?.context?.message_id || payload?.context?.id || ''}`
      if (contextId) {
        const key = await this.resolveKey(contextId)
        target = key.remoteJid
        if (type === 'message_edit') options.editKey = key
        else options.quote = key
      }
      if (payload?.ttl !== undefined) options.expirationSeconds = Number(payload.ttl)
    }

    const result = target === 'status@broadcast'
      ? await this.sendStatus(content, options)
      : await this.sendDirect(target, content, options)
    const key = { remoteJid: target, id: result.id, fromMe: true }
    let unoId = requestedUnoId || `${await this.dataStore.loadUnoId(result.id) || ''}`.trim() || uuid()
    unoId = await this.dataStore.setUnoId(result.id, unoId) || unoId
    await this.dataStore.setKey(result.id, key)
    await this.dataStore.setKey(unoId, key)
    const input = `${payload?.to || ''}`
    const isUsername = /[a-z_]/i.test(input.replace(/@(s\.whatsapp\.net|lid)$/i, ''))
    const contact = {
      input,
      ...(!isUsername ? { wa_id: toJid(input).split('@')[0] } : {}),
      ...(target.endsWith('@lid') ? { user_id: target } : {}),
      ...(isUsername ? { username: input.replace(/^@/, '').toLowerCase() } : {}),
    }
    return {
      ok: {
        messaging_product: 'whatsapp',
        contacts: [contact],
        messages: [{ id: unoId }],
      },
    }
  }

  private async sendDirect(target: string, content: WaSendMessageContent, options: Record<string, unknown>) {
    if (!this.composingMessage) return this.client.message.send(target, content, options as WaSendMessageOptions)
    const contentType = typeof content === 'object' && content && 'type' in content
      ? `${(content as { type?: unknown }).type || ''}`
      : ''
    const media = contentType === 'audio' || contentType === 'ptt' ? 'audio' : undefined
    await this.client.presence.sendChatstate(target, { state: 'composing', ...(media ? { media } : {}) })
    try {
      return await this.client.message.send(target, content, options as WaSendMessageOptions)
    } finally {
      await this.client.presence.sendChatstate(target, { state: 'paused' })
    }
  }

  private async sendStatus(content: WaSendMessageContent, options: Record<string, unknown>) {
    const rawRecipients = Array.isArray(options.statusJidList)
      ? options.statusJidList.map((jid) => `${jid}`).filter(Boolean)
      : []
    const recipients = await this.canonicalJids(rawRecipients)
    if (!recipients.length) throw new SendError(400, 'status_recipients_required')
    const statusSetting = `${options.statusSetting || 'contacts'}` as 'contacts' | 'allowlist' | 'denylist' | 'close_friends'
    return this.client.status.send({ content, recipients, statusSetting })
  }
}
