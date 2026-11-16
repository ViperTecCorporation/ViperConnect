jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/capability', () => ({ storageCapability: jest.fn(), requireStorageVolume: jest.fn(() => '/synthetic/worker-volume'), storageWorkerIdentity: jest.fn(() => ({ valid: true, worker: 'destination' })) }))
jest.mock('../../src/services/session_storage/backup_objects', () => ({ createBackupObjects: jest.fn() }))
jest.mock('../../src/services/session_storage/backup_upload', () => ({ uploadedBackupService: jest.fn(), storageUploadKeys: (phone: string, id: string) => ({ archive: `backups/session-storage/${phone}/uploads/${id}.viperstorage`, receipt: `backups/session-storage/${phone}/uploads/${id}.upload.json` }) }))
jest.mock('../../src/services/session_storage/standalone_recovery', () => ({ restoreStandaloneSession: jest.fn() }))
jest.mock('../../src/services/session_storage/standalone_web_tasks', () => ({ StandaloneWebTasks: jest.fn().mockImplementation(() => ({ execute: async (_phone: string, _id: string, _owner: string, run: any) => run() })) }))
jest.mock('../../src/services/session_storage/backup_runtime', () => ({ sessionBackupPassword: jest.fn(() => undefined) }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { getRedis } from '../../src/services/redis'
import { storageCapability } from '../../src/services/session_storage/capability'
import { createBackupObjects } from '../../src/services/session_storage/backup_objects'
import { uploadedBackupService } from '../../src/services/session_storage/backup_upload'
import { restoreStandaloneSession } from '../../src/services/session_storage/standalone_recovery'
import { executeStandaloneWebOperation, standaloneDestinationEmpty } from '../../src/services/session_storage/standalone_web_worker'
import { cleanExpiredStandaloneStaging, stagingIndexKey } from '../../src/services/session_storage/standalone_staging'
import { SessionStorageError } from '../../src/services/session_storage/types'

const phone = '999123456789', id = '12345678-1234-4234-8234-123456789abc', savedEnv = { ...process.env }
function fixture() {
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'destination'
  const values = new Map<string, string>(), json = new Map<string, any>()
  const redis: any = { scan: jest.fn(async () => ({ cursor: 0, keys: [...values.keys()] })), get: jest.fn(async (key: string) => values.get(key) || null), hGet: jest.fn(async () => null),
    del: jest.fn(async (key: string) => values.delete(key)) }
  const objects: any = { json: jest.fn(async (key: string) => json.has(key) ? { value: json.get(key), etag: 'synthetic' } : undefined),
    open: jest.fn(async () => Readable.from(['synthetic'])), remove: jest.fn(async (key: string) => { json.delete(key) }) }
  const manifest: any = { id: randomUUID(), phone, objectKey: `backups/session-storage/${phone}/${id}.viperstorage` }
  json.set(`backups/session-storage/${phone}/uploads/${id}.upload.json`, { phone, owner: 'destination', uploadId: id, confirmOriginOffline: true })
  jest.mocked(getRedis).mockResolvedValue(redis); jest.mocked(createBackupObjects).mockReturnValue(objects)
  jest.mocked(storageCapability).mockReturnValue({ sqliteAvailable: true } as any)
  jest.mocked(uploadedBackupService).mockResolvedValue({ manifest } as any)
  jest.mocked(restoreStandaloneSession).mockResolvedValue({ restored: true, phone, autoConnect: false, status: 'offline', connected: false, replayed: false } as any)
  return { values, json, redis, objects, manifest }
}
beforeEach(() => jest.clearAllMocks())
afterEach(() => { process.env = { ...savedEnv } })
test('absent-session worker capability/check neither resolves defaults nor registers a config', async () => {
  const f = fixture()
  expect(await executeStandaloneWebOperation(phone, 'destination', 'standalone.capability', [])).toMatchObject({ available: true })
  expect(await executeStandaloneWebOperation(phone, 'destination', 'standalone.check', [])).toMatchObject({ available: true })
  expect(f.values.size).toBe(0); expect(restoreStandaloneSession).not.toHaveBeenCalled()
  f.values.set(`unoapi-config:${phone}`, '{}')
  await expect(executeStandaloneWebOperation(phone, 'destination', 'standalone.check', [])).rejects.toThrow('destination_exists')
})
test('an unknown/foreign worker or missing persistent capability cannot restore', async () => {
  fixture()
  await expect(executeStandaloneWebOperation(phone, 'other', 'standalone.check', [])).rejects.toThrow('wrong_owner')
  process.env.UNOAPI_PROCESS_ROLE = 'web'
  await expect(executeStandaloneWebOperation(phone, 'destination', 'standalone.check', [])).rejects.toThrow('wrong_owner')
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; jest.mocked(storageCapability).mockReturnValue({ sqliteAvailable: false, reason: 'session_storage_persistent_mount_not_detected' } as any)
  await expect(executeStandaloneWebOperation(phone, 'destination', 'standalone.restore', [{ uploadId: id }])).rejects.toThrow('persistent_mount')
  expect(restoreStandaloneSession).not.toHaveBeenCalled()
})
test('worker maps only staged bytes into the existing fully validated standalone recovery and cleans successful staging', async () => {
  const f = fixture()
  const result = await executeStandaloneWebOperation(phone, 'destination', 'standalone.restore', [{ uploadId: id }])
  expect(result).toMatchObject({ autoConnect: false, status: 'offline', connected: false, replayed: false })
  const [input, deps] = jest.mocked(restoreStandaloneSession).mock.calls[0]
  expect(input).toEqual({ phone, backupId: f.manifest.id, confirm: true, confirmOriginOffline: true })
  expect(deps).toMatchObject({ owner: 'destination', baseStore: '/synthetic/worker-volume' })
  expect((await deps.objects.json(f.manifest.objectKey + '.manifest.json'))?.value).toBe(f.manifest)
  const source = await deps.objects.open(f.manifest.objectKey); source.destroy()
  expect(f.objects.open).toHaveBeenCalledWith(`backups/session-storage/${phone}/uploads/${id}.viperstorage`)
  await expect(deps.objects.open('backups/session-storage/999000000000/other.viperstorage')).rejects.toThrow('upload_invalid')
  expect(f.objects.remove).toHaveBeenCalledTimes(2)
})
test('corrupt/mismatched archive is not accepted as a successful restore and precommit staging is cleaned', async () => {
  const f = fixture(); jest.mocked(uploadedBackupService).mockRejectedValueOnce(new SessionStorageError(400, 'session_storage_upload_invalid'))
  await expect(executeStandaloneWebOperation(phone, 'destination', 'standalone.restore', [{ uploadId: id }])).rejects.toThrow('upload_invalid')
  expect(restoreStandaloneSession).not.toHaveBeenCalled(); expect(f.objects.remove).toHaveBeenCalledTimes(2)
})
test('post-promotion recovery failure preserves the archive/receipt for inspection, not another import', async () => {
  const f = fixture(), error: any = new SessionStorageError(503, 'session_storage_standalone_recovery_required'); error.recovery = { storageId: randomUUID() }
  jest.mocked(restoreStandaloneSession).mockRejectedValueOnce(error)
  await expect(executeStandaloneWebOperation(phone, 'destination', 'standalone.restore', [{ uploadId: id }])).rejects.toThrow('recovery_required')
  expect(f.objects.remove).not.toHaveBeenCalled()
})
test('own confirmed expired staging is cleaned even without a session config, foreign/active uploads are retained', async () => {
  const f = fixture(), expiresAt = Date.now() - 1, index = stagingIndexKey(phone, id)
  f.values.set(index, JSON.stringify({ phone, uploadId: id, owner: 'destination', expiresAt }))
  f.json.set(`backups/session-storage/${phone}/uploads/${id}.upload.json`, { phone, uploadId: id, owner: 'destination', expiresAt })
  const foreignId = randomUUID(); f.values.set(stagingIndexKey(phone, foreignId), JSON.stringify({ phone, uploadId: foreignId, owner: 'other', expiresAt }))
  f.values.set(`unoapi-session-storage:standalone-job:${phone}`, id)
  expect(await cleanExpiredStandaloneStaging('destination')).toMatchObject({ deleted: 0 })
  f.values.delete(`unoapi-session-storage:standalone-job:${phone}`)
  expect(await cleanExpiredStandaloneStaging('destination')).toMatchObject({ deleted: 1 })
  expect(f.objects.remove).toHaveBeenCalledTimes(2); expect(f.values.has(stagingIndexKey(phone, foreignId))).toBe(true)
  expect(await standaloneDestinationEmpty(phone)).toBe(true)
})
