import { proto, type WaStoreSession, type WaStoredMessageRecord } from 'zapo-js'
import { normalizeHistoryMaxAgeDays } from '../../utils/history'

export { normalizeHistoryMaxAgeDays } from '../../utils/history'

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 1_000

export const toUnoHistoryMessage = (record: WaStoredMessageRecord) => {
  if (!record.id || !record.threadJid || !record.messageBytes?.length) return undefined
  return {
    key: {
      remoteJid: record.threadJid,
      id: record.id,
      fromMe: record.fromMe,
      ...(record.senderJid ? { participant: record.senderJid } : {}),
    },
    messageTimestamp: record.timestampMs ? Math.floor(record.timestampMs / 1_000) : undefined,
    message: proto.Message.decode(record.messageBytes),
  }
}

export const loadZapoHistoryMessages = async (
  store: WaStoreSession,
  maxAgeDays: unknown,
  seen: Set<string> = new Set(),
  nowMs = Date.now(),
) => {
  const cutoffMs = nowMs - normalizeHistoryMaxAgeDays(maxAgeDays) * DAY_MS
  const output: ReturnType<typeof toUnoHistoryMessage>[] = []
  const selectedIds = new Set(seen)
  const threads = await store.threads.list(10_000)

  for (const thread of threads) {
    let beforeTimestampMs: number | undefined
    while (true) {
      const records = await store.messages.listByThread(thread.jid, PAGE_SIZE, beforeTimestampMs)
      if (!records.length) break

      for (const record of records) {
        if (!record.timestampMs || record.timestampMs < cutoffMs || selectedIds.has(record.id)) continue
        const message = toUnoHistoryMessage(record)
        if (!message) continue
        selectedIds.add(record.id)
        output.push(message)
      }

      const oldestTimestamp = records[records.length - 1]?.timestampMs
      if (records.length < PAGE_SIZE || !oldestTimestamp || oldestTimestamp <= cutoffMs) break
      beforeTimestampMs = oldestTimestamp
    }
  }

  return output
    .filter((message): message is NonNullable<typeof message> => !!message)
    .sort((left, right) => Number(left.messageTimestamp || 0) - Number(right.messageTimestamp || 0))
}
