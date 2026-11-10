jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), getSessionPhones: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/capability', () => ({
  storageCapability: jest.fn(() => ({ sqliteAvailable: true, defaultBackend: 'sqlite' })),
  requireStorageVolume: jest.fn(), storageRoot: () => 'SYNTHETIC_UNUSED',
}))
jest.mock('../../src/services/session_storage/backup_runtime', () => ({
  sessionBackupPassword: jest.fn(() => undefined), sessionBackupService: jest.fn(), makeSessionBackup: jest.fn(), pruneSessionBackups: jest.fn(),
}))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
import { defaultConfig } from '../../src/services/config'
import { getRedis, getSessionPhones } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { executeStorageOperation, startStorageBackupScheduler } from '../../src/services/session_storage/runtime'
import { makeSessionBackup, pruneSessionBackups, sessionBackupPassword } from '../../src/services/session_storage/backup_runtime'
import logger from '../../src/services/logger'

const phone = '999123456789', savedKey = process.env.SESSION_STORAGE_BACKUP_KEY_FILE, savedEnabled = process.env.SESSION_STORAGE_BACKUP_ENABLED
const config: any = { ...defaultConfig, provider: 'zapo', server: 'server_1', useS3: true, autoConnect: false,
  sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 2, state: 'offline' } }
const values = new Map<string, string>()
beforeEach(() => {
  jest.clearAllMocks(); delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; values.clear()
  values.set(`unoapi-status:${phone}`, 'offline')
  ;(getRedis as jest.Mock).mockResolvedValue({ get: async (key: string) => values.get(key) ?? null, set: jest.fn(), eval: jest.fn(async () => 1) })
  ;(getConfigRedis as jest.Mock).mockResolvedValue(config); (getSessionPhones as jest.Mock).mockResolvedValue([phone])
  ;(makeSessionBackup as jest.Mock).mockResolvedValue({ id: 'plain-backup', protection: 'none' })
  ;(pruneSessionBackups as jest.Mock).mockResolvedValue({ deleted: 0, deferred: false })
})
afterAll(() => {
  if (savedKey === undefined) delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; else process.env.SESSION_STORAGE_BACKUP_KEY_FILE = savedKey
  if (savedEnabled === undefined) delete process.env.SESSION_STORAGE_BACKUP_ENABLED; else process.env.SESSION_STORAGE_BACKUP_ENABLED = savedEnabled
})

test.each([undefined, 'none', 'untrusted-label'])('status exposes plain policy, safe last protection %s and upload availability without consulting a key', async protection => {
  values.set(`unoapi-session-storage:last-backup:${phone}`, JSON.stringify({ id: 'synthetic', createdAt: '2026-11-08T00:00:00Z', bytes: 1, objectKey: 'safe', protection }))
  expect(await executeStorageOperation(phone, config, 'status', [])).toMatchObject({
    backupPolicy: { protection: 'none' }, restoreUpload: { available: true }, lastBackup: { protection: protection === 'none' ? 'none' : 'aes-256-gcm' },
  })
  expect(sessionBackupPassword).not.toHaveBeenCalled()
})

test('scheduler starts and runs new backups with no KEY_FILE and does not read a legacy secret', async () => {
  jest.useFakeTimers(); process.env.SESSION_STORAGE_BACKUP_ENABLED = 'true'
  try {
    await startStorageBackupScheduler(); await jest.advanceTimersByTimeAsync(0)
    expect(makeSessionBackup).toHaveBeenCalledWith(phone, expect.anything())
    expect(sessionBackupPassword).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  } finally { jest.clearAllTimers(); jest.useRealTimers() }
})

test('manual new backup acceptance does not require or read a legacy key', async () => {
  const task: any = await executeStorageOperation(phone, config, 'backup', [{ confirm: true }])
  await new Promise(resolve => setImmediate(resolve))
  expect(task).toMatchObject({ operation: 'backup', status: 'ready', result: { protection: 'none' } })
  expect(makeSessionBackup).toHaveBeenCalledWith(phone, expect.anything()); expect(sessionBackupPassword).not.toHaveBeenCalled()
})

test('raw upload preflight checks offline ownership without requiring a key before format discovery', async () => {
  const role = process.env.UNOAPI_PROCESS_ROLE, worker = process.env.UNOAPI_STORAGE_WORKER_ID
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'server_1'
  try {
    expect(await executeStorageOperation(phone, config, 'restore-upload-check', [])).toEqual({ allowed: true })
    expect(sessionBackupPassword).not.toHaveBeenCalled()
  } finally {
    if (role === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = role
    if (worker === undefined) delete process.env.UNOAPI_STORAGE_WORKER_ID; else process.env.UNOAPI_STORAGE_WORKER_ID = worker
  }
})
