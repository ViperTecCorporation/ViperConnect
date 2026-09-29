import type { WaStoreSession, WaStoredThreadRecord } from 'zapo-js'
/** Zapo 1.9.0 mailbox writes message indexes but does not create thread rows.
 * Read only the session's message-index keys; never scan values or auth keys.
 * Adapter is intentionally scoped to the Redis-backed laboratory. */
export async function historyThreads(store: WaStoreSession, redis: { scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number; keys: string[] }> }, prefix: string, phone: string) {
  if (!/^[A-Za-z0-9_:]+$/.test(prefix) || !/^[1-9]\d{7,14}$/.test(phone)) throw new Error('history_index_scope_invalid')
  const threads = new Map<string, WaStoredThreadRecord>((await store.threads.list(50)).map(t => [t.jid, t]))
  const start = `${prefix}msg:idx:${phone}:`
  let cursor = 0, pages = 0
  do {
    const page = await redis.scan(cursor, { MATCH: start + '*', COUNT: 500 })
    cursor = page.cursor; pages++
    for (const key of page.keys) {
      if (!key.startsWith(start) || threads.size >= 50) continue
      const jid = key.slice(start.length)
      if (!/^\d+(@(lid|s\.whatsapp\.net)|-?\d*@g\.us)$/.test(jid) || threads.has(jid)) continue
      const thread = await store.threads.getByJid(jid)
      threads.set(jid, thread || { jid })
    }
  } while (cursor !== 0 && pages < 100 && threads.size < 50)
  return [...threads.values()]
}
