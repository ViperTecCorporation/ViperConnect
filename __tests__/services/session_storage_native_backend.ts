import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { proto } from 'zapo-js/proto'
import { decorateSqliteBackend, pruneSqliteNativeMailbox } from '../../src/services/session_storage/native_backend'
import { openSessionDatabase, closeSessionDatabase, closeAllSessionDatabases, getSessionSqlitePath } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { createZapoStore, zapoSqlitePath } from '../../src/services/zapo/zapo_store'

const phone = '5566999999999', jid = '12345@lid'
let root: string, config: any
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'uno-native-retention-')); config = { baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'active', fixture: true } }; openSessionDatabase(phone, config, { create: true }) })
afterEach(() => { closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }) })
const setup = () => { const native = createSqliteStore({ connection: sqliteSdkConnection(openSessionDatabase(phone, config)) }); return { native, decorated: decorateSqliteBackend(native, phone, config), db: openSessionDatabase(phone, config) } }
const message = (id = 'provider', stamp = Date.now()) => ({ id, threadJid: jid, fromMe: true, timestampMs: stamp, messageBytes: proto.Message.encode({ conversation: 'original' }).finish() })

test('writes a complete native mailbox record through the real SQLite SDK and caps retention on edit', async () => {
  const { decorated, native, db } = setup(), store = decorated.stores!.messages!(phone), old = message()
  await store.upsert(old); const deadline = Date.now() + 60000
  db.run('UPDATE uno_native_expiry SET expires_at=? WHERE domain=? AND record_id=?', [deadline, 'msg', old.id])
  await store.upsert({ ...old, timestampMs: old.timestampMs + 30000, messageBytes: proto.Message.encode({ conversation: 'edited' }).finish() })
  expect((await store.getById(old.id))?.timestampMs).toBe(old.timestampMs)
  expect(db.get('SELECT expires_at FROM uno_native_expiry WHERE domain=? AND record_id=?', ['msg', old.id])?.expires_at).toBe(deadline)
  expect(proto.Message.decode((await native.stores.messages(phone).getById(old.id))!.messageBytes!).conversation).toBe('edited')
})
test('filters expired data before page limit and never rejuvenates an imported message', async () => {
  const { decorated, db } = setup(), store = decorated.stores!.messages!(phone)
  await store.upsertBatch([message('expired'), message('alive', Date.now() - 100)])
  db.run('UPDATE uno_native_expiry SET expires_at=1 WHERE domain=? AND record_id=?', ['msg', 'expired'])
  expect(await store.getById('expired')).toBeNull()
  expect((await store.listByThread(jid, 1)).map(record => record.id)).toEqual(['alive'])
  await store.upsert(message('expired')); expect(await store.getById('expired')).toBeNull()
  expect(pruneSqliteNativeMailbox(phone, config)).toBe(1)
  await store.upsert(message('expired')); expect(await store.getById('expired')).toBeNull()
})
test('preserves sender and group participant, refuses another thread or author, and caps large queries', async () => {
  const { decorated } = setup(), store = decorated.stores!.messages!(phone), old = { ...message(), threadJid: '123@g.us', participantJid: jid }
  await store.upsert(old)
  await expect(store.upsert({ ...old, participantJid: 'foreign@lid' })).rejects.toThrow('identity_conflict')
  await expect(store.upsert({ ...old, fromMe: false })).rejects.toThrow('identity_conflict')
  await expect(store.upsert({ ...old, threadJid: '456@g.us' })).rejects.toThrow('identity_conflict')
  expect((await store.listByThread('123@g.us', 100000)).length).toBe(1)
  expect(() => decorated.stores!.messages!('5511999999999')).toThrow('scope_mismatch')
})
test('edit and revoke overlays preserve original media bytes and expire with original message', async () => {
  const { decorated, db } = setup(), store = decorated.stores!.messages!(phone)
  const original = { ...message(), messageBytes: proto.Message.encode({ imageMessage: { caption: 'old', mediaKey: Buffer.alloc(32, 128), directPath: '/original' } }).finish() }
  await store.upsert(original)
  await store.upsert({ ...message('edit'), messageBytes: proto.Message.encode({ protocolMessage: { key: { id: original.id, remoteJid: jid, fromMe: true }, editedMessage: { imageMessage: { caption: 'new' } } } }).finish() })
  let state = JSON.parse(db.getValue(`unoapi:zapo:panel:${phone}:state:${original.id}`)!.toString())
  expect(state).toMatchObject({ edited: true, text: 'new' }); expect(Buffer.from((await store.getById(original.id))!.messageBytes!)).toEqual(Buffer.from(original.messageBytes))
  await store.upsert({ ...message('revoke'), messageBytes: proto.Message.encode({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: original.id, remoteJid: jid, fromMe: true } } }).finish() })
  state = JSON.parse(db.getValue(`unoapi:zapo:panel:${phone}:state:${original.id}`)!.toString())
  expect(state).toMatchObject({ type: 'revoked', text: 'Mensagem removida', media: null })
})
test('delete marks a tombstone without destroying historical bytes or UnoID mappings', async () => {
  const { decorated, native, db } = setup(), store = decorated.stores!.messages!(phone)
  await store.upsert(message()); db.putValue(`unoapi-id:${phone}:provider`, 'uno')
  expect(await store.deleteById('provider')).toBe(1); expect(await store.getById('provider')).toBeNull()
  expect(await native.stores.messages(phone).getById('provider')).not.toBeNull(); expect(db.getValue(`unoapi-id:${phone}:provider`)?.toString()).toBe('uno')
  await store.clear(); expect(await native.stores.messages(phone).getById('provider')).toBeNull()
  expect(db.getValue(`unoapi-id:${phone}:provider`)?.toString()).toBe('uno')
})
test('contacts and thread TTLs work with phone fallback and can be refreshed only by real writes', async () => {
  const { decorated, db } = setup(), contacts = decorated.stores!.contacts!(phone), threads = decorated.stores!.threads!(phone)
  await contacts.upsert({ jid, phoneNumber: '5511999999999', displayName: 'Nome', username: 'usuario', lastUpdatedMs: Date.now() })
  await threads.upsert({ jid, name: 'Conversa' })
  db.run('UPDATE uno_native_expiry SET expires_at=1 WHERE domain IN (?,?)', ['contact', 'thread'])
  expect(await contacts.getByPhoneNumber('5511999999999')).toBeNull(); expect(await threads.getByJid(jid)).toBeNull()
  await contacts.upsert({ jid, lastUpdatedMs: Date.now(), pushName: 'Novo' }); expect((await contacts.getByJid(jid))?.username).toBe('usuario')
  await threads.upsert({ jid, name: 'Atualizada' }); expect((await threads.list(100000)).length).toBe(1)
})

test('SDK uses the public shared connection getter and reopens after LRU eviction without losing bytes or IDs', async () => {
  const connection = sqliteSdkConnection(() => openSessionDatabase(phone, config))
  const native = createSqliteStore({ connection }), messages = native.stores.messages(phone)
  const original = { ...message(), threadJid: '123@g.us', participantJid: jid }
  await messages.upsert(original)
  openSessionDatabase(phone, config).putValue(`unoapi-id:${phone}:provider`, 'immutable-uno')
  closeSessionDatabase(getSessionSqlitePath(phone, config))
  expect(await messages.getById(original.id)).toMatchObject({ ...original, messageBytes: new Uint8Array(original.messageBytes) })
  expect(openSessionDatabase(phone, config).getValue(`unoapi-id:${phone}:provider`)?.toString()).toBe('immutable-uno')
  await messages.upsertBatch([{ ...original, id: 'second' }])
  closeSessionDatabase(getSessionSqlitePath(phone, config))
  expect(await messages.getById('second')).toMatchObject({ ...original, id: 'second', messageBytes: new Uint8Array(original.messageBytes) })
})

test('the actual Zapo factory reuses the patched per-session engine after an evicted connection', async () => {
  const store = createZapoStore({ useRedis: false, baseStore: root, sqlitePath: getSessionSqlitePath(phone, config), sqliteSession: { phone, config } })
  const address = { user: '12345', server: 'lid', device: 1 }, identity = new Uint8Array(33).fill(128)
  try {
    const session = store.session(phone)
    await session.identity.setRemoteIdentity(address, identity)
    closeSessionDatabase(getSessionSqlitePath(phone, config))
    expect(await session.identity.getRemoteIdentity(address)).toEqual(identity)
    expect(openSessionDatabase(phone, config).get('SELECT sqlite_version() AS version')?.version).toMatch(/^3\.\d+\.\d+$/)
  } finally { await store.destroy() }
})

test('legacy SQLite mode also uses the guarded Node connection and closes its caller-owned lifecycle', async () => {
  const store = createZapoStore({ useRedis: false, baseStore: root }), address = { user: '12345', server: 'lid', device: 1 }, identity = new Uint8Array(33).fill(129)
  await store.session(phone).identity.setRemoteIdentity(address, identity)
  await store.destroy()
  const { SessionDatabase } = require('../../src/services/session_storage/database'), db = new SessionDatabase(zapoSqlitePath(root))
  try { expect(Buffer.from(db.get('SELECT identity_key FROM signal_identity')?.identity_key)).toEqual(Buffer.from(identity)) }
  finally { db.close() }
})

test('metadata-only notifications run after durable commit and never disclose message bytes', async () => {
  const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) }), events: any[] = []
  const decorated = decorateSqliteBackend(native, phone, config, (owner, conversation, id) => {
    if (id) expect(db.get('SELECT message_id FROM mailbox_messages WHERE session_id=? AND message_id=?', [owner, id])?.message_id).toBe(id)
    events.push({ phone: owner, conversation_id: conversation, ...(id ? { id } : {}) })
  }), store = decorated.stores!.messages!(phone)
  await store.upsert(message()); await store.deleteById('provider')
  expect(events).toEqual([{ phone, conversation_id: jid, id: 'provider' }, { phone, conversation_id: jid, id: 'provider' }])
  expect(JSON.stringify(events)).not.toContain('original'); expect(JSON.stringify(events)).not.toContain('messageBytes')
})
test('a failed change notification cannot roll back a successfully persisted message', async () => {
  const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) })
  const decorated = decorateSqliteBackend(native, phone, config, async () => { throw new Error('synthetic bus unavailable') }), store = decorated.stores!.messages!(phone)
  await expect(store.upsert(message())).resolves.toBeUndefined()
  expect(await store.getById('provider')).not.toBeNull()
})
test('decorated stores forward SDK destroy lifecycle instead of leaking native SQLite connection references', async () => {
  const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) })
  const stores = { messages: native.stores.messages(phone), contacts: native.stores.contacts(phone), threads: native.stores.threads(phone) }
  const destroy = Object.fromEntries(Object.entries(stores).map(([name, value]) => [name, jest.spyOn(value, 'destroy')]))
  const decorated = decorateSqliteBackend({ ...native, stores: { ...native.stores, messages: () => stores.messages, contacts: () => stores.contacts, threads: () => stores.threads } }, phone, config)
  for (const name of ['messages', 'contacts', 'threads'] as const) await (decorated.stores![name]!(phone) as any).destroy()
  for (const name of ['messages', 'contacts', 'threads']) expect(destroy[name]).toHaveBeenCalledTimes(1)
})

test.each(['messages', 'contacts', 'threads'] as const)('%s bulk persistence permits real heartbeat I/O between committed pages', async domain => {
  const { decorated, db } = setup(), count = 401, store = decorated.stores![domain]!(phone), table = `mailbox_${domain}`
  const records: any[] = Array.from({ length: count }, (_, index) => domain === 'messages'
    ? message(`message-${index}`) : { jid: `${index + 10000}@lid`, lastUpdatedMs: Date.now(), name: 'synthetic', displayName: 'synthetic' })
  let observed = -1
  const heartbeat = new Promise<void>(resolve => setImmediate(() => { observed = Number(db.get(`SELECT COUNT(*) n FROM ${table}`)?.n); resolve() }))
  await store.upsertBatch(records)
  await heartbeat
  expect(observed).toBeGreaterThanOrEqual(200)
  expect(observed).toBeLessThan(count)
  expect(db.get(`SELECT COUNT(*) n FROM ${table}`)?.n).toBe(count)
})

test('bounded pruning expires imported byte deadlines without changing live messages or historical mappings', async () => {
  const { decorated, db } = setup(), store = decorated.stores!.messages!(phone)
  await store.upsertBatch([message('expired-bytes'), message('alive')])
  db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', 'expired-bytes:message_bytes', 1])
  db.putValue(`unoapi-id:${phone}:expired-bytes`, 'historical-uno')
  expect(pruneSqliteNativeMailbox(phone, config, Date.now(), 1)).toBe(1)
  expect(await store.getById('expired-bytes')).toBeNull()
  expect(await store.getById('alive')).not.toBeNull()
  expect(db.getValue(`unoapi-id:${phone}:expired-bytes`)?.toString()).toBe('historical-uno')
})
