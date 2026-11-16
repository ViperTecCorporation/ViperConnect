import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { proto, type WaStore } from 'zapo-js'
import { closeAllSessionDatabases, openSessionDatabase, SessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { sqliteZapoHistoryReader } from '../../src/services/session_storage/native_backend'
import { createZapoStore } from '../../src/services/zapo/zapo_store'
import { consumeZapoHistoryBatches } from '../../src/services/zapo/zapo_history'

const phone = '999123456789', group = '123456@g.us', sender = '456789@lid'
let root: string, config: any, store: WaStore | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uno-sqlite-history-'))
  config = { baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'worker_1', generation: 2, state: 'offline', fixture: true } }
  openSessionDatabase(phone, config, { create: true })
})
afterEach(async () => { await store?.destroy(); store = undefined; closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }) })

async function seed(count: number, differentThreads = false) {
  // The synthetic fixture owns this connection for its complete lifetime; keep
  // SDK bulk inserts in one transaction without revalidating paths per row.
  const sdk = createSqliteStore({ connection: sqliteSdkConnection(openSessionDatabase(phone, config)) }), timestampMs = Date.now() - 3600000
  const records = Array.from({ length: count }, (_, index) => ({ id: `synthetic-${String(index).padStart(6, '0')}`, threadJid: differentThreads ? `${index + 100000}@lid` : group,
    fromMe: index % 2 === 0, participantJid: differentThreads ? undefined : sender, timestampMs,
    messageBytes: proto.Message.encode({ conversation: `synthetic-content-${index}` }).finish() }))
  await sdk.stores.messages(phone).upsertBatch(records)
  await sdk.stores.threads(phone).upsertBatch(differentThreads ? records.map(record => ({ jid: record.threadJid })) : [{ jid: group }])
  store = createZapoStore({ useRedis: false, baseStore: root, sqliteSession: { phone, config } })
  return { sdk, records, session: store.session(phone), db: openSessionDatabase(phone, config) }
}

test.each([251, 1253])('SQLite replay includes all %i messages, including a timestamp tie larger than the SDK page, in bounded callbacks', async count => {
  const f = await seed(count), ids = new Set<string>(), sizes: number[] = [], arrays = jest.spyOn(SessionDatabase.prototype, 'all')
  const threadList = jest.spyOn(f.session.threads, 'list'), messageList = jest.spyOn(f.session.messages, 'listByThread')
  const forwarded = await consumeZapoHistoryBatches(f.session, 7, async batch => {
    sizes.push(batch.length)
    for (const message of batch) {
      const index = Number(message.key.id.split('-')[1])
      expect(message.message.conversation).toBe(`synthetic-content-${index}`)
      expect(message.key).toMatchObject({ remoteJid: group, participant: sender, fromMe: index % 2 === 0 })
      expect(ids.has(message.key.id)).toBe(false); ids.add(message.key.id)
    }
  })
  expect(forwarded).toBe(count); expect(ids.size).toBe(count); expect(Math.max(...sizes)).toBeLessThanOrEqual(200)
  expect(threadList).not.toHaveBeenCalled(); expect(messageList).not.toHaveBeenCalled()
  const historyReads = arrays.mock.calls.filter(([sql]) => sql.includes('ORDER BY m.timestamp_ms ASC,m.message_id ASC LIMIT 201'))
  expect(historyReads).toHaveLength(Math.ceil(count / 200))
  arrays.mockRestore()
})

test('more than 10000 conversations are replayed without loading the bounded thread cache; expired/deleted/foreign messages stay excluded', async () => {
  const count = 10017, f = await seed(count, true), base = f.records[0]
  await f.sdk.stores.messages(phone).upsertBatch([
    { ...base, id: 'expired-native', timestampMs: Date.now() - 31 * 86400000 },
    { ...base, id: 'expired-deadline' }, { ...base, id: 'expired-bytes' }, { ...base, id: 'deleted' },
  ])
  await f.sdk.stores.messages('999123456788').upsert({ ...base, id: 'foreign' })
  f.db.exec('CREATE TABLE uno_native_tombstones(domain TEXT NOT NULL,record_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(domain,record_id))')
  f.db.run('INSERT INTO uno_native_tombstones VALUES(?,?,?)', ['msg', 'deleted', Date.now()])
  for (const id of ['expired-deadline', 'expired-bytes:message_bytes']) f.db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', id, Date.now() - 1])
  // Thread metadata is a cache: its absence/expiry must not hide valid messages.
  f.db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['thread', base.threadJid, Date.now() - 1])
  const list = jest.spyOn(f.session.threads, 'list'), ids = new Set<string>(), conversations = new Set<string>(), sizes: number[] = []
  const delivered = await consumeZapoHistoryBatches(f.session, 3650, async batch => {
    sizes.push(batch.length)
    for (const message of batch) { ids.add(message.key.id); conversations.add(message.key.remoteJid); expect(message.key.id).toMatch(/^synthetic-\d+$/) }
  })
  expect(delivered).toBe(count); expect(ids.size).toBe(count); expect(conversations.size).toBe(count)
  expect(Math.max(...sizes)).toBe(200); expect(list).not.toHaveBeenCalled()
  expect(f.db.get("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='auth_credentials'")).toBeUndefined()
})

test('callback failure confirms no IDs from the failed batch; retry skips only already acknowledged pages', async () => {
  const f = await seed(1253), acknowledged = new Set<string>(), sizes: number[] = []
  let attempt = 0
  await expect(consumeZapoHistoryBatches(f.session, 7, async batch => {
    if (++attempt === 2) throw new Error('synthetic-callback-failure')
    batch.forEach(message => acknowledged.add(message.key.id))
  }, acknowledged)).rejects.toThrow('synthetic-callback-failure')
  expect(acknowledged.size).toBe(200)
  const replayed = await consumeZapoHistoryBatches(f.session, 7, async batch => {
    sizes.push(batch.length)
    for (const message of batch) { expect(acknowledged.has(message.key.id)).toBe(false); acknowledged.add(message.key.id) }
  }, acknowledged)
  expect(replayed).toBe(1053); expect(acknowledged.size).toBe(1253); expect(Math.max(...sizes)).toBeLessThanOrEqual(200)
})

test('a replay uses a fixed upper clock boundary so new arrivals cannot extend the traversal indefinitely', async () => {
  const f = await seed(251), startedAt = Date.now(), ids = new Set<string>()
  let inserted = false
  const count = await consumeZapoHistoryBatches(f.session, 7, async batch => {
    batch.forEach(message => ids.add(message.key.id))
    if (!inserted) {
      inserted = true
      await f.sdk.stores.messages(phone).upsert({ ...f.records[0], id: 'new-arrival', timestampMs: startedAt + 1000 })
    }
  }, [], startedAt)
  expect(count).toBe(251); expect(ids.has('new-arrival')).toBe(false)
  expect(await consumeZapoHistoryBatches(f.session, 7, async () => {}, [], startedAt + 2000)).toBe(252)
})

test('empty databases yield no history and malformed internal cursors fail explicitly', async () => {
  const read = sqliteZapoHistoryReader(phone, config)
  expect(await read(0)).toEqual({ records: [] })
  await seed(1)
  await expect(read(0, { timestampMs: NaN, id: 'invalid' })).rejects.toThrow('history_cursor_invalid')
})

test('SQLite replay yields actual heartbeat I/O between pages even when callbacks resolve synchronously', async () => {
  const f = await seed(401)
  let consumed = 0, observed = -1
  const heartbeat = new Promise<void>(resolve => setImmediate(() => { observed = consumed; resolve() }))
  const count = await consumeZapoHistoryBatches(f.session, 7, async batch => { consumed += batch.length })
  await heartbeat
  expect(count).toBe(401)
  expect(observed).toBe(200)
})
