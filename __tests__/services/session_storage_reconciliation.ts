import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/services/config'
import { openSessionDatabase, closeAllSessionDatabases } from '../../src/services/session_storage/database'
import { migrationPaths } from '../../src/services/session_storage/migration'
import { reconcileInterruptedStorage, RECONCILE_INTERRUPTED_STORAGE_LUA, ReconciliationConfig } from '../../src/services/session_storage/reconciliation'

const phone = '999123456789', owner = 'synthetic_owner'
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'viper-storage-reconcile-')) })
afterEach(async () => { closeAllSessionDatabases(); await rm(directory, { recursive: true, force: true }) })
function fixture(operation: 'migration' | 'restore' = 'migration') {
  const taskId = randomUUID(), storageId = randomUUID(), destination = operation === 'restore' ? randomUUID() : storageId, token = randomUUID()
  const config: ReconciliationConfig = { provider: 'zapo', server: owner, baseStore: directory, autoConnect: false, sessionStorageTaskId: taskId,
    sessionStorage: { backend: operation === 'restore' ? 'sqlite' : 'redis', storageId, owner, generation: 3, state: operation === 'restore' ? 'restoring' : 'migrating' } }
  const configKey = `unoapi-config:${phone}`, taskKey = `unoapi-session-storage:task:${phone}:${taskId}`, journalKey = `unoapi-session-storage:journal:${phone}:${taskId}`, lockKey = `unoapi-lease:zapo-session:${phone}`
  const values = new Map<string, string>([
    [configKey, JSON.stringify(config)], [taskKey, JSON.stringify({ id: taskId, phone, operation, status: 'running', createdAt: Date.now() - 700000, updatedAt: Date.now() - 700000, progress: { phase: 'copying' } })],
    [journalKey, JSON.stringify({ phone, taskId, storageId: destination, generation: 3, phase: operation === 'restore' ? 'restore_prepared' : 'copying' })],
  ])
  let beforeEval: (() => void) | undefined
  const redis = { get: jest.fn(async (key: string) => values.get(key) ?? null), eval: jest.fn(async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
    expect(script).toBe(RECONCILE_INTERRUPTED_STORAGE_LUA); beforeEval?.()
    const current = JSON.parse(values.get(keys[0]) || 'null'), old = JSON.parse(args[0]), s = current?.sessionStorage
    if (!current || current.provider !== 'zapo' || current.server !== old.owner || current.autoConnect !== false || current.mobilePrimaryDeleting || current.sessionStorageUnlinked || current.sessionStorageTaskId !== args[1] || !s
      || ['backend', 'storageId', 'owner', 'generation', 'state', 'fixture'].some(key => s[key] !== old[key]) || values.get(keys[1]) !== args[2] || values.has(keys[2]) || values.get(keys[3]) !== args[3] || values.get(keys[4]) !== args[4]) return 0
    current.sessionStorage = JSON.parse(args[5]); current.autoConnect = false; delete current.sessionStorageTaskId
    const task = JSON.parse(args[3]); task.status = 'interrupted'; task.error = 'session_storage_reconciled_offline'; task.updatedAt = Number(args[7]); task.progress = { phase: 'reconciled_offline' }; delete task.result
    values.set(keys[0], JSON.stringify(current)); values.set(keys[3], JSON.stringify(task)); values.set(keys[4], args[6]); return 1
  }) }
  const lease = { acquire: jest.fn(async () => { if (values.has(lockKey)) return false; values.set(lockKey, token); return true }),
    assertOwned: jest.fn(async () => { if (values.get(lockKey) !== token) throw new Error('synthetic_lease_lost') }),
    ownership: () => ({ key: lockKey, token }), release: jest.fn(async () => { if (values.get(lockKey) === token) values.delete(lockKey) }) }
  const deps = { owner, redis, loadConfig: jest.fn(async () => JSON.parse(values.get(configKey)!)), hasClient: jest.fn(() => false), lease: () => lease, verifyRedisSource: jest.fn(async () => true) }
  const change = (key: string, patch: object) => values.set(key, JSON.stringify({ ...JSON.parse(values.get(key)!), ...patch }))
  return { config, taskId, storageId, destination, values, configKey, taskKey, journalKey, lockKey, redis, lease, deps, change, beforeEval: (hook: () => void) => { beforeEval = hook } }
}

test.each(['prepared', 'copying', 'failed'])('pre-promotion Redis phase %s is safely reconciled offline without deleting staging or reconnecting', async phase => {
  const f = fixture(); f.change(f.journalKey, { phase })
  const paths = migrationPaths(directory, f.storageId, f.taskId)
  await mkdir(paths.directory, { recursive: true }); await writeFile(paths.staged, 'preserve-partial-staging')
  expect(await reconcileInterruptedStorage(phone, f.deps)).toEqual({ status: 'repaired', reason: 'session_storage_reconciled_offline', action: 'retry_migration', backend: 'redis', generation: 4, transportEffects: false })
  expect(JSON.parse(f.values.get(f.configKey)!)).toMatchObject({ autoConnect: false, sessionStorage: { backend: 'redis', state: 'offline', generation: 4 } })
  expect(JSON.parse(f.values.get(f.taskKey)!)).toMatchObject({ status: 'interrupted', error: 'session_storage_reconciled_offline' })
  expect(await readFile(paths.staged, 'utf8')).toBe('preserve-partial-staging')
  expect(f.deps.verifyRedisSource).toHaveBeenCalledTimes(1); expect(f.lease.release).toHaveBeenCalledTimes(1)
})

test('unverified Redis source or any promoted file remains actionable recovery_required, never guessed as a cutover', async () => {
  const f = fixture(); f.deps.verifyRedisSource.mockResolvedValueOnce(false)
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'recovery_required', reason: 'session_storage_redis_source_unverified' })
  const cfg = { ...f.config, sessionStorage: { ...f.config.sessionStorage!, backend: 'sqlite' as const } } as Config
  openSessionDatabase(phone, cfg, { create: true })
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'recovery_required', reason: 'session_storage_file_promotion_requires_review' })
  expect(f.redis.eval).not.toHaveBeenCalled()
})

test('interrupted restore before file promotion returns to the intact old SQLite UUID, offline only', async () => {
  const f = fixture('restore'), db = openSessionDatabase(phone, f.config as Config, { create: true })
  db.putValue('synthetic-history', 'preserved')
  // A partially pruned expired mapping is not an active identity conflict.
  db.run('INSERT INTO uno_kv VALUES(?,?,?,?)', [`unoapi-id:${phone}:expired`, Buffer.from('UNO_EXPIRED'), 'raw', 1])
  const paths = migrationPaths(directory, f.destination, f.taskId); await mkdir(paths.directory, { recursive: true }); await writeFile(paths.staged, 'partial-new-restore')
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'repaired', action: 'retry_restore', backend: 'sqlite', generation: 4, transportEffects: false })
  expect(JSON.parse(f.values.get(f.configKey)!).sessionStorage.storageId).toBe(f.storageId)
  expect(db.getValue('synthetic-history')?.toString()).toBe('preserved')
  expect(await readFile(paths.staged, 'utf8')).toBe('partial-new-restore')
})

test.each(['invalid-old-identity', 'live-id-conflict', 'new-file-promoted', 'unknown-phase'])('ambiguous restore %s is never repaired or overwritten', async reason => {
  const f = fixture('restore'), db = openSessionDatabase(phone, f.config as Config, { create: true })
  if (reason === 'invalid-old-identity') db.run("UPDATE uno_storage_meta SET value='999000000000' WHERE key='phone'")
  if (reason === 'live-id-conflict') db.putValue(`unoapi-id:${phone}:provider`, 'UNO_LIVE')
  if (reason === 'new-file-promoted') { const paths = migrationPaths(directory, f.destination, f.taskId); await mkdir(paths.directory, { recursive: true }); await writeFile(paths.final, 'unverified-promoted-file') }
  if (reason === 'unknown-phase') f.change(f.journalKey, { phase: 'unrecognized_future_phase' })
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'recovery_required', action: 'inspect_journal_and_files' })
  expect(f.redis.eval).not.toHaveBeenCalled()
})

test.each(['client', 'autoConnect', 'task-lock', 'fresh-task', 'socket-lease', 'wrong-owner'])('active runtime condition %s prevents startup repair', async reason => {
  const f = fixture()
  if (reason === 'client') f.deps.hasClient.mockReturnValue(true)
  if (reason === 'autoConnect') f.change(f.configKey, { autoConnect: true })
  if (reason === 'task-lock') f.values.set(`unoapi-session-storage:task:lock:${phone}`, randomUUID())
  if (reason === 'fresh-task') f.change(f.taskKey, { updatedAt: Date.now() })
  if (reason === 'socket-lease') f.values.set(f.lockKey, randomUUID())
  if (reason === 'wrong-owner') f.deps.owner = 'other_owner'
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'waiting', transportEffects: false })
  expect(f.redis.eval).not.toHaveBeenCalled()
})

test.each(['autoConnect', 'lease', 'journal', 'task', 'fixture'])('atomic final CAS refuses concurrent %s changes without overwriting user intent', async reason => {
  const f = fixture()
  f.beforeEval(() => {
    if (reason === 'autoConnect') f.change(f.configKey, { autoConnect: true })
    if (reason === 'lease') f.values.set(f.lockKey, 'successor-lease')
    if (reason === 'journal') f.change(f.journalKey, { phase: 'file_promoted' })
    if (reason === 'task') f.change(f.taskKey, { updatedAt: Date.now() })
    if (reason === 'fixture') f.change(f.configKey, { sessionStorage: { ...f.config.sessionStorage!, fixture: true } })
  })
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'waiting', reason: 'session_storage_configuration_changed' })
  expect(JSON.parse(f.values.get(f.configKey)!).sessionStorage.state).toBe('migrating')
  if (reason === 'autoConnect') expect(JSON.parse(f.values.get(f.configKey)!).autoConnect).toBe(true)
  if (reason === 'lease') expect(f.values.get(f.lockKey)).toBe('successor-lease')
})

test('post-cutover source cleanup failure is reported as a required verified cleanup, never replayed automatically', async () => {
  const f = fixture()
  f.change(f.configKey, { sessionStorageTaskId: undefined, sessionStorage: { ...f.config.sessionStorage!, backend: 'sqlite', state: 'offline' } })
  f.values.set(`unoapi-session-storage:current-task:${phone}`, f.taskId)
  f.change(f.journalKey, { phase: 'source_cleanup_failed' }); f.change(f.taskKey, { status: 'failed' })
  expect(await reconcileInterruptedStorage(phone, f.deps)).toMatchObject({ status: 'recovery_required', action: 'verified_source_cleanup', transportEffects: false })
  expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.lease.acquire).not.toHaveBeenCalled()
})
