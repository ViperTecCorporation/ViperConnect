jest.mock('../../src/services/session_storage/capability', () => ({ storageCapability: jest.fn(() => ({ sqliteAvailable: false })), storageRoot: () => 'SYNTHETIC_UNUSED' }))
import { defaultConfig } from '../../src/services/config'
import { SessionStorageMaintenanceCoordinator, startStorageMaintenanceCoordinator, stopStorageMaintenanceCoordinator, tickStorageMaintenanceCoordinator } from '../../src/services/session_storage/coordinator_maintenance'

const phone = '5566000000198', owner = 'server_1', storageId = '12345678-1234-4234-8234-123456789abc'
const storage = { backend: 'sqlite' as const, storageId, owner, generation: 1, state: 'offline' as const }
const configKey = `unoapi-config:${phone}`, taskLock = `unoapi-session-storage:task:lock:${phone}`, receiptKey = `unoapi-session-storage:coordinator:${phone}`
const maintenance = { at: 100, deletedCompatibility: 5, deletedNative: 7, totalDeleted: 12, rowBudget: 500, budgetReached: false,
  freedPages: 1, fileShrunk: false as const, authCryptoPreserved: true as const, tombstonesPreserved: true as const }
function fixture() {
  const values = new Map([[configKey, JSON.stringify({ ...defaultConfig, provider: 'zapo', server: owner, autoConnect: false, sessionStorage: storage })]])
  const redis = { get: jest.fn(async (key: string) => values.get(key) ?? null), eval: jest.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
    const key = options.keys[0], token = options.arguments[0]
    if (script.includes('local c=cjson.decode')) {
      const current = JSON.parse(values.get(key)!), expected = JSON.parse(token)
      if (['owner', 'storageId', 'generation', 'backend', 'state'].some(field => current.sessionStorage[field] !== expected[field])) return 0
      values.set(options.keys[1], options.arguments[1]); return 1
    }
    if (script.includes("'EXISTS'")) { if (values.has(key)) return 0; values.set(key, token); return 1 }
    if (values.get(key) !== token) return 0
    if (script.includes("'DEL'")) values.delete(key)
    return 1
  }) }
  const lease = { acquire: jest.fn(async () => true), assertOwned: jest.fn(async () => {}), release: jest.fn(async () => {}), ownership: () => ({ key: 'synthetic', token: 'synthetic' }) }
  const deps = { owner, redis, phones: jest.fn(async () => [phone]), loadConfig: jest.fn(async () => JSON.parse(values.get(configKey)!)),
    busy: jest.fn(() => false), hasClient: jest.fn(() => false), lease: () => lease, maintain: jest.fn(() => maintenance),
    reconcile: jest.fn(async (_phone: string, _deps: any): Promise<any> => ({ status: 'not_needed', reason: 'no_storage_transition', transportEffects: false })), now: () => 100 }
  return { deps, values, service: new SessionStorageMaintenanceCoordinator(deps) }
}
afterEach(() => { stopStorageMaintenanceCoordinator(); jest.useRealTimers() })

test('stable owner-local SQLite is pruned with budget500 and writes a safe fenced receipt only', async () => {
  const f = fixture()
  expect(await f.service.tick()).toMatchObject({ maintained: 1, failed: 0 })
  expect(f.deps.maintain).toHaveBeenCalledWith(phone, expect.objectContaining({ sessionStorage: storage }), { now: 100, rowBudget: 500 })
  expect(JSON.parse(f.values.get(receiptKey)!)).toEqual({ at: 100, storageId, owner, generation: 1, transportEffects: false, maintenance })
  expect(f.values.has(taskLock)).toBe(false); expect(f.deps.reconcile).not.toHaveBeenCalled()
})

test.each(['other-owner', 'fixture', 'task-lock', 'inflight', 'redis'])('does not touch an ineligible database (%s)', async reason => {
  const f = fixture(), config = JSON.parse(f.values.get(configKey)!)
  if (reason === 'other-owner') config.sessionStorage.owner = 'other'
  if (reason === 'fixture') config.sessionStorage.fixture = true
  if (reason === 'redis') config.sessionStorage.backend = 'redis'
  if (reason === 'task-lock') f.values.set(taskLock, 'migration-task')
  if (reason === 'inflight') f.deps.busy.mockReturnValue(true)
  f.values.set(configKey, JSON.stringify(config))
  await f.service.tick(); expect(f.deps.maintain).not.toHaveBeenCalled(); expect(f.deps.reconcile).not.toHaveBeenCalled()
  if (reason === 'task-lock') expect(f.values.get(taskLock)).toBe('migration-task')
})

test('generation changed during reservation is reread and never prunes a stale UUID', async () => {
  const f = fixture(), next = JSON.parse(f.values.get(configKey)!); next.sessionStorage.generation = 2
  f.deps.loadConfig.mockResolvedValueOnce(JSON.parse(f.values.get(configKey)!)).mockResolvedValueOnce(next)
  expect(await f.service.tick()).toMatchObject({ waiting: 1, maintained: 0 })
  expect(f.deps.maintain).not.toHaveBeenCalled(); expect(f.values.has(taskLock)).toBe(false)
})

test('activity accepted during the last Redis await is rechecked before the synchronous prune', async () => {
  const f = fixture(), evaluate = f.deps.redis.eval.getMockImplementation()!
  f.deps.redis.eval.mockImplementation(async (script, options) => {
    const value = await evaluate(script, options)
    if (script.includes("'PEXPIRE'")) f.deps.busy.mockReturnValue(true)
    return value
  })
  expect(await f.service.tick()).toMatchObject({ waiting: 1, maintained: 0 })
  expect(f.deps.maintain).not.toHaveBeenCalled(); expect(f.values.has(taskLock)).toBe(false)
})

test('ticks cannot overlap even while waiting for configuration and stop prevents later work', async () => {
  const f = fixture(); let finish!: (value: any) => void
  f.deps.loadConfig.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = f.service.tick(); while (!finish) await Promise.resolve()
  expect(await f.service.tick()).toMatchObject({ skipped: true })
  f.service.stop(); finish(JSON.parse(f.values.get(configKey)!)); await first
  expect(f.deps.maintain).not.toHaveBeenCalled(); expect(await f.service.tick()).toMatchObject({ skipped: true })
})

test.each(['migrating', 'restoring', 'pending-journal'])('interrupted %s is reconciled without assuming Redis source validity', async reason => {
  const f = fixture(), config = JSON.parse(f.values.get(configKey)!)
  if (reason !== 'pending-journal') config.sessionStorage.state = reason
  else {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    f.values.set(`unoapi-session-storage:current-task:${phone}`, id)
    f.values.set(`unoapi-session-storage:journal:${phone}:${id}`, JSON.stringify({ phase: 'source_cleanup_failed' }))
  }
  f.values.set(configKey, JSON.stringify(config))
  f.deps.reconcile.mockImplementationOnce(async (_phone: any, deps: any) => {
    expect(await deps.verifyRedisSource(phone, config)).toBe(false)
    return { status: 'recovery_required', reason: 'session_storage_redis_source_unverified', action: 'inspect_journal_and_files', transportEffects: false }
  })
  expect(await f.service.tick()).toMatchObject({ reconciled: 1, maintained: 0 })
  expect(f.deps.maintain).not.toHaveBeenCalled()
  expect(JSON.parse(f.values.get(receiptKey)!).reconciliation.status).toBe('recovery_required')
})

test('untrusted storage errors persist only a safe code, never SQL, paths or credentials', async () => {
  const f = fixture(); f.deps.maintain.mockImplementationOnce(() => { throw new Error('password=secret; /sensitive/path; SELECT auth') })
  expect(await f.service.tick()).toMatchObject({ failed: 1 })
  expect(JSON.parse(f.values.get(receiptKey)!)).toEqual({ at: 100, storageId, owner, generation: 1, transportEffects: false, error: 'session_storage_maintenance_failed' })
})

test('start runs once, then every60s, and stop removes the timer without transport actions', async () => {
  jest.useFakeTimers(); const f = fixture()
  expect(await startStorageMaintenanceCoordinator(f.deps)).toEqual({ started: true })
  expect(await startStorageMaintenanceCoordinator(f.deps)).toEqual({ started: true })
  await jest.advanceTimersByTimeAsync(0)
  expect(f.deps.maintain).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(60000); expect(f.deps.maintain).toHaveBeenCalledTimes(2)
  stopStorageMaintenanceCoordinator(); await jest.advanceTimersByTimeAsync(60000)
  expect(f.deps.maintain).toHaveBeenCalledTimes(2); expect(await tickStorageMaintenanceCoordinator()).toEqual({ skipped: true })
})

test('without a confirmed persistent volume the default startup cannot open any session database', async () => {
  const previous = process.env.UNOAPI_PROCESS_ROLE; process.env.UNOAPI_PROCESS_ROLE = 'worker'
  try { expect(await startStorageMaintenanceCoordinator()).toEqual({ started: false }) }
  finally { if (previous === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = previous }
})
