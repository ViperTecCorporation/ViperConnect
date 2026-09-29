import { proto } from 'zapo-js'
import { deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

type Packet = { message: proto.Message.IProtocolMessage; count: number }
/** Lab-only: same envelope as Zapo's buildHistorySyncBootstrapMessage.
 * Keep Redis paging/privacy filtering, but publish exactly one complete bootstrap.
 * Oversize archives fail before any history is sent; never silently truncate. */
export async function* singleCompanionBootstrap(pages: AsyncIterable<Packet>): AsyncGenerator<Packet> {
  const conversations = new Map<string, proto.IConversation>()
  const mappings = new Map<string, { pnJid: string; lidJid: string }>()
  let bytes = 0, count = 0
  for await (const page of pages) {
    const raw = await promisify(inflate)(page.message.historySyncNotification!.initialHistBootstrapInlinePayload!)
    bytes += raw.length
    if (bytes > 4 * 1024 * 1024) throw new Error('mobile_history_single_bootstrap_too_large')
    const history = proto.HistorySync.decode(raw)
    for (const mapping of history.phoneNumberToLidMappings) {
      if (mapping.pnJid && mapping.lidJid) mappings.set(mapping.lidJid, { pnJid: mapping.pnJid, lidJid: mapping.lidJid })
    }
    for (const part of history.conversations) {
      if (!part.id) throw new Error('mobile_history_conversation_id_missing')
      const messages = part.messages || []
      if (!messages.length) continue
      const previous = conversations.get(part.id)
      if (previous) previous.messages!.push(...messages)
      else conversations.set(part.id, { ...part, messages: [...messages] })
      count += messages.length
    }
  }
  if (!count) return
  for (const conversation of conversations.values()) {
    conversation.messages!.sort((a, b) => Number(b.message?.messageTimestamp) - Number(a.message?.messageTimestamp))
    const timestamp = Number(conversation.messages![0].message?.messageTimestamp)
    conversation.conversationTimestamp = timestamp
    conversation.lastMsgTimestamp = timestamp
    conversation.endOfHistoryTransfer = true
    delete conversation.endOfHistoryTransferType
  }
  const payload = await promisify(deflate)(proto.HistorySync.encode({
    syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    chunkOrder: 0, progress: 100, conversations: [...conversations.values()],
    pushnames: [], phoneNumberToLidMappings: [...mappings.values()],
  }).finish(), { level: 1 })
  if (payload.length > 192000) throw new Error('mobile_history_single_bootstrap_too_large')
  yield { count, message: {
    type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
    historySyncNotification: { syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
      chunkOrder: 0, progress: 100, initialHistBootstrapInlinePayload: payload },
  } }
}
