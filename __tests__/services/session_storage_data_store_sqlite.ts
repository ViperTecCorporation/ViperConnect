import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { proto } from 'zapo-js/proto'
import type { Config } from '../../src/services/config'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { openSessionDatabase, closeAllSessionDatabases, getSessionSqlitePath } from '../../src/services/session_storage/database'

const phone = '5566999999999', jid = '123456789012@lid', group = '123@g.us', participant = '99999@lid'
let root: string, config: Config
let oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => { oldEnvironment = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'server_1'; delete process.env.UNOAPI_STORAGE_WORKER_ID; root = mkdtempSync(join(tmpdir(), 'uno-datastore-sqlite-')); config = { baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'active', fixture: true } } as Config; openSessionDatabase(phone, config, { create: true }) })
afterEach(() => { closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }); process.env = oldEnvironment })
const message = (type = 'conversation', id = 'provider') => ({ key: { id, remoteJid: jid, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: type === 'conversation' ? { conversation: 'original' } : { [type]: { caption: 'legenda', url: 'https://invalid.test/media', mediaKey: Buffer.from([255, 0, 128]), directPath: '/media' }, messageContextInfo: { messageSecret: Buffer.from([0, 128, 255]) } } }) as any

test('chooses the same immutable UnoID under concurrency and preserves reverse mapping', async () => {
  const store = await getDataStoreSqlite(phone, config)
  const chosen = await Promise.all(Array.from({ length: 30 }, (_, i) => store.setUnoId('provider', `uno-${i}`)))
  expect(new Set(chosen).size).toBe(1); expect(chosen[0]).toBe('uno-0')
  expect(await store.loadProviderId('uno-0')).toBe('provider'); expect(await store.loadUnoId('provider')).toBe('uno-0')
  await expect(store.setUnoId('another-provider', 'uno-0')).rejects.toThrow('id_conflict')
})
test.each(['conversation', 'imageMessage', 'videoMessage', 'documentMessage'])('roundtrips complete %s content including media keys and original IDs', async type => {
  const store = await getDataStoreSqlite(phone, config), original = message(type)
  await store.setMessage(jid, original); await store.setUnoId('provider', 'uno'); await store.setKey('provider', original.key)
  const loaded = await store.loadMessageExact!(jid, 'uno')
  expect(Buffer.from(proto.WebMessageInfo.encode(loaded).finish())).toEqual(Buffer.from(proto.WebMessageInfo.encode(original).finish()))
  expect(await store.loadKey('uno')).toEqual(original.key)
  if (type !== 'conversation') expect((await store.findMessageWithSecret!('uno', [jid]))?.message.messageContextInfo.messageSecret).toEqual(Buffer.from([0, 128, 255]))
})
test('preserves group participant and refuses an author substitution', async () => {
  const store = await getDataStoreSqlite(phone, config), original = message('imageMessage'); original.key = { ...original.key, remoteJid: group, participant }
  await store.setMessage(group, original)
  expect((await store.loadMessageExact!(group, 'provider'))?.key.participant).toBe(participant)
  await expect(store.setMessage(group, { ...original, key: { ...original.key, participant: 'foreign@lid' } })).rejects.toThrow('author_conflict')
  await expect(store.setMessage(group, { ...original, key: { ...original.key, fromMe: false } })).rejects.toThrow('author_conflict')
})
test('edits and statuses do not extend original absolute retention', async () => {
  const store = await getDataStoreSqlite(phone, config), original = message(), db = openSessionDatabase(phone, config), key = `unoapi-message:${phone}:${jid}:provider`
  await store.setMessage(jid, original); db.run('UPDATE uno_kv SET expires_at=? WHERE key=?', [Date.now() + 60000, key]); const previous = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [key])!.expires_at
  await store.setKey('provider', original.key); await store.setMessage(jid, { ...original, message: { conversation: 'edited' }, messageTimestamp: original.messageTimestamp + 30 }); await store.setStatus('provider', 'read')
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [key])?.expires_at).toBe(previous)
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-message-status:${phone}:provider`])?.expires_at).toBe(previous)
})
test('new mapping deadlines cover associated messages while imported mapping TTL stays unchanged', async () => {
  const store = await getDataStoreSqlite(phone, config), db = openSessionDatabase(phone, config)
  await store.setUnoId('provider', 'uno'); const mapping = `unoapi-id:${phone}:provider`, reverse = `unoapi-id_rev:${phone}:uno`, originalExpiry = Date.now() + 60000
  db.run('UPDATE uno_kv SET expires_at=? WHERE key IN (?,?)', [originalExpiry, mapping, reverse])
  await store.setMessage(jid, message())
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [mapping])?.expires_at).toBeGreaterThan(originalExpiry)
  expect(Number(db.get("SELECT value FROM uno_storage_meta WHERE key='mapping_retention_extensions'")?.value)).toBe(2)
  db.exec('CREATE TABLE uno_redis_types(key TEXT PRIMARY KEY,type TEXT NOT NULL,expires_at INTEGER)')
  db.run('INSERT INTO uno_redis_types VALUES(?,?,?)', [mapping, 'string', originalExpiry]); db.run('INSERT INTO uno_redis_types VALUES(?,?,?)', [reverse, 'string', originalExpiry])
  db.run('UPDATE uno_kv SET expires_at=? WHERE key IN (?,?)', [originalExpiry, mapping, reverse])
  await store.setMessage(jid, message()); expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [mapping])?.expires_at).toBe(originalExpiry)
})
test('mapping created after persisted message uses its retained deadline and does not mutate the message', async () => {
  const store = await getDataStoreSqlite(phone, config), db = openSessionDatabase(phone, config), original = message()
  await store.setMessage(jid, original); await store.setKey('provider', original.key)
  const previous = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-message:${phone}:${jid}:provider`])?.expires_at
  await store.setUnoId('provider', 'uno')
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-id:${phone}:provider`])?.expires_at).toBeGreaterThanOrEqual(previous)
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-message:${phone}:${jid}:provider`])?.expires_at).toBe(previous)
})
test('missing and third-party messages are preserved as facts, never fabricated as own messages', async () => {
  const store = await getDataStoreSqlite(phone, config); expect(await store.loadMessage(jid, 'missing')).toBeUndefined()
  const original = message(); original.key.fromMe = false; await store.setMessage(jid, original)
  expect((await store.loadMessage(jid, 'provider'))?.key.fromMe).toBe(false)
})
test('isolates session records and secrets in separate files', async () => {
  const store = await getDataStoreSqlite(phone, config); await store.setMessage(jid, message('imageMessage'))
  const c = { ...config, sessionStorage: { ...(config as any).sessionStorage, storageId: randomUUID() } }; openSessionDatabase('5511999999999', c, { create: true })
  const other = await getDataStoreSqlite('5511999999999', c); expect(await other.findMessageWithSecret!('provider', [jid])).toBeUndefined()
  await expect(store.getPnForLid!('5511999999999', jid)).rejects.toThrow('scope_mismatch')
})
test('supports all auxiliary DataStore operations and keeps history on disconnect', async () => {
  const s = await getDataStoreSqlite(phone, config), pn = '5511999999999@s.whatsapp.net'
  await s.setJidMapping!(phone, pn, jid); expect(await s.getPnForLid!(phone, jid)).toBe(pn); expect(await s.getLidForPn!(phone, pn)).toBe(jid)
  await s.setContactInfo!(jid, { name: 'Nome', username: 'user' }); expect((await s.getContactInfo!(pn))?.name).toBe('Nome')
  await s.setContactName!(jid, 'alias'); expect(await s.getContactName!(jid)).toBe('Nome')
  await s.setImageUrl(jid, 'https://invalid.test/photo'); expect(await s.getImageUrl(pn)).toBe('https://invalid.test/photo'); await s.removeImageUrl!(pn); expect(await s.getImageUrl(jid)).toBeUndefined()
  await s.setJid(pn, jid); await s.setJidIfNotFound(pn, 'wrong@lid'); expect(await s.getJid(pn)).toBe(jid)
  await s.setMediaPayload('media', { bytes: [1, 2] }); expect(await s.loadMediaPayload('media')).toEqual({ bytes: [1, 2] })
  await s.setGroupMetada(group, { id: group, subject: 'Grupo', participants: [] } as any); expect((await s.getGroupMetada(group))?.subject).toBe('Grupo')
  await s.setLastIncomingKey!(jid, message().key); expect((await s.getLastIncomingKey!(jid))?.id).toBe('provider')
  await s.setTemplates([{ name: 'custom' }]); expect(await s.loadTemplates()).toEqual([{ name: 'custom' }])
  await s.setMessage(jid, message()); await s.cleanSession(true)
  expect(await s.loadMessage(jid, 'provider')).toBeDefined(); expect(existsSync(getSessionSqlitePath(phone, config))).toBe(true)
  await s.removeJidMapping!(phone, pn, jid); expect(await s.getPnForLid!(phone, jid)).toBeUndefined()
  expect(() => s.toJSON()).toThrow('streaming_backup')
})
