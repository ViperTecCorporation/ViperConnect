import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { proto } from 'zapo-js/proto'
import type { Config } from '../../src/services/config'
import { closeAllSessionDatabases, openSessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { decorateSqliteBackend } from '../../src/services/session_storage/native_backend'
import { maintainSessionSqlite } from '../../src/services/session_storage/maintenance'

const phone = '999123456789', foreign = '999987654321', jid = '12345@lid'
let directory: string, config: Config, savedEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  savedEnvironment = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'synthetic_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID
  directory = mkdtempSync(join(tmpdir(), 'viper-sqlite-maintenance-'))
  config = { baseStore: directory, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'synthetic_owner', generation: 1, state: 'offline', fixture: true } } as Config
  openSessionDatabase(phone, config, { create: true })
})
afterEach(() => { closeAllSessionDatabases(); process.env = savedEnvironment; rmSync(directory, { recursive: true, force: true }) })

test('bounded physical TTL pruning covers all compatibility types without removing live IDs, auth or foreign scopes', () => {
  const db = openSessionDatabase(phone, config), expired = Date.now() - 1000, future = Date.now() + 60000
  for (const [key, deadline] of [[`unoapi-id:${phone}:expired`, expired], [`unoapi-id_rev:${phone}:live`, future], [`unoapi-idXrev:${phone}:unknown`, expired], [`unoapi-id:${phone}0:foreign`, expired], [`unoapi:zapo:auth:${phone}:noise_priv_key`, expired], [`unoapi-config:${phone}`, expired]] as const) db.run('INSERT INTO uno_kv VALUES(?,?,?,?)', [key, Buffer.from('synthetic'), 'raw', deadline])
  db.run('INSERT INTO uno_hash VALUES(?,?,?,?)', [`unoapi-contact-info:${phone}:expired`, 'name', Buffer.from('name'), expired])
  db.run('INSERT INTO uno_set VALUES(?,?,?)', [`unoapi-status-recipients:${phone}`, Buffer.from('member'), expired])
  db.run('INSERT INTO uno_zset VALUES(?,?,?,?)', [`unoapi-zapo-username-lid:${phone}`, 'name', 1, expired])
  db.run('INSERT INTO uno_list VALUES(?,?,?,?)', [`unoapi-last-incoming:${phone}:expired`, 0, Buffer.from('id'), expired])
  let removed = 0
  for (let i = 0; i < 10; i++) { const result = maintainSessionSqlite(phone, config, { rowBudget: 2 }); expect(result.totalDeleted).toBeLessThanOrEqual(2); removed += result.totalDeleted }
  expect(removed).toBe(5)
  expect(db.getValue(`unoapi-id_rev:${phone}:live`)?.toString()).toBe('synthetic')
  for (const key of [`unoapi-idXrev:${phone}:unknown`, `unoapi-id:${phone}0:foreign`, `unoapi:zapo:auth:${phone}:noise_priv_key`, `unoapi-config:${phone}`]) expect(db.get('SELECT key FROM uno_kv WHERE key=?', [key])).toBeDefined()
  expect(JSON.parse(db.get("SELECT value FROM uno_storage_meta WHERE key='maintenance_last'")!.value)).toMatchObject({ fileShrunk: false, authCryptoPreserved: true })
})

test('native pruning keeps expiry/tombstone fences so old messages cannot resurrect; other sessions and crypto stay untouched', async () => {
  const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) }), decorated = decorateSqliteBackend(native, phone, config)
  const pair = { pubKey: Buffer.alloc(32, 7), privKey: Buffer.alloc(32, 8) }, address = { user: '12345', server: 'lid', device: 1 }
  await native.stores!.auth!(phone).save({ noiseKeyPair: pair, registrationInfo: { registrationId: 123, identityKeyPair: pair }, signedPreKey: { keyId: 7, keyPair: pair, signature: Buffer.alloc(64, 9) }, advSecretKey: Buffer.alloc(32, 10) })
  await native.stores!.identity!(phone).setRemoteIdentity(address, Buffer.alloc(33, 11))
  const content = { id: 'expired', threadJid: jid, fromMe: false, timestampMs: Date.now(), messageBytes: proto.Message.encode({ conversation: 'expired' }).finish() }
  await decorated.stores!.messages!(phone).upsert(content)
  await decorated.stores!.contacts!(phone).upsert({ jid, displayName: 'expired contact', lastUpdatedMs: Date.now() })
  await decorated.stores!.threads!(phone).upsert({ jid, name: 'expired thread' })
  db.run("UPDATE uno_native_expiry SET expires_at=1 WHERE domain IN ('msg','contact','thread')")
  db.run('INSERT INTO mailbox_messages(session_id,message_id,thread_jid,from_me,timestamp_ms) VALUES(?,?,?,?,?)', [foreign, 'foreign', jid, 0, 1])
  db.exec('CREATE TABLE IF NOT EXISTS synthetic_crypto(secret BLOB)'); db.run('INSERT INTO synthetic_crypto VALUES(?)', [Buffer.from('preserve')])
  const result = maintainSessionSqlite(phone, config, { rowBudget: 100 })
  expect(result.deletedNative).toBe(3)
  expect(db.get('SELECT * FROM mailbox_messages WHERE session_id=?', [phone])).toBeUndefined()
  expect(db.get('SELECT * FROM mailbox_messages WHERE session_id=?', [foreign])).toBeDefined()
  expect(db.get('SELECT * FROM synthetic_crypto')).toBeDefined()
  expect((await native.stores!.auth!(phone).load())?.advSecretKey).toEqual(new Uint8Array(Buffer.alloc(32, 10)))
  expect(await native.stores!.identity!(phone).getRemoteIdentity(address)).toEqual(new Uint8Array(Buffer.alloc(33, 11)))
  expect(db.get("SELECT expires_at FROM uno_native_expiry WHERE domain='msg' AND record_id='expired'")?.expires_at).toBe(1)
  await decorated.stores!.messages!(phone).upsert(content)
  expect(await decorated.stores!.messages!(phone).getById('expired')).toBeNull()
})

test('maintenance refuses foreign owners/transitions/bad budgets and supports a one-row pass', () => {
  expect(() => maintainSessionSqlite(phone, { ...config, sessionStorage: { ...config.sessionStorage!, owner: 'other' } })).toThrow('wrong_owner')
  expect(() => maintainSessionSqlite(phone, { ...config, sessionStorage: { ...config.sessionStorage!, state: 'restoring' } })).toThrow('maintenance_requires_sqlite')
  for (const rowBudget of [0, 1001, NaN, 1.5]) expect(() => maintainSessionSqlite(phone, config, { rowBudget })).toThrow('prune_limit_invalid')
  const db = openSessionDatabase(phone, config); db.run('INSERT INTO uno_kv VALUES(?,?,?,?)', [`unoapi-id:${phone}:expired`, Buffer.from('id'), 'raw', 1])
  expect(maintainSessionSqlite(phone, config, { rowBudget: 1 }).totalDeleted).toBe(1)
})
