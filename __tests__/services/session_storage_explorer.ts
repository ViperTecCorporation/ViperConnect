import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultConfig } from '../../src/services/config'
import { openSessionDatabase, closeAllSessionDatabases, readSessionDatabase, getSessionSqlitePath } from '../../src/services/session_storage/database'
import { exploreSessionDatabase, validateExplorerQuery } from '../../src/services/session_storage/explorer'
import { mutateExplorerRecord, validateExplorerMutation, executeExplorerMutation } from '../../src/services/session_storage/explorer_mutations'
import { explorerCell } from '../../src/services/session_storage/explorer_values'
import { proto } from 'zapo-js'

const phone = '999123456789'
let root: string, config: any, db: ReturnType<typeof openSessionDatabase>
const env = { role: process.env.UNOAPI_PROCESS_ROLE, server: process.env.UNOAPI_SERVER_NAME, owner: process.env.UNOAPI_STORAGE_WORKER_ID }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'viper-explorer-'))
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'mobile_lab'; delete process.env.UNOAPI_STORAGE_WORKER_ID
  config = { ...defaultConfig, useS3: true, autoConnect: false, baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'mobile_lab', generation: 1, state: 'offline', fixture: true } }
  db = openSessionDatabase(phone, config, { create: true })
  db.exec('CREATE TABLE auth_credentials(secret TEXT); INSERT INTO auth_credentials VALUES (\'never-expose-auth\'); CREATE TABLE mailbox_messages(session_id TEXT,message_id TEXT,thread_jid TEXT,from_me INTEGER,timestamp_ms INTEGER,message_bytes BLOB)')
})
afterEach(() => { closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }) })
afterAll(() => { for (const [key, value] of Object.entries(env)) { const name = key === 'role' ? 'UNOAPI_PROCESS_ROLE' : key === 'server' ? 'UNOAPI_SERVER_NAME' : 'UNOAPI_STORAGE_WORKER_ID'; if (value === undefined) delete process.env[name]; else process.env[name] = value } })
const list = (query: any = {}) => exploreSessionDatabase(phone, config, query) as any
const create = (values: any, table = 'uno_kv') => mutateExplorerRecord(db, phone, { action: 'create', table, generation: 1, confirm: true, values })

test('read-only inspector refuses missing files, cannot execute writes and exposes no auth table values', () => {
  expect(list().tables).toContainEqual({ name: 'auth_credentials', editable: false, protected: true })
  expect(() => list({ table: 'auth_credentials' })).toThrow('protected_table')
  expect(() => readSessionDatabase(phone, config, raw => raw.exec("DELETE FROM uno_storage_meta"))).toThrow()
  const absent = { ...config, sessionStorage: { ...config.sessionStorage, storageId: randomUUID() } }
  expect(() => readSessionDatabase(phone, absent, () => null)).toThrow('database_missing')
  expect(existsSync(getSessionSqlitePath(phone, absent))).toBe(false)
  expect(JSON.stringify(list())).not.toContain('never-expose-auth')
})

test('rowid pages preserve continuation and reject cursors from other sessions/filters/generations', () => {
  for (let i = 0; i < 6; i++) db.putValue(`unoapi-contact-name:${phone}:key${i}`, 'name')
  const a = list({ table: 'uno_kv', limit: '2' }), b = list({ table: 'uno_kv', limit: '2', cursor: a.nextCursor })
  expect(a.rows).toHaveLength(2); expect(b.rows).toHaveLength(2); expect(b.rows[0].id).not.toBe(a.rows[0].id)
  expect(() => list({ table: 'uno_kv', search: 'changed', cursor: a.nextCursor })).toThrow('invalid_query')
  config.sessionStorage.generation++
  expect(() => list({ table: 'uno_kv', cursor: a.nextCursor })).toThrow('invalid_query')
})

test('sparse searches are bounded and foreign-phone keys never leak', () => {
  for (let i = 0; i < 205; i++) db.putValue(`unoapi-contact-name:${phone}:${i}`, 'name')
  db.putValue('unoapi-contact-name:999999999999:foreign', 'foreign-secret')
  const a = list({ table: 'uno_kv', search: 'not-present' })
  expect(a.rows).toHaveLength(0); expect(a.scanned).toBe(200); expect(a.hasMore).toBe(true)
  expect(JSON.stringify(list({ table: 'uno_kv', cursor: a.nextCursor, search: 'not-present' }))).not.toContain('foreign-secret')
})

test('rejects SQL/path injection, unbounded scans, repeated query fields and wrong owners', () => {
  for (const q of [{ sql: 'DELETE FROM uno_kv' }, { table: '../auth' }, { table: 'uno_kv;--' }, { limit: '99' }, { search: ['x'] }, { cursor: 'x' }]) expect(() => validateExplorerQuery(q)).toThrow('invalid_query')
  config.sessionStorage.owner = 'other'
  expect(() => list()).toThrow('wrong_owner')
})

test('CRUD uses etags and preserves binary types; stale writes/deletes roll back', () => {
  create({ key: `unoapi-contact-name:${phone}:a`, value: { utf8: 'before' }, encoding: 'utf8', expires_at: null })
  const a = list({ table: 'uno_kv' }).rows[0]
  mutateExplorerRecord(db, phone, { action: 'update', table: 'uno_kv', generation: 1, confirm: true, rowId: a.id, etag: a.etag, values: { value: { utf8: 'after' } } })
  expect(db.getValue(`unoapi-contact-name:${phone}:a`)?.toString()).toBe('after')
  expect(() => mutateExplorerRecord(db, phone, { action: 'delete', table: 'uno_kv', generation: 1, confirm: true, rowId: a.id, etag: a.etag })).toThrow('record_changed')
  const b = list({ table: 'uno_kv' }).rows[0]
  mutateExplorerRecord(db, phone, { action: 'delete', table: 'uno_kv', generation: 1, confirm: true, rowId: b.id, etag: b.etag })
  expect(db.getValue(`unoapi-contact-name:${phone}:a`)).toBeUndefined()
})

test('ID mappings create/update/delete both directions atomically, refusing conflicts', () => {
  create({ key: `unoapi-id:${phone}:provider`, value: { utf8: 'uno' }, encoding: 'utf8' })
  expect(db.getValue(`unoapi-id_rev:${phone}:uno`)?.toString()).toBe('provider')
  const row = list({ table: 'uno_kv', search: `unoapi-id:${phone}:provider` }).rows[0]
  mutateExplorerRecord(db, phone, { action: 'update', table: 'uno_kv', generation: 1, confirm: true, rowId: row.id, etag: row.etag, values: { value: { utf8: 'uno2' } } })
  expect(db.getValue(`unoapi-id_rev:${phone}:uno`)).toBeUndefined()
  expect(db.getValue(`unoapi-id_rev:${phone}:uno2`)?.toString()).toBe('provider')
  expect(() => create({ key: `unoapi-id:${phone}:other`, value: { utf8: 'uno2' } })).toThrow('mapping_conflict')
  expect(db.getValue(`unoapi-id:${phone}:other`)).toBeUndefined()
  const next = list({ table: 'uno_kv', search: `unoapi-id:${phone}:provider` }).rows[0]
  mutateExplorerRecord(db, phone, { action: 'delete', table: 'uno_kv', generation: 1, confirm: true, rowId: next.id, etag: next.etag })
  expect(db.getValue(`unoapi-id_rev:${phone}:uno2`)).toBeUndefined()
})

test('native rows enforce session ownership, protected tables and immutable scope', () => {
  expect(() => create({ session_id: 'other', message_id: 'x' }, 'mailbox_messages')).toThrow('foreign_session')
  expect(() => create({ secret: 'x' }, 'auth_credentials')).toThrow('protected_table')
  expect(() => create({ key: 'unoapi-config:other', value: 'x' })).toThrow('protected_key')
  create({ message_id: 'x', thread_jid: '123@lid', from_me: 0, timestamp_ms: 1 }, 'mailbox_messages')
  expect(db.get('SELECT session_id FROM mailbox_messages')?.session_id).toBe(phone)
})

test('message preview never exposes media keys/protobuf; sensitive JSON is not offered for edit', () => {
  const bytes = proto.Message.encode({ imageMessage: { caption: 'visible', mediaKey: Buffer.from('media-secret'), directPath: '/secret-cdn' } }).finish()
  const cell = explorerCell('mailbox_messages', 'message_bytes', bytes, { message_id: 'id', thread_jid: '123@lid', from_me: 1 })
  expect(cell).toMatchObject({ editable: false, value: { type: 'image', text: 'visible' } })
  const redacted = explorerCell('uno_kv', 'value', Buffer.from('{"token":"private","name":"visible"}'), {})
  expect(redacted.editable).toBe(false); expect(JSON.stringify(redacted)).not.toContain('private')
  expect(JSON.stringify(cell)).not.toMatch(/media-secret|secret-cdn|base64/)
})

test('mutation contract requires confirmation, generation, record CAS and bounded typed values', () => {
  for (const body of [{}, { action: 'create', table: 'uno_kv', generation: 1, confirm: false, values: { key: 'x' } }, { action: 'delete', table: 'uno_kv', generation: 1, confirm: true, rowId: '1' }]) expect(() => validateExplorerMutation(body)).toThrow('invalid_mutation')
  expect(() => create({ key: `unoapi-contact-name:${phone}:x`, value: { sql: 'oops' } })).toThrow('invalid_value')
})

test('owner mutation requires offline, lease, mutex and verified backup; never writes on backup failure', async () => {
  const values = new Map<string, string>([[`unoapi-config:${phone}`, JSON.stringify(config)], [`unoapi-status:${phone}`, 'offline']])
  const redis = { get: jest.fn(async (k: string) => values.get(k) || null), set: jest.fn(async (k: string, v: string) => { values.set(k, v); return 'OK' }), eval: jest.fn(async () => 1) }
  const deps = { redis, assertFresh: jest.fn(async () => {}), hasClient: () => false, database: () => db,
    lease: { acquire: jest.fn(async () => true), renew: jest.fn(async () => true), release: jest.fn(async () => {}) }, backup: jest.fn(async () => ({ id: randomUUID(), status: 'ready', phone, storageId: config.sessionStorage.storageId, generation: 1 })) }
  const body: any = { action: 'create', table: 'uno_kv', generation: 1, confirm: true, values: { key: `unoapi-contact-name:${phone}:guarded`, value: { utf8: 'saved' } } }
  const result = await executeExplorerMutation(phone, config, body, deps)
  expect(result.changed).toBe(true); expect(deps.backup).toHaveBeenCalledTimes(1)
  deps.backup.mockRejectedValueOnce(new Error('s3 unavailable'))
  await expect(executeExplorerMutation(phone, config, { ...body, values: { key: `unoapi-contact-name:${phone}:never`, value: 'x' } }, deps)).rejects.toThrow('s3 unavailable')
  expect(db.getValue(`unoapi-contact-name:${phone}:never`)).toBeUndefined()
  values.set(`unoapi-status:${phone}`, 'online')
  await expect(executeExplorerMutation(phone, config, body, deps)).rejects.toThrow('requires_offline')
  expect(deps.backup).toHaveBeenCalledTimes(2)
})
