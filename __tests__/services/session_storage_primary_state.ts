import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { createSqliteStore, ensureSqliteMigrations } from '@zapo-js/store-sqlite'
import { proto } from 'zapo-js'
import type { Config } from '../../src/services/config'
import { createSqliteHistoryIndex, primaryAuthStore } from '../../src/services/session_storage/primary_state'
import { openSessionDatabase, closeAllSessionDatabases, type SessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { streamCompanionHistory } from '../../src/services/mobile_primary/companion_history_stream'
import { historyThreads } from '../../src/services/mobile_primary/companion_history_index'

const phone = '999123456789', jid = '123456789@lid', prefix = 'unoapi:zapo:'
const originalRole = process.env.UNOAPI_PROCESS_ROLE, originalOwner = process.env.UNOAPI_STORAGE_WORKER_ID
let root: string, config: Config, db: SessionDatabase, sdk: ReturnType<typeof createSqliteStore>
beforeEach(async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'primary-state-test'
  root = mkdtempSync(join(tmpdir(), 'uno-primary-state-test-'))
  config = { baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'primary-state-test', generation: 1, state: 'active', fixture: true } } as Config
  db = openSessionDatabase(phone, config, { create: true })
  const connection = sqliteSdkConnection(db)
  await ensureSqliteMigrations(connection, ['mailbox'])
  sdk = createSqliteStore({ connection })
})
afterEach(() => {
  closeAllSessionDatabases()
  if (!root || !resolve(root).startsWith(resolve(tmpdir())) || !root.includes('uno-primary-state-test-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
  if (originalRole === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = originalRole
  if (originalOwner === undefined) delete process.env.UNOAPI_STORAGE_WORKER_ID; else process.env.UNOAPI_STORAGE_WORKER_ID = originalOwner
})
async function message(id: string, thread = jid, timestampMs = Date.now() - 10000, content: any = { conversation: id }, session = phone) {
  await sdk.stores.messages(session).upsert({ id, threadJid: thread, fromMe: true, timestampMs, messageBytes: proto.Message.encode(content).finish() })
}

test('SQLite history index discovers conversations without native thread rows and remains session scoped', async () => {
  await message('A'); await message('B', '22222222@lid'); await message('FOREIGN', '33333333@lid', undefined, undefined, '999000000000')
  const index = createSqliteHistoryIndex(phone, config, prefix)
  const first = await index.scan(0, { MATCH: `${prefix}msg:idx:${phone}:*`, COUNT: 1 })
  expect(first).toEqual({ cursor: 1, keys: [`${prefix}msg:idx:${phone}:${jid}`] })
  const second = await index.scan(first.cursor, { MATCH: `${prefix}msg:idx:${phone}:*`, COUNT: 1 })
  expect(second).toEqual({ cursor: 0, keys: [`${prefix}msg:idx:${phone}:22222222@lid`] })
  const store: any = { threads: sdk.stores.threads(phone) }
  expect((await historyThreads(store, index, prefix, phone)).map(t => t.jid)).toEqual([jid, '22222222@lid'])
})

test('virtual sorted-set range preserves ascending timestamp and ID ties in bounded batches', async () => {
  const stamp = Date.now() - 10000
  await message('C', jid, stamp); await message('A', jid, stamp); await message('B', jid, stamp)
  const index = createSqliteHistoryIndex(phone, config, prefix), key = `${prefix}msg:idx:${phone}:${jid}`
  expect(await index.zRange(key, 0, 1)).toEqual(['A', 'B'])
  expect(await index.zRange(key, 2, 3)).toEqual(['C'])
})

test('history shim honors native earlier header or byte expiration and original retention', async () => {
  await message('VALID'); await message('EXPIRED_HEADER'); await message('EXPIRED_BYTES'); await message('OLD', jid, Date.now() - 40 * 86400000)
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['msg', 'EXPIRED_HEADER', 1])
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['msg', 'EXPIRED_BYTES:message_bytes', 1])
  const index = createSqliteHistoryIndex(phone, config, prefix)
  expect(await index.zRange(`${prefix}msg:idx:${phone}:${jid}`, 0, 19)).toEqual(['VALID'])
})

test('index rejects foreign namespaces, unbounded requests and malformed cursors', async () => {
  const index = createSqliteHistoryIndex(phone, config, prefix)
  await expect(index.scan(0, { MATCH: `${prefix}msg:idx:999000000000:*`, COUNT: 20 })).rejects.toThrow('history_index_scope_invalid')
  await expect(index.scan(-1, { MATCH: `${prefix}msg:idx:${phone}:*`, COUNT: 20 })).rejects.toThrow('history_index_scope_invalid')
  await expect(index.scan(0, { MATCH: `${prefix}msg:idx:${phone}:*`, COUNT: 100000 })).rejects.toThrow('history_index_scope_invalid')
  await expect(index.zRange(`${prefix}msg:idx:${phone}:${jid}`, 0, 100000)).rejects.toThrow('history_index_scope_invalid')
  await expect(index.zRange(`${prefix}msg:idx:${phone}:status@broadcast`, 0, 19)).rejects.toThrow('history_index_scope_invalid')
  await expect(index.zRange(`${prefix}msg:idx:999000000000:${jid}`, 0, 19)).rejects.toThrow('history_index_scope_invalid')
})

test('legacy prefix maps to the native effective prefix for both export and thread discovery', async () => {
  await message('A')
  const index = createSqliteHistoryIndex(phone, config, 'unoapi-zapo:')
  expect((await historyThreads({ threads: sdk.stores.threads(phone) } as any, index, 'unoapi-zapo:', phone))[0].jid).toBe(jid)
})

test('existing history exporter streams actual SQLite native rows without a client or Redis', async () => {
  const stamp = Date.now() - 10000
  for (let i = 0; i < 41; i++) await message(String(i).padStart(3, '0'), jid, stamp + i)
  await sdk.stores.contacts(phone).upsert({ jid, lid: jid, phoneNumber: '999123456780', displayName: 'Synthetic contact', lastUpdatedMs: stamp })
  const index = createSqliteHistoryIndex(phone, config, prefix), store: any = { threads: sdk.stores.threads(phone), contacts: sdk.stores.contacts(phone), messages: sdk.stores.messages(phone) }
  const packets = []
  for await (const packet of streamCompanionHistory(store, index, prefix, phone, 'text-video')) packets.push(packet)
  expect(packets.reduce((sum, packet) => sum + packet.count, 0)).toBe(41)
  const rows = packets.flatMap(packet => proto.HistorySync.decode(inflateSync(packet.message.historySyncNotification!.initialHistBootstrapInlinePayload!)).conversations.flatMap(c => c.messages.map(m => m.message!.key!.id!)))
  expect(rows).toEqual(Array.from({ length: 41 }, (_, i) => String(i).padStart(3, '0')))
  expect(await sdk.stores.messages(phone).getById('000')).not.toBeNull()
  expect(db.get('SELECT COUNT(*) n FROM mailbox_messages')?.n).toBe(41)
})

test('SQLite export keeps tombstone privacy without deleting or rewriting source messages', async () => {
  await message('ORIGINAL'); await message('DELETE', jid, Date.now() - 5000, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'ORIGINAL' } } })
  await message('KEEP', jid, Date.now() - 4000)
  const store: any = { threads: sdk.stores.threads(phone), contacts: sdk.stores.contacts(phone), messages: sdk.stores.messages(phone) }
  const packets = []
  for await (const packet of streamCompanionHistory(store, createSqliteHistoryIndex(phone, config, prefix), prefix, phone)) packets.push(packet)
  const ids = packets.flatMap(packet => proto.HistorySync.decode(inflateSync(packet.message.historySyncNotification!.initialHistBootstrapInlinePayload!)).conversations.flatMap(c => c.messages.map(m => m.message!.key!.id!)))
  expect(ids).toEqual(['KEEP'])
  expect(db.get('SELECT COUNT(*) n FROM mailbox_messages')?.n).toBe(3)
})

test('a missing or foreign-owner SQLite path does not create a new archive', () => {
  expect(() => createSqliteHistoryIndex(phone, { ...config, sessionStorage: { ...config.sessionStorage!, owner: 'other' } }, prefix)).toThrow('session_storage_wrong_owner')
  expect(() => createSqliteHistoryIndex(phone, { ...config, sessionStorage: { ...config.sessionStorage!, storageId: randomUUID() } }, prefix)).toThrow('database_missing')
  expect(() => createSqliteHistoryIndex(phone, { ...config, sessionStorage: undefined }, prefix)).toThrow('session_storage_sqlite_required')
})

test('HTTP-side SQLite auth uses only private owner RPC and preserves bytes and generation', async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'web'
  const creds: any = { meJid: '999123456789@s.whatsapp.net', noiseKeyPair: { pubKey: Buffer.from('synthetic public') } }
  const local = jest.fn(() => { throw new Error('must_not_open_local_volume') })
  const rpc = jest.fn().mockResolvedValueOnce(creds).mockResolvedValueOnce(undefined)
  const mutation = { draftId: randomUUID(), fence: { key: `unoapi-lease:zapo-session:${phone}`, token: randomUUID() },
    selection: { backend: 'sqlite' as const, owner: config.sessionStorage!.owner, storageId: config.sessionStorage!.storageId, generation: config.sessionStorage!.generation } }
  const auth = primaryAuthStore(phone, config, local, rpc, mutation)
  expect(await auth.load()).toBe(creds); await auth.save(creds)
  expect(rpc).toHaveBeenNthCalledWith(1, phone, config, 'primary.auth.load', [])
  expect(rpc).toHaveBeenNthCalledWith(2, phone, config, 'primary.auth.save', [creds, mutation])
  expect(local).not.toHaveBeenCalled()
  await expect(auth.clear()).rejects.toThrow('explicit_logout')
})

test('SQLite auth writes without an explicit current socket fence fail before owner RPC', async () => {
  const local = jest.fn(), rpc = jest.fn()
  await expect(primaryAuthStore(phone, config, local, rpc).save({} as any)).rejects.toThrow('primary_auth_lease_required')
  expect(local).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled()
})

test('new Redis Primary imports also use owner RPC with the selected receipt, not HTTP-side native storage', async () => {
  const selected = { backend: 'redis' as const, owner: 'worker_1', generation: 0, provisionId: randomUUID() }
  const mutation = { draftId: randomUUID(), fence: { key: `unoapi-lease:zapo-session:${phone}`, token: randomUUID() }, selection: selected }
  const local = jest.fn(), rpc = jest.fn().mockResolvedValue(undefined)
  const credentials = { meJid: `${phone}@s.whatsapp.net` } as any
  await primaryAuthStore(phone, { ...config, sessionStorage: undefined }, local, rpc, mutation).save(credentials)
  expect(rpc).toHaveBeenCalledWith(phone, expect.anything(), 'primary.auth.save', [credentials, mutation]); expect(local).not.toHaveBeenCalled()
})

test('private auth RPC failure has no local fallback or implicit clearing', async () => {
  const local = jest.fn(), rpc = jest.fn().mockRejectedValue(new Error('worker_offline'))
  const auth = primaryAuthStore(phone, config, local, rpc)
  await expect(auth.load()).rejects.toThrow('worker_offline')
  expect(local).not.toHaveBeenCalled(); expect(rpc).toHaveBeenCalledTimes(1)
})

test('Redis primary import retains the existing local auth store contract', async () => {
  const localAuth: any = { load: jest.fn(), save: jest.fn(), clear: jest.fn() }, local = jest.fn(() => localAuth), rpc = jest.fn()
  expect(primaryAuthStore(phone, { ...config, sessionStorage: undefined }, local, rpc)).toBe(localAuth)
  expect(local).toHaveBeenCalledTimes(1); expect(rpc).not.toHaveBeenCalled()
})
