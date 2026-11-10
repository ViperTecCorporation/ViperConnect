import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { SessionSqliteBackups, snapshotSqlite, SqliteBackupManifest } from '../../src/services/session_storage/backup'
import { assertSqliteWalSafeVersion } from '../../src/services/session_storage/sqlite_safety'
import { decodeBackupStream } from '../../src/services/session_storage/backup_stream'
import { encryptSessionStream } from '../../src/services/session_transfer/archive_stream'

const Database = module.require('node:sqlite').DatabaseSync
const phone = '999123456789', password = 'synthetic-backup-password'
let directory: string, db: any
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'viper-backup-test-')); db = new Database(join(directory, 'session.sqlite')); assertSqliteWalSafeVersion(db.prepare('SELECT sqlite_version() AS version').get()?.version); db.exec('PRAGMA journal_mode=WAL'); db.exec('CREATE TABLE ids(provider TEXT PRIMARY KEY, uno TEXT, secret BLOB, expires_at INTEGER)'); db.prepare('INSERT INTO ids VALUES (?,?,?,?)').run('PROVIDER', 'UNO', Buffer.from([0, 255, 1]), 1999999999999) })
afterEach(async () => { if (db?.isOpen) db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture() {
  const objects = new Map<string, Buffer>(), manifests = new Map<string, SqliteBackupManifest>()
  const store = { save: jest.fn(async (key: string, stream: Readable) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); objects.set(key, Buffer.concat(chunks)) }), open: jest.fn(async (key: string) => Readable.from([objects.get(key)!])) }
  const index = { put: jest.fn(async (m: SqliteBackupManifest) => { manifests.set(m.id, m) }), get: jest.fn(async (id: string) => manifests.get(id)) }
  const storage = { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'server_1', generation: 2, state: 'offline' as const }
  const input = { phone, path: join(directory, 'session.sqlite'), storage, password }
  return { objects, manifests, store, index, input, service: new SessionSqliteBackups(store, index) }
}

async function legacyArchive(f: ReturnType<typeof fixture>, manifest: SqliteBackupManifest, protection?: 'aes-256-gcm') {
  const legacy = { ...manifest }, records: unknown[] = []; let meta: any
  delete legacy.protection; if (protection) legacy.protection = protection
  for await (const frame of decodeBackupStream(Readable.from([f.objects.get(manifest.objectKey)!]))) {
    if (frame.kind === 'meta') meta = { ...frame.value, manifest: legacy }
    else if (frame.kind === 'records') records.push(...frame.value)
  }
  const chunks: Buffer[] = [], source = async function* () { yield* records }
  for await (const chunk of encryptSessionStream(meta, source(), password)) chunks.push(chunk)
  f.objects.set(manifest.objectKey, Buffer.concat(chunks)); f.manifests.set(legacy.id, legacy)
  return legacy
}

test('actual online snapshot includes live WAL data and is independently readable', async () => {
  const output = join(directory, 'snapshot.sqlite')
  await snapshotSqlite(join(directory, 'session.sqlite'), output)
  const copy = new Database(output, { readOnly: true }), row = copy.prepare('SELECT * FROM ids').get()
  expect({ ...row, secret: Buffer.from(row.secret) }).toEqual({ provider: 'PROVIDER', uno: 'UNO', secret: Buffer.from([0, 255, 1]), expires_at: 1999999999999 }); copy.close()
  await expect(snapshotSqlite(join(directory, 'session.sqlite'), output)).rejects.toHaveProperty('code', 'EEXIST')
  await expect(snapshotSqlite(output, output)).rejects.toThrow('session_storage_snapshot_source_invalid')
})

test('new unencrypted streaming backup/restore needs no key and preserves binary IDs/expiry and mobile companion metadata, offline only', async () => {
  const f = fixture(), supplement = { registration: { encryptedFixture: 'not-a-real-key' }, companionEpoch: { generation: 4 } }
  const manifest = await f.service.backup({ ...f.input, password: undefined, kind: 'mobile-primary', supplement })
  expect(manifest.objectKey).toBe(`backups/session-storage/${phone}/${manifest.id}.viperstorage`)
  expect(manifest.protection).toBe('none'); expect(f.objects.get(manifest.objectKey)!.toString()).toContain('viperconnect-storage-backup-stream')
  expect(f.objects.get(manifest.objectKey)!.toString()).toContain('not-a-real-key')
  const path = join(directory, 'restored.sqlite'), result = await f.service.restore({ phone, backupId: manifest.id, stagedPath: path })
  expect(result.autoConnect).toBe(false); expect(result.supplement).toEqual(supplement)
  const copy = new Database(path, { readOnly: true }); expect(copy.prepare('SELECT * FROM ids').get()).toEqual(db.prepare('SELECT * FROM ids').get()); copy.close()
  expect(f.index.put).toHaveBeenCalledTimes(1)
})

test('failed upload is not published and does not delete an earlier successful backup', async () => {
  const f = fixture(), good = await f.service.backup(f.input)
  f.store.save.mockRejectedValueOnce(new Error('s3 unavailable'))
  await expect(f.service.backup(f.input)).rejects.toThrow('s3 unavailable')
  expect(f.index.put).toHaveBeenCalledTimes(1); expect(f.manifests.has(good.id)).toBe(true)
})

test('a successful upload with corrupted readback is never published ready and preserves the earlier receipt', async () => {
  const f = fixture(), good = await f.service.backup(f.input)
  f.store.open.mockImplementationOnce(async key => {
    const original = f.objects.get(key)!, corrupted = Buffer.from(original)
    corrupted[corrupted.length - 20] ^= 1
    return Readable.from([corrupted])
  })
  await expect(f.service.backup(f.input)).rejects.toThrow()
  expect(f.index.put).toHaveBeenCalledTimes(1)
  expect([...f.manifests.keys()]).toEqual([good.id])
  expect(f.store.open).toHaveBeenCalledTimes(2)
})

test('readback transport failure does not publish a ready manifest', async () => {
  const f = fixture(); f.store.open.mockRejectedValueOnce(new Error('synthetic readback unavailable'))
  await expect(f.service.backup(f.input)).rejects.toThrow('synthetic readback unavailable')
  expect(f.index.put).not.toHaveBeenCalled()
})

test('restore rejects a different session, legacy wrong/missing key, truncated object and pre-existing destination', async () => {
  const f = fixture(), good = await f.service.backup(f.input), output = join(directory, 'restored.sqlite')
  await expect(f.service.restore({ phone: '999987654321', backupId: good.id, password, stagedPath: output })).rejects.toThrow('session_storage_backup_not_found')
  await legacyArchive(f, good)
  await expect(f.service.restore({ phone, backupId: good.id, stagedPath: output })).rejects.toThrow('session_storage_backup_legacy_key_required')
  await expect(f.service.restore({ phone, backupId: good.id, password: 'wrong-backup-password', stagedPath: output })).rejects.toThrow('mobile_backup_invalid_or_wrong_password')
  await expect(stat(output)).rejects.toHaveProperty('code', 'ENOENT')
  await expect(f.service.restore({ phone, backupId: good.id, password, stagedPath: f.input.path })).rejects.toHaveProperty('code', 'EEXIST')
  const encrypted = f.objects.get(good.objectKey)!; f.objects.set(good.objectKey, encrypted.subarray(0, encrypted.length - 32))
  await expect(f.service.restore({ phone, backupId: good.id, password, stagedPath: output })).rejects.toThrow()
  expect(await readFile(f.input.path)).toBeDefined()
})

test.each([undefined, 'aes-256-gcm'] as const)('restores existing encrypted archives with manifest protection %s, without modifying archived bytes', async protection => {
  const f = fixture(), good = await f.service.backup(f.input), legacy = await legacyArchive(f, good, protection), before = Buffer.from(f.objects.get(good.objectKey)!)
  const destination = join(directory, 'legacy.sqlite')
  expect((await f.service.restore({ phone, backupId: legacy.id, password, stagedPath: destination })).autoConnect).toBe(false)
  expect(f.objects.get(good.objectKey)).toEqual(before)
  const copy = new Database(destination, { readOnly: true }); try { expect(copy.prepare('SELECT * FROM ids').get()).toEqual(db.prepare('SELECT * FROM ids').get()) } finally { copy.close() }
})

test('new backups ignore old password input and cannot be mislabeled as legacy or encrypted', async () => {
  const f = fixture(), good = await f.service.backup({ ...f.input, password: 'short' })
  const output = join(directory, 'plain.sqlite')
  await expect(f.service.restore({ phone, backupId: good.id, password: 'ignored', stagedPath: output })).resolves.toHaveProperty('autoConnect', false)
  for (const protection of [undefined, 'aes-256-gcm', 'unknown']) {
    f.manifests.set(good.id, { ...good, protection } as any)
    await expect(f.service.restore({ phone, backupId: good.id, stagedPath: join(directory, 'invalid.sqlite') })).rejects.toThrow('session_storage_backup_invalid')
  }
})

test('backup refuses missing mobile registration, wrong backend and transitional state', async () => {
  const f = fixture()
  await expect(f.service.backup({ ...f.input, kind: 'mobile-primary' })).rejects.toThrow('session_storage_mobile_registration_required')
  await expect(f.service.backup({ ...f.input, storage: { ...f.input.storage, backend: 'redis' } })).rejects.toThrow('session_storage_backup_requires_sqlite')
  await expect(f.service.backup({ ...f.input, storage: { ...f.input.storage, state: 'migrating' } })).rejects.toThrow('session_storage_backup_requires_sqlite')
  expect(f.store.save).not.toHaveBeenCalled()
})
