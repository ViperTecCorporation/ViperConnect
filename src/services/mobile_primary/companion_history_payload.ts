import { proto, type WaStoreSession, type WaStoredThreadRecord } from 'zapo-js'
import { deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

const compress = promisify(deflate)
export interface HistoryImageExperiment { imageId: string; threadJid: string }
/** Bounded laboratory export. Media references are preserved, never downloaded.
 * Never unwrap ephemeral/view-once messages or resurrect expiring content. */
export async function collectCompanionHistory(store: WaStoreSession, now = Date.now(), threads?: readonly WaStoredThreadRecord[], allAges = false, imageExperiment?: HistoryImageExperiment) {
  const conversations: proto.IConversation[] = []
  const seen = new Set<string>()
  let count = 0, bytes = 0
  for (const thread of (threads || await store.threads.list(50)).slice(0, 50)) {
    if (thread.ephemeralExpiration || !/@(s\.whatsapp\.net|lid|g\.us)$/.test(thread.jid)) continue
    const messages: proto.IHistorySyncMsg[] = []
    const records = await store.messages.listByThread(thread.jid, 50)
    const changed = new Set<string>()
    for (const record of records) {
      try {
        if (!record.messageBytes || record.messageBytes.length > 65536) continue
        const protocol = proto.Message.decode(record.messageBytes).protocolMessage
        if (protocol?.key?.id && [proto.Message.ProtocolMessage.Type.REVOKE, proto.Message.ProtocolMessage.Type.MESSAGE_EDIT].includes(protocol.type!)) changed.add(protocol.key.id)
      } catch { /* Corrupt records are not exported. */ }
    }
    for (const record of records) {
      if (!allAges && (count >= 200 || bytes >= 512000)) break
      if (!record.id || record.threadJid !== thread.jid || !record.timestampMs || (!allAges && record.timestampMs < now - 7 * 86400000) || record.timestampMs > now || !record.messageBytes?.length || record.messageBytes.length > 65536) continue
      const identity = `${thread.jid}:${record.fromMe}:${record.id}`
      if (seen.has(identity) || changed.has(record.id)) continue
      try {
        const decoded = proto.Message.decode(record.messageBytes)
        // Only normal unwrapped content. Do not export protocol/edits/revokes/unknown types.
        const fields = Object.keys(decoded).filter(key => decoded[key] != null && key !== '$unknowns')
        const mediaFields = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage'] as const
        const contentFields = fields.filter(key => key !== 'messageContextInfo')
        if (contentFields.length !== 1 || !['conversation', 'extendedTextMessage', ...mediaFields].includes(contentFields[0])) continue
        let content: proto.IMessage
        const mediaField = mediaFields.find(key => decoded[key])
        if (mediaField) {
          if (imageExperiment && (mediaField !== 'imageMessage' || record.id !== imageExperiment.imageId || thread.jid !== imageExperiment.threadJid)) continue
          const media = decoded[mediaField] as any
          if (media.viewOnce || media.contextInfo?.expiration || media.contextInfo?.ephemeralSettingTimestamp ||
            !media.directPath || media.mediaKey?.length !== 32 || media.fileSha256?.length !== 32 || media.fileEncSha256?.length !== 32) continue
          // Keep original encrypted-media references/checksums. No URL is fetched here.
          content = { [mediaField]: { ...media, contextInfo: imageExperiment ? media.contextInfo : undefined, $unknowns: undefined } }
        } else {
          const context = decoded.extendedTextMessage?.contextInfo
          if (context?.expiration || context?.ephemeralSettingTimestamp) continue
          const text = decoded.conversation || decoded.extendedTextMessage?.text
          if (!text || Buffer.byteLength(text) > 8192) continue
          content = { conversation: text }
        }
        const message: proto.IWebMessageInfo = {
          key: { id: record.id, remoteJid: thread.jid, fromMe: record.fromMe,
            ...(thread.jid.endsWith('@g.us') && (record.participantJid || record.senderJid) ? { participant: record.participantJid || record.senderJid } : {}) },
          messageTimestamp: Math.floor(record.timestampMs / 1000), message: content,
        }
        if (thread.jid.endsWith('@g.us') && !record.fromMe && !message.key?.participant) continue
        messages.push({ message }); seen.add(identity); count++; bytes += record.messageBytes.length
      } catch { /* An unreadable local record must not abort the remaining export. */ }
    }
    if (messages.length) {
      messages.sort((a, b) => Number(b.message!.messageTimestamp) - Number(a.message!.messageTimestamp))
      const timestamp = Number(messages[0].message!.messageTimestamp)
      conversations.push({ id: thread.jid, name: thread.name, messages,
        conversationTimestamp: timestamp, lastMsgTimestamp: timestamp,
        unreadCount: 0, endOfHistoryTransfer: true })
    }
    if (!allAges && (count >= 200 || bytes >= 512000)) break
  }
  return { conversations, count }
}

/** Same inline DEFLATE envelope as Zapo 1.9.0 companion-host. Limit encoded bytes
 * as well as message count so thumbnails never create an unbounded notification. */
export async function historyPackets(conversations: proto.IConversation[], mappings: { pnJid: string; lidJid: string }[] = []) {
  const batches: proto.IConversation[][] = []
  for (const conversation of conversations) {
    const messages = conversation.messages || []
    let batch: proto.IHistorySyncMsg[] = [], size = 0
    for (const message of messages) {
      const messageSize = proto.HistorySyncMsg.encode(message).finish().length
      if (batch.length && (batch.length >= 20 || size + messageSize > 96000)) { batches.push([{ ...conversation, messages: batch, endOfHistoryTransfer: false }]); batch = []; size = 0 }
      batch.push(message); size += messageSize
    }
    if (batch.length) batches.push([{ ...conversation, messages: batch }])
  }
  const packets: { message: proto.Message.IProtocolMessage; count: number }[] = []
  for (let i = 0; i < batches.length; i++) {
    const progress = Math.floor((i + 1) * 100 / batches.length)
    const payload = await compress(proto.HistorySync.encode({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, chunkOrder: i, progress, conversations: batches[i], phoneNumberToLidMappings: mappings }).finish(), { level: 1 })
    if (payload.length > 192000) throw new Error('history_packet_too_large')
    packets.push({ count: batches[i][0].messages!.length, message: {
      type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
      historySyncNotification: { syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP, chunkOrder: i, progress, initialHistBootstrapInlinePayload: payload },
    } })
  }
  return packets
}

export async function resequenceHistoryPacket(packet: { message: proto.Message.IProtocolMessage; count: number }, order: number, last: boolean, conversationComplete = last): Promise<{ message: proto.Message.IProtocolMessage; count: number }> {
  const notification = packet.message.historySyncNotification!
  const decoded = proto.HistorySync.decode(await promisify(inflate)(notification.initialHistBootstrapInlinePayload!))
  decoded.chunkOrder = order; decoded.progress = last ? 100 : undefined
  for (const conversation of decoded.conversations) {
    conversation.endOfHistoryTransfer = conversationComplete
    delete conversation.endOfHistoryTransferType
  }
  return { count: packet.count, message: { ...packet.message, historySyncNotification: {
    ...notification, chunkOrder: order, progress: last ? 100 : undefined,
    initialHistBootstrapInlinePayload: await compress(proto.HistorySync.encode(decoded).finish(), { level: 1 }),
  } } }
}
