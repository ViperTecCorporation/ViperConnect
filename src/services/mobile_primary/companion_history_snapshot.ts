import { proto } from 'zapo-js'
import { deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

/** One initial inventory, not one INITIAL_BOOTSTRAP per chat. The archive itself
 * stays paginated in the continuation. Fail explicitly rather than omit chats. */
export async function companionHistorySnapshot(pages: AsyncIterable<{ message: proto.Message.IProtocolMessage; count: number }>) {
  const chats = new Map<string, proto.IConversation>()
  const mappings = new Map<string, { pnJid: string; lidJid: string }>()
  let retained = 0
  for await (const page of pages) {
    const history = proto.HistorySync.decode(await promisify(inflate)(page.message.historySyncNotification!.initialHistBootstrapInlinePayload!))
    for (const mapping of history.phoneNumberToLidMappings) {
      if (mapping.pnJid && mapping.lidJid) mappings.set(mapping.lidJid, { pnJid: mapping.pnJid, lidJid: mapping.lidJid })
    }
    for (const chat of history.conversations) {
      if (!chat.id) throw new Error('mobile_history_conversation_id_missing')
      const latest = [...(chat.messages || [])].sort((a, b) => Number(b.message?.messageTimestamp) - Number(a.message?.messageTimestamp))[0]
      if (!latest) continue
      const previous = chats.get(chat.id)
      if (previous && Number(previous.messages?.[0].message?.messageTimestamp) >= Number(latest.message?.messageTimestamp)) continue
      const next = { ...chat, messages: [latest], endOfHistoryTransfer: false }
      delete next.endOfHistoryTransferType
      next.conversationTimestamp = latest.message!.messageTimestamp
      next.lastMsgTimestamp = latest.message!.messageTimestamp
      retained += proto.Conversation.encode(next).finish().length - (previous ? proto.Conversation.encode(previous).finish().length : 0)
      if (retained > 4 * 1024 * 1024 || mappings.size > 10000) throw new Error('mobile_history_snapshot_too_large')
      chats.set(chat.id, next)
    }
  }
  if (!chats.size) return undefined
  const payload = await promisify(deflate)(proto.HistorySync.encode({
    syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, chunkOrder: 0, progress: 100,
    conversations: [...chats.values()], phoneNumberToLidMappings: [...mappings.values()],
  }).finish(), { level: 1 })
  if (payload.length > 192000) throw new Error('mobile_history_snapshot_too_large')
  return { conversations: chats.size, message: {
    type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
    historySyncNotification: { syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
      chunkOrder: 0, progress: 100, initialHistBootstrapInlinePayload: payload },
  } }
}
