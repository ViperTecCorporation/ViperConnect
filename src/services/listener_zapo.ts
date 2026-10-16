import { v1 as uuid } from 'uuid'
import type { Broadcast } from './broadcast'
import type { getConfig } from './config'
import type { eventType, Listener } from './listener'
import type { Outgoing } from './outgoing'
import {
  activeZapoMessageMetadataResolver,
  type ZapoMessageMetadataResolver,
} from './zapo/zapo_message_metadata'
import {
  fromBaileysMessageContent,
  getBinMessage,
  getMessageType,
  isSaveMedia,
  normalizeMessageContent,
} from './transformer'
import { resolveUnoMessageId } from './message_id_map'
import { addProviderMessageIds } from './messages/provider_message_identity'
import { getPollState, setPollState } from './redis'
import {
  normalizePollAggregateState,
  pollOptionHash,
  selectedPollOptionHashes,
} from './messages/poll_vote_state'

const POLL_CREATION_TYPES = new Set([
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
  'pollCreationMessageV5',
])

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
    private readonly messageMetadata: ZapoMessageMetadataResolver = activeZapoMessageMetadataResolver,
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

  private isDuplicate(phone: string, message: any, messageType?: string) {
    const id = `${message?.key?.id || ''}`
    const jid = `${message?.key?.remoteJid || ''}`
    if (!id || !jid || message?.update) return false
    const key = `${phone}|${jid}|${id}|${messageType || 'unknown'}`
    const now = Date.now()
    const previous = this.seen.get(key) || 0
    this.seen.set(key, now)
    if (this.seen.size > 50_000) {
      const cutoff = now - this.dedupWindowMs * 2
      for (const [entry, timestamp] of this.seen) if (timestamp < cutoff) this.seen.delete(entry)
    }
    return now - previous < this.dedupWindowMs
  }

  private async mapReferencedIds(dataStore: any, message: any, identities: Map<string, string>) {
    const map = async (container: any, property: string) => {
      const id = `${container?.[property] || ''}`.trim()
      if (!id) return
      const mapped = await resolveUnoMessageId(dataStore, id)
      identities.set(mapped || id, `${container[property]}`)
      if (mapped) container[property] = mapped
    }
    const content = getBinMessage(message as any)?.message
    await map(content?.contextInfo, 'stanzaId')
    await map(content?.orderRequestMessageId, 'id')
    await map(message?.message?.reactionMessage?.key, 'id')
    await map(message?.message?.pollUpdateMessage?.pollCreationMessageKey, 'id')
    await map(message?.message?.protocolMessage?.key, 'id')
    await map(message?.update?.message?.protocolMessage?.key, 'id')
    // Wrapped edits historically keep their reference unchanged. Capture it only.
    for (const protocol of [message?.message?.editedMessage?.message?.protocolMessage,
      message?.update?.message?.editedMessage?.message?.protocolMessage]) {
      if (protocol?.key?.id) identities.set(protocol.key.id, protocol.key.id)
    }
  }

  private async normalizeMessageId(phone: string, store: any, message: any, identities: Map<string, string>, messageType?: string) {
    const providerId = `${message?.key?.id || ''}`.trim()
    if (!providerId) return message

    if (messageType === 'update' || messageType === 'receipt' || message?.update) {
      const mapped = await resolveUnoMessageId(store.dataStore, providerId)
      identities.set(mapped || providerId, `${message.key.id}`)
      if (mapped) message.key.id = mapped
      await this.mapReferencedIds(store.dataStore, message, identities)
      return message
    }

    let normalized = await this.messageMetadata.resolve(phone, message)
    let unoId = await resolveUnoMessageId(store.dataStore, providerId) || uuid()
    const providerKey = { ...normalized.key, id: providerId }
    unoId = await store.dataStore.setUnoId(providerId, unoId) || unoId
    identities.set(unoId, `${message.key.id}`)
    await store.dataStore.setKey(providerId, providerKey)
    await store.dataStore.setKey(unoId, providerKey)
    await store.dataStore.setMessage(providerKey.remoteJid, { ...normalized, key: providerKey })
    normalized.key.id = unoId
    await this.mapReferencedIds(store.dataStore, normalized, identities)
    if (isSaveMedia(normalized)) {
      const downloaded = normalized.__unoapiMediaBytes
      if (downloaded && store.mediaStore.saveDownloadedMedia) {
        normalized = await store.mediaStore.saveDownloadedMedia(normalized, Buffer.from(downloaded))
      } else {
        throw new Error('zapo_media_bytes_unavailable')
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

  private async savePollCreation(phone: string, message: any, messageType?: string) {
    if (!messageType || !POLL_CREATION_TYPES.has(messageType)) return
    const creation = message?.message?.[messageType]
    const pollId = `${message?.key?.id || ''}`.trim()
    const remoteJid = `${message?.key?.remoteJid || ''}`.trim()
    const options = (Array.isArray(creation?.options) ? creation.options : []).reduce((acc: Record<string, string>, option: any) => {
      const name = `${option?.optionName || ''}`.trim()
      if (name) acc[pollOptionHash(name)] = name
      return acc
    }, {})
    if (!pollId || !remoteJid || !Object.keys(options).length) return
    await setPollState(phone, remoteJid, pollId, {
      pollId,
      remoteJid,
      pollName: `${creation?.name || ''}`.trim(),
      options,
      voters: {},
      updatedAt: Date.now(),
    })
  }

  private async loadPollCreation(store: any, remoteJid: string, pollId: string) {
    const key = await store.dataStore.loadKey?.(pollId)
    const providerId = `${key?.id || pollId}`.trim()
    const parent = await store.dataStore.loadMessage?.(remoteJid, providerId)
    const content = parent?.message || {}
    return content.pollCreationMessage
      || content.pollCreationMessageV2
      || content.pollCreationMessageV3
      || content.pollCreationMessageV5
  }

  private async enrichPollUpdate(phone: string, store: any, message: any, payload: any) {
    const update = message?.message?.pollUpdateMessage
    const pollId = `${update?.pollCreationMessageKey?.id || ''}`.trim()
    const remoteJid = `${update?.pollCreationMessageKey?.remoteJid || message?.key?.remoteJid || ''}`.trim()
    if (!pollId || !remoteJid) return

    let state: any = await getPollState(phone, remoteJid, pollId)
    if (!state) {
      const creation = await this.loadPollCreation(store, remoteJid, pollId)
      const optionNames = Array.isArray(creation?.options)
        ? creation.options.map((option: any) => `${option?.optionName || ''}`.trim()).filter(Boolean)
        : (Array.isArray(update?.vote?.selectedOptionNames)
          ? update.vote.selectedOptionNames.map((name: unknown) => `${name || ''}`.trim()).filter(Boolean)
          : [])
      state = {
        pollId,
        remoteJid,
        pollName: `${creation?.name || ''}`.trim(),
        options: optionNames.reduce((acc: Record<string, string>, name: string) => {
          acc[pollOptionHash(name)] = name
          return acc
        }, {}),
        voters: {},
      }
    }
    state = normalizePollAggregateState(state)
    if (!Object.keys(state.options || {}).length) return

    const voterJid = `${message?.key?.participant || (message?.key?.fromMe ? `self:${phone}` : message?.key?.remoteJid) || ''}`.trim()
    if (!voterJid) return
    const selected = selectedPollOptionHashes(update?.vote, state.options)
    state.voters = state.voters || {}
    if (selected.length) state.voters[voterJid] = selected
    else delete state.voters[voterJid]
    state.updatedAt = Date.now()
    await setPollState(phone, remoteJid, pollId, state)

    const counts = Object.keys(state.options).reduce<Record<string, number>>((acc, hash) => {
      acc[hash] = 0
      return acc
    }, {})
    for (const hashes of Object.values(state.voters) as string[][]) {
      for (const hash of hashes) if (hash in counts) counts[hash] += 1
    }
    const webhookMessage = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (!webhookMessage) return
    webhookMessage.type = 'text'
    webhookMessage.text = {
      body: [
        `*Resultado de enquete*${state.pollName ? `: ${state.pollName}` : ''}`,
        `Total de votos: ${Object.keys(state.voters).length}`,
        ...Object.entries(state.options).map(([hash, name]) => `- ${name}: ${counts[hash] || 0}`),
      ].join('\n'),
    }
  }

  async sendOne(phone: string, raw: object) {
    const source: any = raw
    const message: any = {
      ...source,
      key: { ...(source?.key || {}) },
      ...(source?.update ? { update: { ...source.update } } : {}),
    }
    const skipTypebot = message?.key?.__unoapiSkipTypebot === true
    if (skipTypebot) delete message.key.__unoapiSkipTypebot
    const providerIncomingKey = message?.key?.id && !message?.key?.fromMe
      ? { ...message.key }
      : undefined
    const messageType = this.messageType(message)
    if (this.isDuplicate(phone, message, messageType)) return
    const config = await this.getConfig(phone)
    const store = await config.getStore(phone, config)
    const identities = new Map<string, string>()
    const normalized = await this.normalizeMessageId(phone, store, message, identities, messageType)
    // Call notices have a locally generated UUID, not a protocol message ID.
    if (skipTypebot) identities.delete(normalized?.key?.id)
    await this.savePollCreation(phone, normalized, messageType)

    if (normalized?.key?.id && normalized?.key?.remoteJid && !normalized?.key?.fromMe) {
      const receiptKey = providerIncomingKey
        ? { ...normalized.key, ...providerIncomingKey, id: providerIncomingKey.id }
        : normalized.key
      await store.dataStore.setLastIncomingKey?.(normalized.key.remoteJid, receiptKey)
      const alternate = normalized.key.remoteJidAlt || normalized.key.participantAlt
      if (alternate) await store.dataStore.setLastIncomingKey?.(alternate, receiptKey)
    }

    const [payload] = fromBaileysMessageContent(phone, normalized, config)
    if (!payload || !(await this.shouldForwardStatus(store, payload))) return
    addProviderMessageIds(payload, identities)
    if (messageType === 'pollUpdateMessage') await this.enrichPollUpdate(phone, store, normalized, payload)
    if (skipTypebot) (payload as any).__unoapiSkipTypebot = true
    await this.outgoing.send(phone, payload)
  }
}
