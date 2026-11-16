jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), getSessionPhones: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/redis_lease', () => ({ RedisLease: jest.fn() }))
jest.mock('../../src/services/session_storage/capability', () => ({ storageCapability: jest.fn(), requireStorageVolume: jest.fn(), storageRoot: jest.fn() }))

import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../../src/services/config'
import { clients } from '../../src/services/client'
import { getRedis } from '../../src/services/redis'
import { RedisLease } from '../../src/services/redis_lease'
import { storageCapability, requireStorageVolume, storageRoot } from '../../src/services/session_storage/capability'
import { createProvisionPending, RECORD_PROVISION_LUA } from '../../src/services/session_storage/provisioning'
import { STORAGE_CAS_LUA } from '../../src/services/session_storage/catalog'
import { executeStorageOperation } from '../../src/services/session_storage/runtime'
import { closeAllSessionDatabases, openSessionDatabase } from '../../src/services/session_storage/database'

const phone = '9990100000783', key = `unoapi-config:${phone}`, owner = 'worker_1'
const names = ['UNOAPI_SERVER_NAME', 'UNOAPI_STORAGE_WORKER_ID', 'UNOAPI_PROCESS_ROLE'] as const
let directory: string, env: Record<string, string | undefined>, values: Map<string, string>, config: any, redis: any, lease: any
beforeEach(() => {
  jest.clearAllMocks(); clients.clear(); directory = mkdtempSync(join(tmpdir(), 'uno-provision-worker-'))
  env = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.UNOAPI_SERVER_NAME = owner; process.env.UNOAPI_PROCESS_ROLE = 'worker'; delete process.env.UNOAPI_STORAGE_WORKER_ID
  config = { ...defaultConfig, provider: 'zapo', server: owner, baseStore: directory, autoConnect: false, sessionStorageProvisionPending: createProvisionPending(true) }
  values = new Map([[key, JSON.stringify(config)]])
  lease = { acquire: jest.fn(async () => true), renew: jest.fn(async () => true), release: jest.fn(async () => true) }
  jest.mocked(RedisLease).mockImplementation(() => lease)
  jest.mocked(storageRoot).mockReturnValue(directory); jest.mocked(requireStorageVolume).mockReturnValue(directory)
  jest.mocked(storageCapability).mockReturnValue({ sqliteAvailable: true, defaultBackend: 'sqlite' } as never)
  redis = { get: jest.fn(async k => values.get(k) || null),
    set: jest.fn(async (k, value) => { if (values.has(k)) return null; values.set(k, value); return 'OK' }),
    eval: jest.fn(async (script, options) => {
      if (script === STORAGE_CAS_LUA) {
        const current = JSON.parse(values.get(key)!), next = JSON.parse(options.arguments[2]), id = options.arguments[7]
        if (current.sessionStorage || current.sessionStorageProvisionPending?.id !== id || current.autoConnect !== false) return 0
        current.sessionStorage = next; current.sessionStorageProvisioned = { id, backend: next.backend, owner: next.owner, storageId: next.storageId, generation: next.generation }
        values.set(key, JSON.stringify(current)); return 1
      }
      if (script === RECORD_PROVISION_LUA) {
        if (values.get(key) !== options.arguments[0]) return 0
        const current = JSON.parse(values.get(key)!); current.sessionStorageProvisioned = JSON.parse(options.arguments[3]); values.set(key, JSON.stringify(current)); return 1
      }
      if (values.get(options.keys[0]) !== options.arguments[0]) return 0
      values.delete(options.keys[0]); return 1
    }) }
  jest.mocked(getRedis).mockResolvedValue(redis)
})
afterEach(() => {
  closeAllSessionDatabases(); clients.clear(); rmSync(directory, { recursive: true, force: true })
  for (const name of names) if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]
})
const run = () => executeStorageOperation(phone, config, 'provision', [{ provisionId: config.sessionStorageProvisionPending.id }])

test('worker prepares an actual SQLite file and commits descriptor plus matching receipt while still suspended', async () => {
  const result: any = await run(), saved = JSON.parse(values.get(key)!)
  expect(result.backend).toBe('sqlite'); expect(saved.autoConnect).toBe(false)
  expect(saved.sessionStorage.storageId).toBe(config.sessionStorageProvisionPending.id)
  expect(saved.sessionStorageProvisioned).toMatchObject({ id: config.sessionStorageProvisionPending.id, backend: 'sqlite', owner, generation: 1, storageId: saved.sessionStorage.storageId })
  const db = openSessionDatabase(phone, { ...saved, baseStore: directory })
  expect(db.get('PRAGMA quick_check')?.quick_check).toBe('ok')
  expect(db.get('SELECT value FROM uno_storage_meta WHERE key=?', ['phone'])?.value).toBe(phone)
  expect(lease.acquire).toHaveBeenCalledTimes(1); expect(lease.release).toHaveBeenCalledTimes(1)
})

test('intentional Redis fallback is durably receipted without preparing SQLite files', async () => {
  jest.mocked(storageCapability).mockReturnValue({ sqliteAvailable: false, defaultBackend: 'redis', reason: 'no_volume' } as never)
  expect((await run() as any).backend).toBe('redis')
  expect(JSON.parse(values.get(key)!)).toMatchObject({ autoConnect: false, sessionStorageProvisioned: { backend: 'redis', owner, generation: 0 } })
  expect(requireStorageVolume).not.toHaveBeenCalled(); expect(readdirSync(directory)).toEqual([])
})

test('a prepared-but-uncommitted file is reused under the same attempt ID on retry', async () => {
  const evaluate = redis.eval.getMockImplementation(); let fail = true
  redis.eval.mockImplementation(async (script, options) => {
    if (script === STORAGE_CAS_LUA && fail) { fail = false; throw new Error('lost_before_commit') }
    return evaluate(script, options)
  })
  await expect(run()).rejects.toThrow('lost_before_commit')
  expect(JSON.parse(values.get(key)!).sessionStorage).toBeUndefined()
  const before = readdirSync(join(directory, 'session-storage'))
  await run(); expect(readdirSync(join(directory, 'session-storage'))).toEqual(before)
  expect(before).toEqual([config.sessionStorageProvisionPending.id])
})

test('an already committed descriptor is verified and reuses its receipt instead of selecting another backend', async () => {
  await run(); const id = config.sessionStorageProvisionPending.id
  config = { ...config, ...JSON.parse(values.get(key)!) }
  jest.mocked(storageCapability).mockReturnValue({ sqliteAvailable: false, defaultBackend: 'redis' } as never)
  const result: any = await run()
  expect(result).toMatchObject({ backend: 'sqlite', receipt: { id, storageId: id } })
})

test.each(['active_client', 'foreign_lease', 'another_attempt', 'another_task'])('provision refuses %s before any database or backend change', async condition => {
  if (condition === 'active_client') clients.set(phone, {} as never)
  if (condition === 'foreign_lease') lease.acquire.mockResolvedValue(false)
  if (condition === 'another_attempt') values.set(key, JSON.stringify({ ...config, sessionStorageProvisionPending: createProvisionPending(true) }))
  if (condition === 'another_task') values.set(`unoapi-session-storage:task:lock:${phone}`, 'other-task')
  await expect(run()).rejects.toThrow(/session_storage_(provision_session_in_use|provision_changed|operation_in_progress)/)
  expect(JSON.parse(values.get(key)!).sessionStorage).toBeUndefined(); expect(readdirSync(directory)).toEqual([])
})
