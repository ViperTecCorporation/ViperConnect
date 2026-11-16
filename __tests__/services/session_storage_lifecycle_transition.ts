jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
import { getRedis } from '../../src/services/redis'
import { configs, defaultConfig } from '../../src/services/config'
import { readSessionLifecycleConfig, sessionLifecycleIdentity, withSessionLifecycleTransition } from '../../src/services/session_storage/lifecycle_transition'
import { beginSessionStorageQuiesce, endSessionStorageQuiesce, hasSessionStorageActivity, waitSessionStorageIdle, withSessionStorageActivity } from '../../src/services/session_storage/activity'

const phone = '5566000000190'
const storage = { backend: 'redis' as const, storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1, state: 'active' as const }
const configuration = () => ({ ...defaultConfig, provider: 'zapo' as const, useRedis: true, sessionStorage: storage })
let token: string | undefined
const redis = { set: jest.fn(async (_key, value) => { if (token) return null; token = value; return 'OK' }),
  eval: jest.fn(async (script, options) => { if (token !== options.arguments[0]) return 0; if (script.includes("'DEL'")) token = undefined; return 1 }) }
beforeEach(() => { jest.clearAllMocks(); token = undefined; configs.delete(phone); endSessionStorageQuiesce(phone); (getRedis as jest.Mock).mockResolvedValue(redis) })
afterEach(() => { configs.delete(phone); endSessionStorageQuiesce(phone) })

test.each(['migrating', 'restoring', 'fixture'])('fresh lifecycle configuration rejects %s before stores or locks', async state => {
  const config: any = configuration(); config.sessionStorage = { ...storage, ...(state === 'fixture' ? { fixture: true } : { state }) }
  await expect(withSessionLifecycleTransition(phone, async () => config, jest.fn())).rejects.toThrow(state === 'fixture' ? 'external_effects_forbidden' : 'operation_in_progress')
  expect(redis.set).not.toHaveBeenCalled()
})

test('fresh lookup ignores a stale cached descriptor and rejects a generation change', async () => {
  const before = configuration(), after = { ...before, sessionStorage: { ...storage, generation: 2 } }
  configs.set(phone, before)
  const read = jest.fn(async () => { expect(configs.has(phone)).toBe(false); return after })
  await expect(readSessionLifecycleConfig(phone, read, sessionLifecycleIdentity(before))).rejects.toThrow('generation_changed')
})

test('forced freshness preserves the active media resolver only for the same storage identity', async () => {
  const previous = { ...configuration(), getMessageMetadata: jest.fn() }
  configs.set(phone, previous)
  const fresh = { ...configuration() }
  expect((await readSessionLifecycleConfig(phone, async () => fresh)).getMessageMetadata).toBe(previous.getMessageMetadata)
  configs.set(phone, previous)
  const changed = { ...configuration(), sessionStorage: { ...storage, generation: 2 } }
  expect((await readSessionLifecycleConfig(phone, async () => changed)).getMessageMetadata).not.toBe(previous.getMessageMetadata)
})

test('logout/reload reserve exactly the migration task key and never consume another reservation', async () => {
  token = 'migration-task'
  const run = jest.fn()
  await expect(withSessionLifecycleTransition(phone, async () => configuration(), run)).rejects.toThrow('operation_in_progress')
  expect(run).not.toHaveBeenCalled(); expect(token).toBe('migration-task')
  expect(redis.set).toHaveBeenCalledWith(`unoapi-session-storage:task:lock:${phone}`, expect.any(String), { NX: true, PX: 600000 })
})

test('transition rechecks state after reserving, releases only its own token and remains retryable', async () => {
  const read = jest.fn().mockResolvedValueOnce(configuration()).mockResolvedValueOnce({ ...configuration(), sessionStorage: { ...storage, state: 'restoring' } })
  await expect(withSessionLifecycleTransition(phone, read, jest.fn())).rejects.toThrow('operation_in_progress')
  expect(token).toBeUndefined()
  await expect(withSessionLifecycleTransition(phone, async () => configuration(), async (_config, check) => { await check(); return 'ok' })).resolves.toBe('ok')
})

test('lost transition reservation fences cleanup and cannot release the new owner', async () => {
  await expect(withSessionLifecycleTransition(phone, async () => configuration(), async (_config, check) => {
    token = 'another-task'; await check()
  })).rejects.toThrow('task_lost')
  expect(token).toBe('another-task')
})

test('file-only and legacy provider transitions do not require Redis', async () => {
  for (const config of [{ ...configuration(), useRedis: false }, { ...configuration(), provider: 'baileys' as const }]) {
    await expect(withSessionLifecycleTransition(phone, async () => config, async (_config, check) => (await check()).provider)).resolves.toBe(config.provider)
  }
  expect(getRedis).not.toHaveBeenCalled()
})

test('global synthetic guard fences even a new configuration without a storage descriptor', async () => {
  const previous = process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'
  try {
    await expect(withSessionLifecycleTransition(phone, async () => ({ ...defaultConfig, provider: 'zapo' }), jest.fn())).rejects.toThrow('external_effects_forbidden')
    expect(getRedis).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
    else process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = previous
  }
})

test('quiesce closes new job admission but lets accepted work finish before config changes', async () => {
  let finish!: () => void
  const accepted = withSessionStorageActivity(phone, () => new Promise<void>(resolve => { finish = resolve }))
  expect(hasSessionStorageActivity(phone)).toBe(true)
  beginSessionStorageQuiesce(phone)
  await expect(withSessionStorageActivity(phone, async () => undefined)).rejects.toThrow('operation_in_progress')
  let idle = false; const waiting = waitSessionStorageIdle(phone).then(() => { idle = true })
  await Promise.resolve(); expect(idle).toBe(false)
  finish(); await accepted; await waiting
  endSessionStorageQuiesce(phone)
  expect(hasSessionStorageActivity(phone)).toBe(false)
  await expect(withSessionStorageActivity(phone, async () => 'resumed')).resolves.toBe('resumed')
})
