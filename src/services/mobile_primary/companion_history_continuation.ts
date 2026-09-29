import { proto } from 'zapo-js'
import { deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

export interface HistoryUpload {
  directPath: string; mediaKey: Uint8Array; fileSha256: Uint8Array; fileEncSha256: Uint8Array; fileLength: number
}
/** Recent history continuation uses an encrypted CDN blob after the inventory. */
export async function continuationNotification(message: proto.Message.IProtocolMessage,
  upload: (bytes: Uint8Array) => Promise<HistoryUpload>): Promise<proto.Message.IProtocolMessage> {
  const source = message.historySyncNotification
  if (!source?.initialHistBootstrapInlinePayload) throw new Error('mobile_history_payload_missing')
  const history = proto.HistorySync.decode(await promisify(inflate)(source.initialHistBootstrapInlinePayload))
  history.syncType = proto.HistorySync.HistorySyncType.RECENT
  const compressed = await promisify(deflate)(proto.HistorySync.encode(history).finish(), { level: 1 })
  const uploaded = await upload(compressed)
  if (!uploaded.directPath || uploaded.mediaKey.length !== 32 || uploaded.fileSha256.length !== 32 || uploaded.fileEncSha256.length !== 32 || uploaded.fileLength !== compressed.length) {
    throw new Error('mobile_history_upload_invalid')
  }
  const timestamps = history.conversations.flatMap(c => (c.messages || []).map(m => Number(m.message?.messageTimestamp))).filter(n => n > 0)
  return { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION, historySyncNotification: {
    syncType: proto.Message.HistorySyncType.RECENT, chunkOrder: source.chunkOrder, progress: source.progress,
    directPath: uploaded.directPath, mediaKey: uploaded.mediaKey,
    fileSha256: uploaded.fileSha256, fileEncSha256: uploaded.fileEncSha256, fileLength: uploaded.fileLength,
    ...(timestamps.length ? { oldestMsgInChunkTimestampSec: Math.min(...timestamps) } : {}),
  } }
}
