jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
jest.mock('../../src/services/session_storage/backup_objects', () => ({ createBackupObjects: jest.fn() }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }))
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn(), amqpRpc: jest.fn(), amqpConsume: jest.fn() }))
import { Readable } from 'node:stream'
import { getConfigRedis } from '../../src/services/config_redis'
import { getRedis } from '../../src/services/redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { createBackupObjects, type BackupObjects } from '../../src/services/session_storage/backup_objects'
import { SessionSqliteBackups, type SqliteBackupManifest } from '../../src/services/session_storage/backup'
import { encryptSessionStream } from '../../src/services/session_transfer/archive_stream'
import { encodeBackupStream } from '../../src/services/session_storage/backup_stream'
import { SessionStorageError } from '../../src/services/session_storage/types'
import { SESSION_BACKUP_UPLOAD_BYTES, storageUploadKeys, assertUploadDestination, stageSessionBackupUpload, uploadedBackupService, cleanExpiredStorageUploads } from '../../src/services/session_storage/backup_upload'

const phone = '999123456789', uploadId = '00000000-0000-4000-8000-000000000001', archiveId = '00000000-0000-4000-8000-000000000002', password = 'synthetic-backup-upload-password'
const config: any = { provider: 'zapo', useS3: true, autoConnect: false, sessionStorage: { backend: 'sqlite', owner: 'synthetic-owner', generation: 1, storageId: archiveId, state: 'offline' } }
const manifest: SqliteBackupManifest = { id: archiveId, version: 1, phone, storageId: archiveId, generation: 1, createdAt: '2026-11-08T16:00:00.000Z', bytes: 12, sha256: 'a'.repeat(64), kind: 'linked-session', status: 'ready', objectKey: `backups/session-storage/${phone}/${archiveId}.viperstorage` }
let encrypted: Buffer
function fixture() {
  const json = new Map<string, any>(), blobs = new Map<string, Buffer>(), saved = new Map<string, number>(), locks = new Map<string, string>()
  const objects: BackupObjects = {
    save: jest.fn(async (key, stream) => { let received = 0; for await (const chunk of stream) received += chunk.length; saved.set(key, received) }),
    open: jest.fn(async key => { const blob = blobs.get(key); if (!blob) throw Error('fixture_object_missing'); return Readable.from([blob]) }),
    remove: jest.fn(async key => { json.delete(key); blobs.delete(key) }),
    json: jest.fn(async key => json.has(key) ? { value: json.get(key), etag: 'fixture-etag' } : undefined),
    putJson: jest.fn(async (key, value) => { if (json.has(key)) return false; json.set(key, value); return true }),
    keys: jest.fn(async function* (prefix: string) { for (const key of new Set([...json.keys(), ...blobs.keys()])) if (key.startsWith(prefix)) yield key }),
  }
  const redis = { get: jest.fn(async (key: string) => locks.get(key) || null), eval: jest.fn(async (script: string, { keys, arguments: args }: any) => {
    if (script.includes("redis.call('EXISTS'")) { if (locks.has(keys[0])) return 0; locks.set(keys[0], args[0]); return 1 }
    if (script.includes("redis.call('PEXPIRE'")) return locks.get(keys[0]) === args[0] ? 1 : 0
    if (locks.get(keys[0]) === args[0]) locks.delete(keys[0]); return 1
  }) }
  jest.mocked(createBackupObjects).mockReturnValue(objects); jest.mocked(getRedis).mockResolvedValue(redis as any)
  jest.mocked(getConfigRedis).mockResolvedValue(config)
  jest.mocked(sessionStorageRpc).mockImplementation(async (_phone, _config, operation) => operation === 'restore-upload-check' ? { available: true } as any : { id: 'fixture-task', phone, operation: 'restore', status: 'running' } as any)
  const receipt = (patch: Record<string, unknown> = {}) => ({ version: 1, phone, uploadId, bytes: encrypted.length, createdAt: Date.now(), expiresAt: Date.now() + 86400000, ...patch })
  return { objects, redis, json, blobs, saved, locks, receipt }
}
beforeAll(async () => {
  const chunks: Buffer[] = []
  // Real authenticated framing, deliberately not a valid SQLite snapshot. First-frame discovery must not claim full verification.
  for await (const chunk of encryptSessionStream({ kind: 'sqlite-session', version: 1, manifest, supplement: {} }, (async function* () { yield { offset: 0, data: Buffer.from('not-a-sqlite').toString('base64') } })(), password)) chunks.push(chunk)
  encrypted = Buffer.concat(chunks)
})
beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.restoreAllMocks())

test('staging keys and destination guards reject unknown scope, online/reconnecting/unlinked/primary-deleting states', () => {
  expect(storageUploadKeys(phone, uploadId)).toEqual({ archive: `backups/session-storage/${phone}/uploads/${uploadId}.viperstorage`, receipt: `backups/session-storage/${phone}/uploads/${uploadId}.upload.json` })
  expect(() => storageUploadKeys('invalid', uploadId)).toThrow('phone_invalid'); expect(() => storageUploadKeys(phone, '../other')).toThrow('upload_invalid')
  expect(() => assertUploadDestination(config, false)).not.toThrow()
  for (const patch of [{ provider: 'baileys' }, { autoConnect: true }, { sessionStorage: { backend: 'redis', state: 'offline' } }, { sessionStorage: { ...config.sessionStorage, state: 'active' } }, { mobilePrimaryDeleting: true }, { sessionStorageUnlinked: true }]) expect(() => assertUploadDestination({ ...config, ...patch }, false)).toThrow('requires_offline')
  expect(() => assertUploadDestination(config, true)).toThrow('requires_offline')
})

test.each([0, -1, 1.5, NaN, SESSION_BACKUP_UPLOAD_BYTES + 1])('declared upload size %s is rejected before config/RPC/object access', async bytes => {
  fixture(); await expect(stageSessionBackupUpload(phone, Readable.from([]), bytes)).rejects.toThrow('upload_size_invalid')
  expect(getConfigRedis).not.toHaveBeenCalled(); expect(sessionStorageRpc).not.toHaveBeenCalled(); expect(createBackupObjects).not.toHaveBeenCalled()
})

test('a 256-MiB upload streams using one reused 1-MiB chunk; receipt precedes the object and final owner RPC occurs once', async () => {
  const f = fixture(), chunk = Buffer.alloc(1024 * 1024)
  const source = Readable.from((function* () { for (let index = 0; index < 256; index++) yield chunk })())
  expect(await stageSessionBackupUpload(phone, source, SESSION_BACKUP_UPLOAD_BYTES)).toMatchObject({ id: 'fixture-task', operation: 'restore' })
  const [key] = [...f.saved.keys()]; expect(f.saved.get(key)).toBe(SESSION_BACKUP_UPLOAD_BYTES)
  const receiptKey = key.replace('.viperstorage', '.upload.json'); expect(f.json.get(receiptKey)).toMatchObject({ phone, bytes: SESSION_BACKUP_UPLOAD_BYTES })
  expect(jest.mocked(f.objects.putJson).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(f.objects.save).mock.invocationCallOrder[0])
  expect(jest.mocked(sessionStorageRpc).mock.calls.map(call => call[2])).toEqual(['restore-upload-check', 'restore-upload'])
  expect(f.objects.remove).not.toHaveBeenCalled()
})

test.each(['incomplete', 'oversized-body', 'source-error'])('%s upload never starts restore and preserves its discoverable staging receipt', async reason => {
  const f = fixture(), source = reason === 'source-error' ? new Readable({ read() { this.destroy(Error('synthetic_client_abort')) } }) : Readable.from([Buffer.alloc(reason === 'incomplete' ? 3 : 5)])
  await expect(stageSessionBackupUpload(phone, source, 4)).rejects.toThrow(reason === 'incomplete' ? 'upload_incomplete' : reason === 'oversized-body' ? 'upload_size_invalid' : 'synthetic_client_abort')
  expect(sessionStorageRpc).toHaveBeenCalledTimes(1); expect(f.json.size).toBe(1); expect(f.objects.remove).not.toHaveBeenCalled()
})

test('state conflict, unavailable S3 and receipt CAS conflict cause no upload; ambiguous final RPC never retries or deletes staging', async () => {
  const f = fixture(); jest.mocked(getConfigRedis).mockResolvedValueOnce({ ...config, useS3: false })
  await expect(stageSessionBackupUpload(phone, Readable.from([Buffer.alloc(4)]), 4)).rejects.toThrow('requires_s3'); expect(sessionStorageRpc).not.toHaveBeenCalled()
  jest.mocked(sessionStorageRpc).mockRejectedValueOnce(new SessionStorageError(409, 'session_storage_restore_requires_offline'))
  await expect(stageSessionBackupUpload(phone, Readable.from([Buffer.alloc(4)]), 4)).rejects.toThrow('requires_offline'); expect(f.objects.putJson).not.toHaveBeenCalled()
  jest.mocked(f.objects.putJson).mockResolvedValueOnce(false)
  await expect(stageSessionBackupUpload(phone, Readable.from([Buffer.alloc(4)]), 4)).rejects.toThrow('upload_conflict'); expect(f.objects.save).not.toHaveBeenCalled()
  jest.mocked(sessionStorageRpc).mockClear().mockResolvedValueOnce({ available: true }).mockRejectedValueOnce(new SessionStorageError(503, 'session_storage_unavailable'))
  await expect(stageSessionBackupUpload(phone, Readable.from([Buffer.alloc(4)]), 4)).rejects.toThrow('session_storage_unavailable')
  expect(sessionStorageRpc).toHaveBeenCalledTimes(2); expect(f.objects.save).toHaveBeenCalledTimes(1); expect(f.objects.remove).not.toHaveBeenCalled(); expect(f.json.size).toBe(1)
})

test('encrypted metadata discovery creates a readonly full-verifier service but does not authenticate trailing frames or touch SQLite itself', async () => {
  const f = fixture(), keys = storageUploadKeys(phone, uploadId)
  const lines = encrypted.toString().trimEnd().split('\n'), end = JSON.parse(lines.at(-1)!); end.tag = Buffer.alloc(16).toString('base64'); lines[lines.length - 1] = JSON.stringify(end)
  f.json.set(keys.receipt, f.receipt()); f.blobs.set(keys.archive, Buffer.from(lines.join('\n') + '\n'))
  const verifier = jest.spyOn(SessionSqliteBackups.prototype, 'restore').mockRejectedValue(new SessionStorageError(409, 'session_storage_full_verifier_required'))
  const result = await uploadedBackupService(phone, uploadId, config, password)
  expect(result.manifest).toEqual(manifest); expect(verifier).not.toHaveBeenCalled(); expect(sessionStorageRpc).not.toHaveBeenCalled()
  await expect(result.service.restore({ phone, backupId: manifest.id, password, stagedPath: 'never-opened-test-path' })).rejects.toThrow('full_verifier_required')
  expect(verifier).toHaveBeenCalledTimes(1)
  await expect(result.service.objects.save(manifest.objectKey, Readable.from([]))).rejects.toThrow('upload_readonly')
  await expect(result.service.objects.open('wrong/object')).rejects.toThrow('upload_invalid')
  expect(await result.service.index.get('different-id')).toBeUndefined()
  expect(f.objects.remove).not.toHaveBeenCalled(); await result.remove()
  expect(jest.mocked(f.objects.remove).mock.calls.flat()).toEqual([keys.archive, keys.receipt])
})

test('new plain upload discovers its ID without any backup key, while encrypted legacy still requires one', async () => {
  const f = fixture(), keys = storageUploadKeys(phone, uploadId), plainManifest = { ...manifest, protection: 'none' as const }, chunks: Buffer[] = []
  for await (const chunk of encodeBackupStream({ kind: 'sqlite-session', version: 1, manifest: plainManifest, supplement: {} }, (async function* () {})())) chunks.push(chunk)
  f.json.set(keys.receipt, f.receipt()); f.blobs.set(keys.archive, Buffer.concat(chunks))
  expect((await uploadedBackupService(phone, uploadId, config)).manifest).toEqual(plainManifest)
  expect((await uploadedBackupService(phone, uploadId, config, 'unused-short-key')).manifest).toEqual(plainManifest)
  f.blobs.set(keys.archive, encrypted)
  await expect(uploadedBackupService(phone, uploadId, config)).rejects.toThrow('session_storage_backup_legacy_key_required')
})

test('missing/expired/foreign receipts reject discovery before object decryption, while a wrong key or corrupt header is explicit', async () => {
  const f = fixture(), keys = storageUploadKeys(phone, uploadId)
  for (const receipt of [undefined, f.receipt({ phone: '999987654321' }), f.receipt({ uploadId: archiveId }), f.receipt({ expiresAt: Date.now() - 1 }), f.receipt({ bytes: SESSION_BACKUP_UPLOAD_BYTES + 1 })]) {
    if (receipt) f.json.set(keys.receipt, receipt); else f.json.delete(keys.receipt)
    await expect(uploadedBackupService(phone, uploadId, config, password)).rejects.toThrow('upload_expired')
  }
  expect(f.objects.open).not.toHaveBeenCalled()
  f.json.set(keys.receipt, f.receipt()); f.blobs.set(keys.archive, encrypted)
  await expect(uploadedBackupService(phone, uploadId, config, 'another-synthetic-backup-password')).rejects.toThrow('invalid_or_wrong_password')
  f.blobs.set(keys.archive, Buffer.from('corrupt\n')); await expect(uploadedBackupService(phone, uploadId, config, password)).rejects.toThrow('backup_stream_invalid')
})

test('authenticated metadata from another phone is not accepted as an upload belonging to this destination', async () => {
  const f = fixture(), keys = storageUploadKeys(phone, uploadId), parts: Buffer[] = []
  const foreign = { ...manifest, phone: '999987654321', objectKey: manifest.objectKey.replace(phone, '999987654321') }
  for await (const part of encryptSessionStream({ kind: 'sqlite-session', version: 1, manifest: foreign, supplement: {} }, (async function* () {})(), password)) parts.push(part)
  f.json.set(keys.receipt, f.receipt()); f.blobs.set(keys.archive, Buffer.concat(parts))
  await expect(uploadedBackupService(phone, uploadId, config, password)).rejects.toThrow('manifest_invalid')
  expect(f.objects.remove).not.toHaveBeenCalled(); expect(sessionStorageRpc).not.toHaveBeenCalled()
})

test('upload janitor deletes only matching expired receipts/archives, preserving fresh staging, permanent backups, media and another phone', async () => {
  const f = fixture(), expired = storageUploadKeys(phone, uploadId), fresh = storageUploadKeys(phone, archiveId)
  f.json.set(expired.receipt, f.receipt({ expiresAt: Date.now() - 1 })); f.blobs.set(expired.archive, Buffer.from('expired'))
  f.json.set(fresh.receipt, f.receipt({ uploadId: archiveId })); f.blobs.set(fresh.archive, Buffer.from('fresh'))
  f.blobs.set(manifest.objectKey, Buffer.from('permanent')); f.json.set(manifest.objectKey + '.manifest.json', manifest)
  f.blobs.set(`${phone}/media/image.png`, Buffer.from('media'))
  const foreign = storageUploadKeys('999987654321', uploadId); f.json.set(foreign.receipt, f.receipt({ phone: '999987654321', expiresAt: Date.now() - 1 })); f.blobs.set(foreign.archive, Buffer.from('foreign'))
  expect(await cleanExpiredStorageUploads(phone, config, f.objects)).toEqual({ deleted: 1 })
  expect(jest.mocked(f.objects.remove).mock.calls.flat()).toEqual([expired.archive, expired.receipt])
  expect(f.blobs.has(fresh.archive)).toBe(true); expect(f.blobs.has(manifest.objectKey)).toBe(true); expect(f.blobs.has(foreign.archive)).toBe(true)
})

test('janitor respects active task locks and a lost lease; malformed scope is never a fallback authorization to delete', async () => {
  const f = fixture(), keys = storageUploadKeys(phone, uploadId), lock = `unoapi-session-storage:task:lock:${phone}`
  f.json.set(keys.receipt, f.receipt({ expiresAt: Date.now() - 1 })); f.locks.set(lock, 'active-task')
  expect(await cleanExpiredStorageUploads(phone, config, f.objects)).toEqual({ deleted: 0 }); expect(f.objects.keys).not.toHaveBeenCalled()
  f.locks.delete(lock)
  const original = jest.mocked(f.objects.json).getMockImplementation()!
  jest.mocked(f.objects.json).mockImplementation(async key => { const value = await original(key); f.locks.set(lock, 'replacement-task'); return value })
  await expect(cleanExpiredStorageUploads(phone, config, f.objects)).rejects.toThrow('lease_lost')
  expect(f.objects.remove).not.toHaveBeenCalled(); expect(f.locks.get(lock)).toBe('replacement-task')
  expect(await cleanExpiredStorageUploads(phone, { ...config, useS3: false }, f.objects)).toEqual({ deleted: 0 })
})

test('janitor ignores forged cross-scope receipts and stops its listing budget without deleting later unexamined objects', async () => {
  const f = fixture(), own = storageUploadKeys(phone, uploadId), foreign = storageUploadKeys('999987654321', uploadId)
  f.json.set(foreign.receipt, f.receipt({ expiresAt: Date.now() - 1 }))
  f.json.set(own.receipt, f.receipt({ uploadId: '../invalid', expiresAt: Date.now() - 1 }))
  jest.mocked(f.objects.keys).mockImplementationOnce(async function* () { yield foreign.receipt; yield own.receipt })
  expect(await cleanExpiredStorageUploads(phone, config, f.objects)).toEqual({ deleted: 0 }); expect(f.objects.remove).not.toHaveBeenCalled()
  f.json.set(own.receipt, f.receipt({ expiresAt: Date.now() - 1 }))
  jest.mocked(f.objects.keys).mockImplementationOnce(async function* () { for (let index = 0; index < 2001; index++) yield `backups/session-storage/${phone}/unrelated-${index}`; yield own.receipt })
  expect(await cleanExpiredStorageUploads(phone, config, f.objects)).toEqual({ deleted: 0 }); expect(f.objects.remove).not.toHaveBeenCalled()
})
