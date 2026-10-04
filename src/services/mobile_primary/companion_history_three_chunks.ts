import { proto } from 'zapo-js'
import { deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

type Packet = { message: proto.Message.IProtocolMessage; count: number }
/** Lab experiment: latest message from every chat first, then older messages.
 * Validate ALL chunks before yielding any. Limits are local safety guards, not
 * claimed WhatsApp limits. Explicit experiments can exceed three chunks;
 * each-media-text-end isolates every media and reserves one real final text.
 * Never silently truncate. */
export async function* threeChunkHistory(pages: AsyncIterable<Packet>, maxPayloadBytes = 192000, ordering: boolean | 'media-last' | 'media-split' | 'each-media-text-end' | 'text-video-sticker-image' = false): AsyncGenerator<Packet> {
  const selected: { history: proto.HistorySync; count: number }[] = []
  let retained = 0
  for await (const packet of pages) {
    const payload = packet.message.historySyncNotification?.initialHistBootstrapInlinePayload
    if (!payload) throw new Error('mobile_history_payload_missing')
    const raw = await promisify(inflate)(payload, { maxOutputLength: 4 * 1024 * 1024 })
    retained += raw.length
    if (retained > 32 * 1024 * 1024 || selected.length >= 100000) throw new Error('mobile_history_three_chunks_capacity')
    const history = proto.HistorySync.decode(raw)
    if (history.syncType !== proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP) throw new Error('mobile_history_sync_type_invalid')
    if (history.conversations.reduce((n, c) => n + (c.messages?.length || 0), 0) !== packet.count) throw new Error('mobile_history_count_mismatch')
    if (packet.count) selected.push({ history, count: packet.count })
  }
  const chats = new Map<string, proto.IConversation>()
  const mappings = new Map<string, proto.IPhoneNumberToLIDMapping>()
  for (const { history } of selected) {
      for (const mapping of history.phoneNumberToLidMappings) if (mapping.lidJid) mappings.set(mapping.lidJid, mapping)
      for (const chat of history.conversations) {
        if (!chat.id) throw new Error('mobile_history_conversation_id_missing')
        const previous = chats.get(chat.id)
        const messages = [...(previous?.messages || []), ...(chat.messages || [])]
        chats.set(chat.id, { ...previous, ...chat, messages })
      }
  }
  type Entry = { jid: string; item: proto.IHistorySyncMsg }
  const compare = (a: Entry, b: Entry) => Number(b.item.message?.messageTimestamp) - Number(a.item.message?.messageTimestamp)
    || a.jid.localeCompare(b.jid) || (a.item.message?.key?.id || '').localeCompare(b.item.message?.key?.id || '')
  const initial: Entry[] = [], remaining: Entry[] = []
  for (const [jid, chat] of chats) {
    const entries = (chat.messages || []).map(item => ({ jid, item })).sort(compare)
    if (!entries.length) continue
    chat.conversationTimestamp = entries[0].item.message?.messageTimestamp
    chat.lastMsgTimestamp = entries[0].item.message?.messageTimestamp
    initial.push(entries[0]); remaining.push(...entries.slice(1))
  }
  if (!initial.length) return
  initial.sort(compare); remaining.sort(compare)
  const batches = [initial]
  if (remaining.length) {
    const split = Math.ceil(remaining.length / 2)
    batches.push(remaining.slice(0, split))
    if (split < remaining.length) batches.push(remaining.slice(split))
  }
  // Controlled position/content experiment: preserve membership, then recompute
  // envelope order, progress and per-chat completion in the new sending order.
  if (ordering === 'media-last' || ordering === 'media-split' || ordering === 'each-media-text-end' || ordering === 'text-video-sticker-image') {
    const text: Entry[] = [], media: Entry[] = [], video: Entry[] = []
    for (const entry of [...initial, ...remaining].sort(compare)) {
      const m = entry.item.message?.message
      const isMedia = !!(m?.imageMessage || m?.videoMessage || m?.audioMessage || m?.documentMessage || m?.stickerMessage)
      if (ordering === 'media-split' && m?.videoMessage) video.push(entry)
      else if (isMedia) media.push(entry)
      else text.push(entry)
    }
    batches.length = 0
    // Reserve a real text, never synthesize or repeat a closing message.
    const closing = ordering === 'each-media-text-end' ? text.pop() : undefined
    if (text.length) {
      const split = ordering === 'text-video-sticker-image' ? text.length : Math.ceil(text.length / 2)
      batches.push(text.slice(0, split))
      if (split < text.length) batches.push(text.slice(split))
    }
    if (ordering === 'text-video-sticker-image') {
      // Stable grouping preserves newest-first within each media type. Other
      // eligible media remain included, before images, rather than discarded.
      for (const field of ['videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage', 'imageMessage'] as const) {
        for (const item of media) if (item.item.message?.message?.[field]) batches.push([item])
      }
    } else if (ordering === 'each-media-text-end') {
      for (const item of media) batches.push([item])
    } else if (media.length) batches.push(media)
    if (video.length) batches.push(video)
    if (closing) batches.push([closing])
  } else if (ordering && batches.length > 1) [batches[0], batches[1]] = [batches[1], batches[0]]
  const total = batches.length, output: Packet[] = [], emitted = new Map<string, number>()
  for (let index = 0; index < total; index++) {
    const conversations = new Map<string, proto.IConversation>()
    for (const { jid, item } of batches[index]) {
      let part = conversations.get(jid)
      if (!part) { part = { ...chats.get(jid)!, messages: [] }; conversations.set(jid, part) }
      part.messages!.push(item)
      emitted.set(jid, (emitted.get(jid) || 0) + 1)
    }
    for (const [jid, part] of conversations) {
      part.endOfHistoryTransfer = emitted.get(jid) === chats.get(jid)!.messages!.length
      delete part.endOfHistoryTransferType
    }
    const progress = Math.floor((index + 1) * 100 / total)
    const payload = await promisify(deflate)(proto.HistorySync.encode({
      syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
      chunkOrder: index, progress, conversations: [...conversations.values()],
      phoneNumberToLidMappings: [...mappings.values()],
    }).finish(), { level: 1 })
    if (payload.length > maxPayloadBytes) throw new Error('mobile_history_three_chunks_too_large')
    output.push({ count: batches[index].length, message: {
      type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
      historySyncNotification: { syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
        chunkOrder: index, progress, initialHistBootstrapInlinePayload: payload },
    } })
  }
  yield* output
}
