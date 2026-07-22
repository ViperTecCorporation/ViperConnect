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
import logger from '../logger'

type ZapoMessagesOptions = {
  customMessageCharactersFunction?: (message: string) => string
  composingMessage?: boolean
  readOnReply?: boolean
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
  private readonly store?: WaStoreSession
  private readonly customMessageCharactersFunction: (message: string) => string
  private readonly composingMessage: boolean
  private readonly readOnReply: boolean
  private readonly phone: string
  private readonly bindTemplate?: (payload: any) => Promise<any>

  constructor(
    private readonly client: WaClient,
    private readonly dataStore: DataStore,
    options: ZapoMessagesOptions = {},
  ) {
    this.customMessageCharactersFunction = options.customMessageCharactersFunction || ((message) => message)
    this.composingMessage = options.composingMessage || false
    this.readOnReply = options.readOnReply || false
    this.phone = options.phone || ''
    this.bindTemplate = options.bindTemplate
    this.store = options.store
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

  private async buildEditTarget(payload: any) {
    const messageId = `${
      payload?.context?.message_id
      || payload?.context?.id
      || payload?.edit?.message_id
      || payload?.edit?.messageId
      || payload?.message_id
      || ''
    }`.trim()
    if (!messageId) throw new SendError(400, 'message_edit_message_id_required')

    const key = await this.resolveKey(messageId)
    if (!key.fromMe) throw new SendError(400, `message_edit_original_not_from_me: ${messageId}`)

    return {
      target: key.remoteJid,
      editKey: {
        id: key.id,
        ...(key.remoteJid.endsWith('@g.us') && key.participant
          ? { participant: key.participant }
          : {}),
      },
    }
  }

  private async buildPollVote(payload: any) {
    if (!this.store) throw new SendError(409, 'zapo_poll_vote_store_unavailable')
    const vote = payload?.poll_vote || payload?.pollVote || payload?.vote || payload?.poll || {}
    const messageId = `${
      vote?.message_id
      || vote?.messageId
      || vote?.id
      || payload?.context?.message_id
      || payload?.context?.id
      || ''
    }`.trim()
    if (!messageId) throw new SendError(400, 'poll_vote_message_id_required')
    const providerId = `${await resolveProviderMessageId(this.dataStore, messageId) || ''}`.trim() || messageId
    const key = await this.dataStore.loadKey(providerId) || await this.dataStore.loadKey(messageId)
    if (!key?.remoteJid) throw new SendError(404, `poll_message_not_found: ${messageId}`)
    const parent = await this.store.messageSecret.get(providerId)
    if (!parent?.secret?.length || !parent.senderJid) {
      throw new SendError(404, `poll_message_secret_not_found: ${messageId}`)
    }
    const selectedOptions = (
      vote?.selectedOptionNames
      || vote?.selected_options
      || vote?.selectedOptions
      || vote?.options
      || []
    )
    const selectedOptionNames = (Array.isArray(selectedOptions) ? selectedOptions : [selectedOptions])
      .map((name: unknown) => `${name || ''}`.trim())
      .filter(Boolean)
    if (!selectedOptionNames.length) throw new SendError(400, 'poll_vote_options_required')

    const target = await this.canonicalJid(key.remoteJid)
    return {
      target,
      content: {
        type: 'poll-vote' as const,
        poll: {
          id: providerId,
          fromMe: !!key.fromMe,
          authorJid: parent.senderJid,
          messageSecret: parent.secret,
          ...(target.endsWith('@g.us') ? { participant: key.participant || parent.senderJid } : {}),
        },
        selectedOptionNames,
      },
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

    if (type === 'message_edit') {
      const edit = await this.buildEditTarget(payload)
      const mapped = await toZapoMessageContent(this.client, payload, this.customMessageCharactersFunction)
      target = edit.target
      content = mapped.content
      Object.assign(options, mapped.options, { editKey: edit.editKey })
      if (Array.isArray(options.mentions)) {
        options.mentions = await this.canonicalJids(options.mentions.map((jid) => `${jid}`))
      }
    } else if (type === 'poll_vote' || type === 'poll-vote') {
      const vote = await this.buildPollVote(payload)
      target = vote.target
      content = vote.content
    } else if (type === 'reaction') {
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
      const contextId = `${payload?.context?.message_id || payload?.context?.id || ''}`
      if (contextId) {
        const key = await this.resolveKey(contextId)
        target = key.remoteJid
        options.quote = key
      }
      if (payload?.ttl !== undefined) options.expirationSeconds = Number(payload.ttl)
    }

    const result = target === 'status@broadcast'
      ? await this.sendStatus(content, options)
      : await this.sendDirect(target, content, options)
    if (target !== 'status@broadcast') await this.markLastIncomingRead(target)
    const key = { remoteJid: target, id: result.id, fromMe: true }
    let unoId = requestedUnoId || `${await this.dataStore.loadUnoId(result.id) || ''}`.trim() || uuid()
    unoId = await this.dataStore.setUnoId(result.id, unoId) || unoId
    await this.dataStore.setKey(result.id, key)
    await this.dataStore.setKey(unoId, key)
    const input = `${payload?.to || target || ''}`
    const isGroup = input.endsWith('@g.us')
    const isUsername = !isGroup && /[a-z_]/i.test(input.replace(/@(s\.whatsapp\.net|lid)$/i, ''))
    const contact = {
      input,
      ...(isGroup ? { wa_id: input, group_id: input } : (!isUsername ? { wa_id: toJid(input).split('@')[0] } : {})),
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
    try {
      return await this.sendDirectOnce(target, content, options)
    } catch (error) {
      if (!this.isPrivacyTokenNack(error) || !await this.recoverPrivacyMaterial(target)) throw error
      logger.info('Retry Zapo send after privacy material recovery target=%s', target)
      return this.sendDirectOnce(target, content, options)
    }
  }

  private async sendDirectOnce(target: string, content: WaSendMessageContent, options: Record<string, unknown>) {
    if (!this.composingMessage) return this.client.message.send(target, content, options as WaSendMessageOptions)
    const contentType = typeof content === 'object' && content && 'type' in content
      ? `${(content as { type?: unknown }).type || ''}`
      : ''
    const media = contentType === 'audio' || contentType === 'ptt' ? 'audio' : undefined
    await this.sendChatstate(target, { state: 'composing', ...(media ? { media } : {}) })
    try {
      return await this.client.message.send(target, content, options as WaSendMessageOptions)
    } finally {
      await this.sendChatstate(target, { state: 'paused' })
    }
  }

  private async sendChatstate(target: string, state: { state: 'composing' | 'paused', media?: 'audio' }) {
    try {
      await this.client.presence.sendChatstate(target, state)
    } catch (error) {
      logger.warn(error as any, 'Ignore Zapo chatstate error target=%s state=%s', target, state.state)
    }
  }

  private async markLastIncomingRead(target: string) {
    if (!this.readOnReply) return
    try {
      const candidates = new Set([target])
      if (target.endsWith('@lid')) {
        const pn = await this.dataStore.getPnForLid?.(this.phone, target)
        if (pn) candidates.add(pn)
      } else if (target.endsWith('@s.whatsapp.net')) {
        const lid = await this.dataStore.getLidForPn?.(this.phone, target)
        if (lid) candidates.add(lid)
      }

      let key
      for (const jid of candidates) {
        key = await this.dataStore.getLastIncomingKey?.(jid)
        if (key) break
      }
      if (!key?.remoteJid || !key.id || key.fromMe) return

      await this.client.message.sendReceipt(key.remoteJid, key.id, {
        type: 'read',
        ...(key.participant ? { participant: key.participant } : {}),
      })
      logger.info('Zapo read-on-reply target=%s message=%s', target, key.id)
    } catch (error) {
      logger.warn(error as any, 'Ignore Zapo read-on-reply error target=%s', target)
    }
  }

  private isPrivacyTokenNack(error: unknown) {
    const value = error as any
    return Number(value?.code || value?.data || value?.errorCode) === 463 || /(?:error|code)[= :]+463\b/i.test(`${value?.message || ''}`)
  }

  private async recoverPrivacyMaterial(target: string): Promise<boolean> {
    if (!this.store || target.endsWith('@g.us')) return false
    const hasMaterial = async () => {
      const [token, salt] = await Promise.all([
        this.store!.privacyToken.getByJid(target),
        this.store!.privacyToken.getByJid('__nct_salt__'),
      ])
      return !!token?.tcToken || !!salt?.nctSalt
    }
    if (await hasMaterial()) return true
    try { await this.client.chat.sync() } catch (error) {
      logger.warn(error as any, 'Zapo app-state sync failed during 463 recovery target=%s', target)
    }
    if (await hasMaterial()) return true
    try { await this.client.profile.getProfiles([target]) } catch (error) {
      logger.warn(error as any, 'Zapo profile token fetch failed during 463 recovery target=%s', target)
    }
    const recovered = await hasMaterial()
    logger.warn('Zapo 463 recovery target=%s privacy_material=%s', target, recovered ? 'available' : 'missing')
    return recovered
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
