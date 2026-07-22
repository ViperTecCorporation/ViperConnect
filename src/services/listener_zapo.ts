import { v1 as uuid } from 'uuid'
import type { Broadcast } from './broadcast'
import type { getConfig } from './config'
import type { eventType, Listener } from './listener'
import logger from './logger'
import type { Outgoing } from './outgoing'
import {
  fromBaileysMessageContent,
  getBinMessage,
  getMessageType,
  isSaveMedia,
  normalizeMessageContent,
} from './transformer'
import { resolveUnoMessageId } from './message_id_map'

const STATUS_RANK: Record<string, number> = {
  failed: 0,
  progress: 1,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  played: 4,
  deleted: 5,
}

/**
 * Provider-neutral webhook boundary for Zapo events.
 *
 * The payload remains WAProto-compatible, so the public Cloud API transformer
 * is reused. Baileys session assertions, poll crypto fallbacks and Redis JID
 * repairs intentionally do not belong in this pipeline.
 */
export class ListenerZapo implements Listener {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly outgoing: Outgoing,
    private readonly broadcast: Broadcast,
    private readonly getConfig: getConfig,
    private readonly dedupWindowMs = 30_000,
  ) {}

  async process(phone: string, messages: object[], type: eventType) {
    if (type === 'qrcode') {
      await this.broadcast.send(phone, type, (messages[0] as any)?.message?.imageMessage?.url)
      return
    }
    if (type === 'status') {
      await this.broadcast.send(phone, type, (messages[0] as any)?.message?.conversation)
      return
    }

    const config = await this.getConfig(phone)
    const accepted = messages.filter((message: any) => {
      const jid = `${message?.key?.remoteJid || ''}`
      if (!jid) return false
      const messageType = this.messageType(message)
      return !config.shouldIgnoreJid(jid) && !config.shouldIgnoreKey(message.key, messageType)
    })
    await Promise.all(accepted.map((message) => this.sendOne(phone, message)))
  }

  private messageType(message: any) {
    try {
      const normalized = normalizeMessageContent(message?.message)
      return getMessageType({ message: normalized }) || getMessageType(message)
    } catch {
      return getMessageType(message)
    }
  }

  private isDuplicate(message: any) {
    const id = `${message?.key?.id || ''}`
    const jid = `${message?.key?.remoteJid || ''}`
    if (!id || !jid || message?.update) return false
    const key = `${jid}|${id}`
    const now = Date.now()
    const previous = this.seen.get(key) || 0
    this.seen.set(key, now)
    if (this.seen.size > 50_000) {
      const cutoff = now - this.dedupWindowMs * 2
      for (const [entry, timestamp] of this.seen) if (timestamp < cutoff) this.seen.delete(entry)
    }
    return now - previous < this.dedupWindowMs
  }

  private async mapReferencedIds(dataStore: any, message: any) {
    const map = async (container: any, property: string) => {
      const id = `${container?.[property] || ''}`.trim()
      if (!id) return
      const mapped = await resolveUnoMessageId(dataStore, id)
      if (mapped) container[property] = mapped
    }
    const content = getBinMessage(message as any)?.message
    await map(content?.contextInfo, 'stanzaId')
    await map(message?.message?.reactionMessage?.key, 'id')
    await map(message?.message?.protocolMessage?.key, 'id')
    await map(message?.update?.message?.protocolMessage?.key, 'id')
  }

  private async normalizeMessageId(store: any, message: any, metadata: (value: any) => Promise<any>, messageType?: string) {
    const providerId = `${message?.key?.id || ''}`.trim()
    if (!providerId) return message

    if (messageType === 'update' || messageType === 'receipt' || message?.update) {
      const mapped = await resolveUnoMessageId(store.dataStore, providerId)
      if (mapped) message.key.id = mapped
      await this.mapReferencedIds(store.dataStore, message)
      return message
    }

    let normalized = await metadata(message)
    let unoId = await resolveUnoMessageId(store.dataStore, providerId) || uuid()
    const providerKey = { ...normalized.key, id: providerId }
    unoId = await store.dataStore.setUnoId(providerId, unoId) || unoId
    await store.dataStore.setKey(providerId, providerKey)
    await store.dataStore.setKey(unoId, providerKey)
    await store.dataStore.setMessage(providerKey.remoteJid, { ...normalized, key: providerKey })
    normalized.key.id = unoId
    await this.mapReferencedIds(store.dataStore, normalized)
    if (isSaveMedia(normalized)) {
      const downloaded = normalized.__unoapiMediaBytes
      if (downloaded && store.mediaStore.saveDownloadedMedia) {
        normalized = await store.mediaStore.saveDownloadedMedia(normalized, Buffer.from(downloaded))
      } else {
        normalized = await store.mediaStore.saveMedia(normalized)
      }
      try { delete normalized.__unoapiMediaBytes } catch {}
    }
    return normalized
  }

  private async shouldForwardStatus(store: any, payload: any) {
    const status = payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]
    if (!status?.id || !status?.status) return true
    const previous = await store.dataStore.loadStatus(status.id)
    const oldRank = STATUS_RANK[`${previous || ''}`] ?? -1
    const newRank = STATUS_RANK[`${status.status}`] ?? -1
    if (previous && oldRank >= newRank) return false
    await store.dataStore.setStatus(status.id, status.status)
    return true
  }

  async sendOne(phone: string, raw: object) {
    if (this.isDuplicate(raw)) return
    const source: any = raw
    const message: any = {
      ...source,
      key: { ...(source?.key || {}) },
      ...(source?.update ? { update: { ...source.update } } : {}),
    }
    const config = await this.getConfig(phone)
    const store = await config.getStore(phone, config)
    const messageType = this.messageType(message)
    const normalized = await this.normalizeMessageId(store, message, config.getMessageMetadata, messageType)

    if (normalized?.key?.id && normalized?.key?.remoteJid && !normalized?.key?.fromMe) {
      await store.dataStore.setLastIncomingKey?.(normalized.key.remoteJid, normalized.key)
      const alternate = normalized.key.remoteJidAlt || normalized.key.participantAlt
      if (alternate) await store.dataStore.setLastIncomingKey?.(alternate, normalized.key)
    }

    const [payload] = fromBaileysMessageContent(phone, normalized, config)
    if (!payload || !(await this.shouldForwardStatus(store, payload))) return
    await this.outgoing.send(phone, payload)
  }
}
