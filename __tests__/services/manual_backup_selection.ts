const mockValues = new Map<string, string>()
const mockRedis = { get: jest.fn(async (key: string) => mockValues.get(key) || null), eval: jest.fn(async () => 1) }
const mockSetConfig = jest.fn(async (phone: string, delta: any) => mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ ...JSON.parse(mockValues.get(`unoapi-config:${phone}`) || '{}'), ...delta })))
const mockDispatch = jest.fn(async () => {})
const mockNative = { on: jest.fn(), connect: jest.fn(async () => {}), disconnect: jest.fn(), get: mockRedis.get, eval: mockRedis.eval,
  set: jest.fn(async () => 'OK'),
  exists: jest.fn(async (key: string) => mockValues.has(key) ? 1 : 0), scan: jest.fn(async (_cursor: string, _match: string, pattern: string) => ['0', [...mockValues.keys()].filter(key => key.startsWith(pattern.slice(0, -1)))]), pttl: jest.fn(async () => -1), dumpBuffer: jest.fn(async () => Buffer.from([0, 255])) }
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => mockNative) }))
jest.mock('../../src/services/redis', () => ({ getRedis: async () => mockRedis, getConfig: async (phone: string) => { const value = mockValues.get(`unoapi-config:${phone}`); return value ? JSON.parse(value) : undefined },
  setConfig: (...args: any[]) => (mockSetConfig as any)(...args), configKey: (phone: string) => `unoapi-config:${phone}`, sessionPhoneIndexKey: () => 'unoapi-sessions:index', BASE_KEY: 'unoapi-' }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn(async () => ({})) }))
jest.mock('../../src/services/reload_amqp', () => ({ ReloadAmqp: class { run = mockDispatch } }))
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn(async () => {}) }))

import { MobileDeviceService } from '../../src/services/mobile_device_service'
import { createMobileBackupService } from '../../src/services/mobile_primary/backup_runtime'
import { createMobileBackupTasks } from '../../src/services/mobile_primary/backup_tasks'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { decryptMobileBackup } from '../../src/services/mobile_primary/backup_archive'
import { createSessionTransfer } from '../../src/services/session_transfer/runtime'
import { encryptSessionStream } from '../../src/services/session_transfer/archive_stream'

const phone = '999123456789', id = '12345678-1234-4234-8234-123456789abc', key = 'ab'.repeat(32), savedEnv = { ...process.env }
const draft = { id, phone, name: 'Synthetic', platform: 'android' as const, accountType: 'personal' as const, state: 'draft' as const, connectionMode: 'mobile_primary' as const, createdAt: new Date().toISOString(), createdBy: 'synthetic' }
const config = () => JSON.parse(mockValues.get(`unoapi-config:${phone}`)!)
beforeEach(() => {
  jest.clearAllMocks(); mockValues.clear(); process.env.MOBILE_REGISTRATION_KEY = key; process.env.UNOAPI_SERVER_NAME = 'owner_1'
  jest.spyOn(MobileDeviceService.prototype, 'get').mockResolvedValue(draft)
  mockValues.set(`mobile-primary:{v1}:registration:${id}`, new RegistrationVault(key).seal(id, { status: 'registered', sessionPhone: phone, canonicalPhone: phone, store: {} }))
  mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ provider: 'zapo', server: 'owner_1', useRedis: true, autoConnect: true, mobilePrimaryDraftId: id, mobilePrimaryImported: true }))
})
afterEach(() => { jest.restoreAllMocks(); process.env = { ...savedEnv } })

test('mobile direct and background exports reject SQLite before suspension, task reservation or dispatcher side effects', async () => {
  mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ ...config(), sessionStorage: { backend: 'sqlite', state: 'active' } }))
  const source = JSON.stringify([...mockValues]), service = await createMobileBackupService(), tasks = await createMobileBackupTasks()
  await expect(service.assertExportable(id)).rejects.toMatchObject({ status: 409, code: 'mobile_backup_sqlite_requires_session_storage_endpoint' })
  await expect(service.export(id, { password: 'synthetic-password', mode: 'complete', confirmSuspend: true })).rejects.toMatchObject({ status: 409, code: 'mobile_backup_sqlite_requires_session_storage_endpoint' })
  await expect(tasks.start(id, { password: 'synthetic-password', mode: 'complete', confirmSuspend: true })).rejects.toMatchObject({ status: 409, code: 'mobile_backup_sqlite_requires_session_storage_endpoint' })
  expect(JSON.stringify([...mockValues])).toBe(source); expect(mockSetConfig).not.toHaveBeenCalled(); expect(mockDispatch).not.toHaveBeenCalled(); expect(mockRedis.eval).not.toHaveBeenCalled()
})

test('Redis primary export works on installed 1.11.0, preserves native raw records and never exposes registration in preflight', async () => {
  const service = await createMobileBackupService(), preflight = await service.assertExportable(id)
  expect(preflight).toEqual({ phone, draftId: id }); expect(JSON.stringify(preflight)).not.toContain('store')
  for (const suffix of ['', ':noise_pub_key', ':noise_priv_key', ':identity_pub_key', ':identity_priv_key', ':signed_prekey_pub_key', ':signed_prekey_priv_key', ':signed_prekey_signature', ':adv_secret_key']) mockValues.set(`unoapi:zapo:auth:${phone}${suffix}`, 'synthetic')
  const result = await service.export(id, { password: 'synthetic-password', mode: 'complete', confirmSuspend: true })
  const archive = await decryptMobileBackup(result.archive, 'synthetic-password')
  expect(archive.zapo).toBe('1.11.0'); expect(archive.redisStore).toBe('1.3.0'); expect(archive.records).toHaveLength(9)
  expect(archive.records.every((record: any) => record.dump === Buffer.from([0, 255]).toString('base64'))).toBe(true)
  expect(config().autoConnect).toBe(false); expect(mockDispatch).toHaveBeenCalledWith(phone)
})

test('linked task preflight rejects SQLite before task reservation or source mutation', async () => {
  mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ provider: 'zapo', useRedis: true, autoConnect: true, sessionStorage: { backend: 'sqlite', state: 'offline' } }))
  const service = await createSessionTransfer(), before = JSON.stringify([...mockValues])
  await expect(service.tasks.start(phone, { password: 'synthetic-password', mode: 'complete', confirmSuspend: true })).rejects.toMatchObject({ code: 'session_backup_sqlite_requires_session_storage_endpoint' })
  expect(JSON.stringify([...mockValues])).toBe(before); expect(mockRedis.eval).not.toHaveBeenCalled(); expect(mockSetConfig).not.toHaveBeenCalled(); expect(mockDispatch).not.toHaveBeenCalled()
})

test('renamed encrypted SQLite stream is rejected before any Redis restore or connection request', async () => {
  const service = await createSessionTransfer(), chunks = [Buffer.from(JSON.stringify({ password: 'synthetic-password', confirmOriginOffline: true }) + '\n')]
  const records = async function* () { yield { offset: 0, data: 'AP8=' } }
  for await (const chunk of encryptSessionStream({ kind: 'sqlite-session', version: 1 }, records(), 'synthetic-password')) chunks.push(chunk)
  const before = JSON.stringify([...mockValues]), stream = async function* () { yield* chunks }
  await expect(service.restoreStream(stream())).rejects.toMatchObject({ code: 'session_backup_sqlite_requires_session_storage_endpoint' })
  expect(JSON.stringify([...mockValues])).toBe(before); expect(mockNative.connect).not.toHaveBeenCalled(); expect(mockSetConfig).not.toHaveBeenCalled(); expect(mockDispatch).not.toHaveBeenCalled()
})
