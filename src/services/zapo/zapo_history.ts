import { proto, type WaStoreSession, type WaStoredMessageRecord } from 'zapo-js'
import { normalizeHistoryMaxAgeDays } from '../../utils/history'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

export { normalizeHistoryMaxAgeDays } from '../../utils/history'

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 1_000
const FORWARD_BATCH_SIZE = 200
export type ZapoHistoryCursor = { timestampMs: number; id: string }
export type ZapoHistoryPage = { records: readonly WaStoredMessageRecord[]; next?: ZapoHistoryCursor }
export type ZapoHistoryReader = (cutoffMs: number, cursor?: ZapoHistoryCursor, untilMs?: number) => Promise<ZapoHistoryPage>
const historyReaders = new WeakMap<WaStoreSession, ZapoHistoryReader>()

/** Explicit adapter capability: the SDK's lock wrappers intentionally expose
 * only its official timestamp-only API, which cannot page timestamp ties. */
export const registerZapoHistoryReader = (store: WaStoreSession, reader: ZapoHistoryReader) => { historyReaders.set(store, reader) }

export const toUnoHistoryMessage = (record: WaStoredMessageRecord) => {
  if (!record.id || !record.threadJid || !record.messageBytes?.length) return undefined
  const participantJid = record.participantJid || record.senderJid
  return {
    key: {
      remoteJid: record.threadJid,
      id: record.id,
      fromMe: record.fromMe,
      ...(participantJid ? { participant: participantJid } : {}),
    },
    messageTimestamp: record.timestampMs ? Math.floor(record.timestampMs / 1_000) : undefined,
    message: proto.Message.decode(record.messageBytes),
  }
}

const loadLegacyZapoHistoryMessages = async (
  store: WaStoreSession,
  maxAgeDays: unknown,
  seen: Iterable<string> = [],
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

/** SQLite history is read and delivered one bounded page at a time. A page's
 * IDs are acknowledged by the caller only after its callback has succeeded.
 * Redis keeps its existing official-store traversal/order and is delivered in
 * bounded callbacks; its legacy materialization is intentionally unchanged. */
export const consumeZapoHistoryBatches = async (
  store: WaStoreSession,
  maxAgeDays: unknown,
  consume: (messages: NonNullable<ReturnType<typeof toUnoHistoryMessage>>[]) => Promise<void>,
  seen: Iterable<string> = [],
  nowMs = Date.now(),
) => {
  const reader = historyReaders.get(store)
  if (!reader) {
    const messages = await loadLegacyZapoHistoryMessages(store, maxAgeDays, seen, nowMs)
    for (let offset = 0; offset < messages.length; offset += FORWARD_BATCH_SIZE) await consume(messages.slice(offset, offset + FORWARD_BATCH_SIZE))
    return messages.length
  }
  const cutoff = nowMs - normalizeHistoryMaxAgeDays(maxAgeDays) * DAY_MS, selected = new Set(seen)
  let cursor: ZapoHistoryCursor | undefined, count = 0
  while (true) {
    const page = await reader(cutoff, cursor, nowMs)
    if (page.records.length > FORWARD_BATCH_SIZE) throw new Error('zapo_history_page_too_large')
    const batch: NonNullable<ReturnType<typeof toUnoHistoryMessage>>[] = []
    for (const record of page.records) {
      if (!record.timestampMs || record.timestampMs < cutoff || selected.has(record.id)) continue
      const message = toUnoHistoryMessage(record)
      if (message) batch.push(message)
    }
    if (batch.length) { await consume(batch); count += batch.length }
    if (!page.next) break
    if (cursor && (page.next.timestampMs < cursor.timestampMs || page.next.timestampMs === cursor.timestampMs && page.next.id <= cursor.id)) throw new Error('zapo_history_cursor_not_advancing')
    cursor = page.next
    await yieldToEventLoop()
  }
  return count
}

/** Compatibility collector. Runtime replay uses consumeZapoHistoryBatches,
 * not this all-in-memory helper. */
export const loadZapoHistoryMessages = async (store: WaStoreSession, maxAgeDays: unknown, seen: Iterable<string> = [], nowMs = Date.now()) => {
  const output: NonNullable<ReturnType<typeof toUnoHistoryMessage>>[] = []
  await consumeZapoHistoryBatches(store, maxAgeDays, async batch => { output.push(...batch) }, seen, nowMs)
  return output.sort((left, right) => Number(left.messageTimestamp || 0) - Number(right.messageTimestamp || 0))
}
