import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openSessionDatabase, getSessionSqlitePath, closeAllSessionDatabases, SessionDatabase, sessionDatabaseConnectionCount } from '../../src/services/session_storage/database'
import { assertSqliteWalSafeVersion } from '../../src/services/session_storage/sqlite_safety'

const phone = '5566999999999'
let root: string
const config = () => ({ baseStore: root, sessionStorage: { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'active' as const, fixture: true } })
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'uno-session-sqlite-')) })
afterEach(() => { closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }) })

test('refuses absent databases and missing worker volume instead of silently creating empty auth', () => {
  const c = config(); expect(() => openSessionDatabase(phone, c)).toThrow('database_missing')
  expect(() => openSessionDatabase(phone, { ...c, baseStore: join(root, 'missing') }, { create: true })).toThrow('volume_unavailable')
  expect(existsSync(join(root, 'missing'))).toBe(false)
})
test('validates IDs and prevents path escape or foreign session reuse', () => {
  const c = config(); expect(() => getSessionSqlitePath(phone, { ...c, sessionStorage: { ...c.sessionStorage, storageId: '../outside' } })).toThrow('invalid_selection')
  expect(() => getSessionSqlitePath('../secret', c)).toThrow('invalid_phone')
  openSessionDatabase(phone, c, { create: true }); closeAllSessionDatabases()
  expect(() => openSessionDatabase('5511999999999', c)).toThrow('identity_mismatch')
})
test('stores binary data, NX, CAS, and earlier absolute expiry atomically', () => {
  const db = openSessionDatabase(phone, config(), { create: true }), bytes = Buffer.from([0, 255, 128, 1]), deadline = Date.now() + 60000
  expect(db.putValue('a', bytes, { expiresAt: deadline, nx: true })).toBe(true)
  expect(db.putValue('a', 'wrong', { nx: true })).toBe(false)
  expect(db.compareAndSet('a', Buffer.from('wrong'), Buffer.from('new'))).toBe(false)
  expect(db.compareAndSet('a', bytes, Buffer.from('new'), { expiresAt: deadline + 100000, keepEarlierExpiry: true })).toBe(true)
  expect(db.getValue('a')).toEqual(Buffer.from('new'))
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', ['a'])?.expires_at).toBe(deadline)
  expect(db.getValue('a', deadline)).toBeUndefined()
})
test('rolls back errors and refuses async callbacks', () => {
  const db = openSessionDatabase(phone, config(), { create: true })
  expect(() => db.transaction(() => { db.putValue('a', 'value'); throw new Error('abort') })).toThrow('abort')
  expect(db.getValue('a')).toBeUndefined()
  expect(() => db.transaction(() => Promise.resolve(1))).toThrow('async_transaction_forbidden')
})
test('paginates values without bulk export and expires in bounded batches', () => {
  const db = openSessionDatabase(phone, config(), { create: true })
  for (const k of ['a', 'b', 'c']) db.putValue(k, k)
  expect(db.valuesPage('', 2).map(row => row.key)).toEqual(['a', 'b'])
  expect(db.valuesPage('b', 2).map(row => row.key)).toEqual(['c'])
  expect(() => db.valuesPage('', 100000)).toThrow('page_limit_invalid')
  db.run('UPDATE uno_kv SET expires_at=1'); expect(db.pruneExpired(Date.now(), 2)).toBe(2)
  expect(db.valuesPage().length).toBe(1)
})
test('backup uses SQLite online backup and survives close/reopen without losing a WAL transaction', async () => {
  const c = config(), db = openSessionDatabase(phone, c, { create: true }); db.putValue('id', 'immutable')
  const backup = join(root, 'snapshot.sqlite'); await db.backup(backup)
  const restored = new SessionDatabase(backup)
  try { expect(restored.getValue('id')?.toString()).toBe('immutable'); expect(restored.get('PRAGMA quick_check')?.quick_check).toBe('ok') } finally { restored.close() }
  closeAllSessionDatabases(); expect(openSessionDatabase(phone, c).getValue('id')?.toString()).toBe('immutable')
  await expect(db.backup(backup)).rejects.toThrow()
})
test('does not follow a symlink out of the session volume', () => {
  const c = config(), elsewhere = mkdtempSync(join(tmpdir(), 'uno-session-other-'))
  try { mkdirSync(join(root, 'session-storage')); symlinkSync(elsewhere, join(root, 'session-storage', c.sessionStorage.storageId), 'junction'); expect(() => openSessionDatabase(phone, c, { create: true })).toThrow('symlink') }
  finally { rmSync(join(root, 'session-storage', c.sessionStorage.storageId), { force: true }); rmSync(elsewhere, { recursive: true, force: true }) }
})
test('connection registry is bounded and explicitly releasable', () => {
  for (let i = 0; i < 130; i++) openSessionDatabase(phone, config(), { create: true })
  expect(sessionDatabaseConnectionCount()).toBe(128)
  closeAllSessionDatabases(); expect(sessionDatabaseConnectionCount()).toBe(0)
})

test.each(['3.51.2', '3.50.4', '2.99.99', 'unknown', null])('rejects an engine without the required WAL-reset fix (%s)', value => {
  expect(() => assertSqliteWalSafeVersion(value)).toThrow('session_storage_sqlite_version_unsupported')
})

test.each(['3.51.3', '3.53.1', '3.53.4', '4.0.0'])('accepts a patched SQLite engine (%s)', value => {
  expect(() => assertSqliteWalSafeVersion(value)).not.toThrow()
})
