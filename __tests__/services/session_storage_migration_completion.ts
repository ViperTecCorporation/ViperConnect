import { randomUUID } from 'node:crypto'
import { completeMigration, migrationCompletionKey, migrationCompletionLock, migrationCompletionResult, prepareMigrationCompletion, recordManualSourceCleanup, validateMigrationCompletion, RESUME_COMPLETED_MIGRATION_LUA, PREPARE_MIGRATION_COMPLETION_LUA } from '../../src/services/session_storage/migration_completion'
import { SessionStorageError } from '../../src/services/session_storage/types'

const phone = '999123456789'
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const plan: any = { phone, taskId: randomUUID(), storage: { backend: 'sqlite', storageId: randomUUID(), generation: 2, owner: 'server_1', state: 'offline' }, backupId: randomUUID(), digest: 'a'.repeat(64), resume: 'pending', cleanup: 'pending' }
  const values = new Map([[migrationCompletionKey(phone), JSON.stringify(plan)]])
  const redis = { get: jest.fn(async (key: string) => values.get(key) ?? null), eval: jest.fn(async (script: string, { keys, arguments: args }: any) => {
    if (script === PREPARE_MIGRATION_COMPLETION_LUA) { values.set(keys[3], args[0]); return 1 }
    if (script === RESUME_COMPLETED_MIGRATION_LUA) {
      if (values.has(keys[3])) return ''
      const p = JSON.parse(values.get(keys[1])!); p.resume = p.resume === 'pending' ? 'enabled' : p.resume; p.autoConnect = true
      const raw = JSON.stringify(p); values.set(keys[1], raw); return raw
    }
    if (script.includes("redis.call('EXISTS',KEYS[1])")) { if (values.has(keys[0])) return 0; values.set(keys[0], args[0]); return 1 }
    if (script.includes("redis.call('PEXPIRE'")) return values.get(keys[0]) === args[0] ? 1 : 0
    if (keys.length === 2) { if (values.get(keys[0]) !== args[0] || values.get(keys[1]) !== args[1]) return 0; values.set(keys[1], args[2]); return 1 }
    if (values.get(keys[0]) !== args[0]) return 0
    values.delete(keys[0]); return 1
  }) }
  const deps = { redis, owner: 'server_1', hasClient: () => false, effectsAllowed: () => true, dispatch: jest.fn(async () => {}), cleanup: jest.fn(async () => ({ deleted: 3, skipped: 0, missing: 0 })) }
  const read = () => JSON.parse(values.get(migrationCompletionKey(phone))!)
  return { plan, values, redis, deps, read }
}

test('backup handoff captures previous offline/fixture intent without re-enabling it', async () => {
  const f = fixture()
  expect((await prepareMigrationCompletion(f.redis, f.plan, { eligible: false, fixture: false })).resume).toBe('skipped')
  expect((await prepareMigrationCompletion(f.redis, f.plan, { eligible: true, fixture: true })).reason).toBe('fixture')
  expect((await prepareMigrationCompletion(f.redis, f.plan, { eligible: true, fixture: false })).resume).toBe('pending')
  f.redis.eval.mockResolvedValueOnce(0 as any)
  await expect(prepareMigrationCompletion(f.redis, f.plan, { eligible: true, fixture: false })).rejects.toThrow('configuration_changed')
})

test('dispatch precedes potentially slow cleanup, holds only the independent lock, and exposes requested not Online', async () => {
  const f = fixture(); let finish!: () => void
  f.deps.cleanup.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve }); return { deleted: 3, skipped: 0, missing: 0 } })
  const running = completeMigration(phone, f.deps); await flush()
  expect(f.deps.dispatch).toHaveBeenCalledTimes(1); expect(f.read().resume).toBe('requested')
  expect(f.read().cleanup).toBe('running'); expect(f.values.has(migrationCompletionLock(phone))).toBe(true)
  expect(f.values.has(`unoapi-session-storage:task:lock:${phone}`)).toBe(false)
  finish(); await running
  expect(f.read().cleanup).toBe('ready'); expect(f.values.has(migrationCompletionLock(phone))).toBe(false)
  const receipt: any = migrationCompletionResult(f.read(), f.plan.taskId, { counts: { nativeRecords: 3 }, autoConnect: false })
  expect(receipt).toMatchObject({ autoConnect: true, sourcePreserved: false, reconnect: { status: 'requested' }, counts: { nativeRecords: 3 }, sourceCleanup: { deleted: 3, status: 'ready' } })
  expect(JSON.stringify(receipt)).not.toContain(f.plan.digest)
  await completeMigration(phone, f.deps); expect(f.deps.dispatch).toHaveBeenCalledTimes(1)
})

test('active lifecycle reservation prevents dispatch and cleanup, and a later owner tick resumes the durable work', async () => {
  const f = fixture(), lock = `unoapi-session-storage:task:lock:${phone}`
  f.values.set(lock, 'still-migrating'); await completeMigration(phone, f.deps)
  expect(f.deps.dispatch).not.toHaveBeenCalled(); expect(f.deps.cleanup).not.toHaveBeenCalled()
  f.values.delete(lock); await completeMigration(phone, f.deps)
  expect(f.read().cleanup).toBe('ready'); expect(f.deps.dispatch).toHaveBeenCalledTimes(1)
})

test('crash recovery of running cleanup is idempotent without redispatching a requested reconnect', async () => {
  const f = fixture(); f.plan.resume = 'requested'; f.plan.cleanup = 'running'
  f.values.set(migrationCompletionKey(phone), JSON.stringify(f.plan))
  await completeMigration(phone, f.deps)
  expect(f.deps.dispatch).not.toHaveBeenCalled(); expect(f.deps.cleanup).toHaveBeenCalledTimes(1)
})

test('mutated/unknown keys remain visible as preserved source, never migration rollback', async () => {
  const f = fixture(); f.deps.cleanup.mockResolvedValueOnce({ deleted: 2, skipped: 1, missing: 0 })
  await completeMigration(phone, f.deps)
  expect(f.read().cleanup).toBe('diverged')
  expect(migrationCompletionResult(f.read(), f.plan.taskId, {})).toMatchObject({ sourcePreserved: true, sourceCleanup: { status: 'diverged' } })
})

test('dispatch failure and a failed verification remain distinct, with sanitized errors and source retained', async () => {
  const f = fixture(); f.deps.dispatch.mockRejectedValueOnce(new Error('private AMQP credential'))
  f.deps.cleanup.mockRejectedValueOnce(new Error('private storage path'))
  await completeMigration(phone, f.deps)
  expect(f.read()).toMatchObject({ resume: 'failed', reason: 'dispatch_failed', cleanup: 'failed', error: 'session_storage_source_cleanup_failed' })
  expect(JSON.stringify(f.read())).not.toContain('private')
})

test('a lifecycle race pauses cleanup instead of interrupting the session or forcing deletion', async () => {
  const f = fixture(); f.deps.cleanup.mockRejectedValueOnce(new SessionStorageError(409, 'session_storage_cleanup_operation_in_progress'))
  await completeMigration(phone, f.deps); expect(f.read().cleanup).toBe('pending')
  await completeMigration(phone, f.deps); expect(f.read().cleanup).toBe('ready'); expect(f.deps.dispatch).toHaveBeenCalledTimes(1)
})

test('foreign owners and malformed completion metadata cannot dispatch or delete', async () => {
  const f = fixture(); await completeMigration(phone, { ...f.deps, owner: 'server_2' })
  expect(f.deps.dispatch).not.toHaveBeenCalled(); expect(f.deps.cleanup).not.toHaveBeenCalled()
  for (const patch of [{ digest: 'bad' }, { cleanup: 'invented' }, { storage: { ...f.plan.storage, state: 'migrating' } }]) {
    expect(() => validateMigrationCompletion({ ...f.plan, ...patch })).toThrow('completion_invalid')
  }
  expect(migrationCompletionResult(f.plan, randomUUID(), { untouched: true })).toEqual({ untouched: true })
})

test('verified manual cleanup resolves the matching receipt and cannot restore old connection intent', async () => {
  const f = fixture(), taskId = randomUUID(), result = { deleted: 3, skipped: 0, missing: 0 }
  const evalLua = jest.fn(async () => 1), redis = { ...f.redis, eval: evalLua }
  expect(await recordManualSourceCleanup(redis, phone, f.plan.storage, taskId, result)).toBe(true)
  const args: any = evalLua.mock.calls[0]
  const updated = JSON.parse(args[1].arguments[2])
  expect(updated).toMatchObject({ cleanup: 'ready', resume: 'skipped', reason: 'manual_source_cleanup', autoConnect: false, cleanupResult: result })
  expect(updated.taskId).toBe(f.plan.taskId)
  expect(await recordManualSourceCleanup(redis, phone, { ...f.plan.storage, generation: 99 }, taskId, result)).toBe(false)
  expect(evalLua).toHaveBeenCalledTimes(1)
})
