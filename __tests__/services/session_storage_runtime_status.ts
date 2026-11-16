jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), getSessionPhones: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/offline_status', () => ({ publishOwnedStorageOffline: jest.fn(), reconcileStorageSessionOffline: jest.fn() }))
import { defaultConfig } from '../../src/services/config'
import { getRedis } from '../../src/services/redis'
import { executeStorageOperation } from '../../src/services/session_storage/runtime'
import { reconcileStorageSessionOffline } from '../../src/services/session_storage/offline_status'

const phone = '999123456789', savedRole = process.env.UNOAPI_PROCESS_ROLE, savedOwner = process.env.UNOAPI_STORAGE_WORKER_ID
const config: any = { ...defaultConfig, provider: 'zapo', server: 'worker_1', autoConnect: false, sessionStorage: { backend: 'sqlite', storageId: '93b7b52a-64a9-4b56-b871-76adcdfac120', owner: 'worker_1', generation: 2, state: 'offline' } }
let values: Map<string, string>, redis: any
beforeEach(() => {
  jest.clearAllMocks(); process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'worker_1'
  values = new Map([[`unoapi-status:${phone}`, 'online']]); redis = { get: jest.fn(async (key: string) => values.get(key) || null) }
  ;(getRedis as jest.Mock).mockResolvedValue(redis)
  ;(reconcileStorageSessionOffline as jest.Mock).mockImplementation(async () => { values.set(`unoapi-status:${phone}`, 'offline'); return true })
})
afterAll(() => { if (savedRole === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = savedRole; if (savedOwner === undefined) delete process.env.UNOAPI_STORAGE_WORKER_ID; else process.env.UNOAPI_STORAGE_WORKER_ID = savedOwner })

test('GET storage status remains observation only and never reconciles a stale online flag implicitly', async () => {
  expect(await executeStorageOperation(phone, config, 'status', [])).toMatchObject({ backend: 'sqlite', state: 'offline', generation: 2 })
  expect(reconcileStorageSessionOffline).not.toHaveBeenCalled(); expect(values.get(`unoapi-status:${phone}`)).toBe('online')
})

test('only the explicit confirmed internal owner operation repairs status, returning the actual canonical value', async () => {
  expect(await executeStorageOperation(phone, config, 'reconcile-status', [{ confirm: true }])).toEqual({ changed: true, status: 'offline' })
  expect(reconcileStorageSessionOffline).toHaveBeenCalledWith(phone, expect.objectContaining({ sessionStorage: config.sessionStorage }), expect.objectContaining({ redis, hasClient: expect.any(Function), lease: expect.any(Function) }))
})

test('unconfirmed input, Redis backend and the wrong owner cannot reconcile a session', async () => {
  await expect(executeStorageOperation(phone, config, 'reconcile-status', [])).rejects.toThrow('confirmation_required')
  await expect(executeStorageOperation(phone, config, 'reconcile-status', [{ confirm: true, extra: true }])).rejects.toThrow('confirmation_required')
  await expect(executeStorageOperation(phone, { ...config, sessionStorage: undefined }, 'reconcile-status', [{ confirm: true }])).rejects.toThrow('sqlite_required')
  await expect(executeStorageOperation(phone, { ...config, sessionStorage: { ...config.sessionStorage, owner: 'worker_2' } }, 'reconcile-status', [{ confirm: true }])).rejects.toThrow('wrong_owner')
  expect(reconcileStorageSessionOffline).not.toHaveBeenCalled()
})
