import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RedisGlobalBackupRoutine, RedisGlobalRoutineDependencies, RESERVE_REDIS_BACKUP_WINDOW_LUA, FINISH_REDIS_BACKUP_WINDOW_LUA } from '../../src/services/session_storage/redis_backup_runtime'

function redisFixture() {
  const values = new Map<string, string>()
  return { values, get: jest.fn(async (key: string) => values.get(key) || null), eval: jest.fn(async (script: string, input: { keys: string[]; arguments: string[] }) => {
    const [a, b] = input.keys, [one, two] = input.arguments
    if (script === RESERVE_REDIS_BACKUP_WINDOW_LUA) { if (values.has(a) || values.has(b)) return 0; values.set(a, one); return 1 }
    if (script === FINISH_REDIS_BACKUP_WINDOW_LUA) {
      if (values.get(a) !== one) return 0
      if (two === 'true') values.set(b, input.arguments[3])
      values.set(input.keys[2], input.arguments[2]); values.delete(a); return 1
    }
    if (script.includes("redis.call('GET',KEYS[1])") && values.get(a) !== one) return 0
    if (script.includes("redis.call('DEL'")) { values.delete(a); return 1 }
    if (script.includes("redis.call('PEXPIRE'")) return 1
    if (input.keys.length === 2) values.set(b, two); else values.set(a, one)
    return 1
  }) }
}
function fixture(redis = redisFixture(), overrides: NodeJS.ProcessEnv = {}) {
  const environment = { SESSION_STORAGE_REDIS_BACKUP_ENABLED: 'true', SESSION_STORAGE_REDIS_BACKUP_ALL_DATABASES: 'true', SESSION_STORAGE_REDIS_CLI_PATH: join(tmpdir(), 'redis-cli.exe'),
    SESSION_STORAGE_BACKUP_KEY_FILE: join(tmpdir(), 'fixture-backup.key'), REDIS_URL: 'redis://configured-secret@synthetic-redis:6379', STORAGE_ENDPOINT: 'https://synthetic-s3.invalid', STORAGE_BUCKET_NAME: 'synthetic-backups', UNOAPI_SERVER_NAME: 'server_1', ...overrides }
  const deps: RedisGlobalRoutineDependencies = { environment, redis: jest.fn(async () => redis), capability: jest.fn(async () => ({ available: true })), readKey: jest.fn(async () => 'dedicated-synthetic-backup-key'), log: jest.fn(),
    backup: jest.fn(async (input, index) => { const manifest = { id: randomUUID(), instanceId: input.instanceId, version: 1 as const, protection: 'none' as const, createdAt: new Date().toISOString(), objectKey: 'backups/redis/synthetic', bytes: 42, sha256: 'a'.repeat(64), status: 'ready' as const, scope: 'all-databases' as const, uploadVerified: true as const, rdbHeaderVerified: true as const }; await index.put(manifest); return manifest }) }
  return { deps, redis, routine: new RedisGlobalBackupRoutine(deps) }
}
async function until(predicate: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)) } throw new Error('condition_not_met') }

test('routine is disabled by default and never initializes Redis, S3, CLI or a backup key', async () => {
  const f = fixture(undefined, { SESSION_STORAGE_REDIS_BACKUP_ENABLED: 'false' })
  try {
    expect(await f.routine.start()).toMatchObject({ enabled: false, routineActive: false, phase: 'disabled' })
    expect(f.deps.redis).not.toHaveBeenCalled(); expect(f.deps.backup).not.toHaveBeenCalled(); expect(f.deps.capability).not.toHaveBeenCalled(); expect(f.deps.readKey).not.toHaveBeenCalled()
  } finally { f.routine.stop() }
})

test('enabled global routine needs no key file and never reads or forwards a configured legacy secret', async () => {
  for (const keyFile of [undefined, 'relative-optional-legacy-file']) {
    const f = fixture(undefined, { SESSION_STORAGE_BACKUP_KEY_FILE: keyFile })
    ;(f.deps.readKey as jest.Mock).mockRejectedValue(new Error('legacy_file_must_not_be_read_for_new_backup'))
    try {
      await f.routine.start(); await until(async () => (await f.routine.status()).phase === 'ready')
      expect(f.deps.readKey).not.toHaveBeenCalled()
      expect((f.deps.backup as jest.Mock).mock.calls[0][0]).not.toHaveProperty('backupPassword')
      expect(await f.routine.status()).toMatchObject({ protection: 'none', lastBackup: { protection: 'none' } })
    } finally { f.routine.stop() }
  }
})

test('missing CLI, all-database confirmation and synthetic guard are explicit capability failures, not active routines', async () => {
  const f = fixture(); (f.deps.capability as jest.Mock).mockResolvedValueOnce({ available: false, reason: 'redis_backup_cli_unavailable' })
  try {
    expect(await f.routine.start()).toMatchObject({ phase: 'unavailable', routineActive: false, error: 'redis_backup_cli_unavailable' })
    expect(f.deps.backup).not.toHaveBeenCalled(); expect(f.deps.log).toHaveBeenCalledWith('warn', expect.objectContaining({ code: 'redis_backup_cli_unavailable' }))
    const noConfirm = fixture(undefined, { SESSION_STORAGE_REDIS_BACKUP_ALL_DATABASES: 'false' })
    expect(await noConfirm.routine.start()).toMatchObject({ error: 'redis_backup_all_databases_confirmation_required' }); noConfirm.routine.stop()
    const synthetic = fixture(undefined, { UNOAPI_STORAGE_SYNTHETIC_ONLY: 'true' })
    expect(await synthetic.routine.start()).toMatchObject({ error: 'redis_backup_synthetic_runtime_disabled' }); synthetic.routine.stop()
  } finally { f.routine.stop() }
})

test('routine commits verified metadata, keeps secrets out of status/logs and shares half-day claims across different owners', async () => {
  const first = fixture(), second = fixture(first.redis, { UNOAPI_SERVER_NAME: 'server_2' })
  try {
    await first.routine.start(); await until(async () => (await first.routine.status()).phase === 'ready')
    await second.routine.start(); await new Promise(resolve => setImmediate(resolve))
    expect(first.deps.backup).toHaveBeenCalledTimes(1); expect(second.deps.backup).not.toHaveBeenCalled()
    const status = await second.routine.status()
    expect(status.shared).toMatchObject({ phase: 'ready', instanceId: 'server_1', lastBackup: { bytes: 42, uploadVerified: true } })
    expect(JSON.stringify(status)).not.toContain('configured-secret'); expect(JSON.stringify(status)).not.toContain('fixture-backup.key')
    expect(JSON.stringify((first.deps.log as jest.Mock).mock.calls)).not.toContain('dedicated-synthetic-backup-key')
    expect([...first.redis.values.keys()].filter(key => key.includes(':window:'))).toHaveLength(1)
    expect(first.redis.values.has('unoapi-infrastructure:redis-backup:running')).toBe(false)
  } finally { first.routine.stop(); second.routine.stop() }
})

test('failed backup records sanitized failure metadata and does not masquerade as a completed upload', async () => {
  const f = fixture(); (f.deps.backup as jest.Mock).mockRejectedValueOnce(new Error('private-source-url-with-password'))
  try {
    await f.routine.start(); await until(async () => (await f.routine.status()).phase === 'failed')
    const status = await f.routine.status()
    expect(status).toMatchObject({ phase: 'failed', error: 'redis_backup_failed' }); expect(status.shared).toMatchObject({ phase: 'failed', error: 'redis_backup_failed' })
    expect(status.lastBackup).toBeUndefined(); expect(JSON.stringify(status)).not.toContain('private-source')
    expect(f.deps.log).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'redis_backup_failed' }))
  } finally { f.routine.stop() }
})

test('routine heartbeat keeps a long job alive and stop clears polling without terminating a user service', async () => {
  jest.useFakeTimers()
  const f = fixture(); let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  ;(f.deps.backup as jest.Mock).mockImplementationOnce(async (input, index) => { await pending; const manifest = { id: randomUUID(), instanceId: input.instanceId, createdAt: new Date().toISOString(), bytes: 1, uploadVerified: true }; await index.put(manifest); return manifest })
  try {
    await f.routine.start(); await jest.advanceTimersByTimeAsync(31000)
    expect((await f.routine.status()).phase).toBe('running')
    expect(f.redis.eval.mock.calls.some(call => call[0].includes('PEXPIRE'))).toBe(true)
    f.routine.stop(); finish(); await jest.advanceTimersByTimeAsync(0)
    expect((await f.routine.status()).routineActive).toBe(false); expect(jest.getTimerCount()).toBe(0)
  } finally { finish?.(); f.routine.stop(); jest.useRealTimers() }
})

test('a later failed window preserves the previous verified receipt and invalid instance strings are not exposed', async () => {
  const first = fixture(), second = fixture(first.redis)
  try {
    await first.routine.start(); await until(async () => (await first.routine.status()).phase === 'ready')
    const previous = (await first.routine.status()).lastBackup; first.routine.stop()
    ;(second.deps.backup as jest.Mock).mockRejectedValueOnce(new Error('upload failed'))
    await second.routine.start(); await new Promise(resolve => setImmediate(resolve))
    expect(await second.routine.tick(Date.now() + 43200000)).toMatchObject({ status: 'failed' })
    expect((await second.routine.status()).shared?.lastBackup).toEqual(previous)
    const invalid = fixture(undefined, { SESSION_STORAGE_REDIS_BACKUP_INSTANCE_ID: 'https://private:secret@invalid' })
    const status = await invalid.routine.start()
    expect(status.error).toBe('redis_backup_instance_invalid'); expect(JSON.stringify(status)).not.toContain('private:secret'); invalid.routine.stop()
  } finally { first.routine.stop(); second.routine.stop() }
})

test('failed global upload releases the reservation and retries the same half-day instead of consuming it', async () => {
  const f = fixture(); (f.deps.backup as jest.Mock).mockRejectedValueOnce(new Error('private upload failure'))
  try {
    await f.routine.start()
    await until(async () => (await f.routine.status()).phase === 'failed' && !f.redis.values.has('unoapi-infrastructure:redis-backup:running'))
    expect([...f.redis.values.keys()].filter(key => key.includes(':window:'))).toEqual([])
    expect(await f.routine.tick()).toEqual({ status: 'ready' })
    expect(f.deps.backup).toHaveBeenCalledTimes(2)
    expect([...f.redis.values.keys()].filter(key => key.includes(':window:'))).toHaveLength(1)
    expect((await f.routine.status()).shared).toMatchObject({ phase: 'ready', lastBackup: { uploadVerified: true } })
    expect(await f.routine.tick()).toEqual({ status: 'skipped' })
  } finally { f.routine.stop() }
})

test('an in-flight global snapshot has no completed window and a stale owner cannot delete its successor lock', async () => {
  const f = fixture(); let finish!: () => void
  ;(f.deps.backup as jest.Mock).mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); throw new Error('failed after ownership loss') })
  try {
    await f.routine.start(); await until(async () => !!finish)
    expect([...f.redis.values.keys()].filter(key => key.includes(':window:'))).toEqual([])
    f.redis.values.set('unoapi-infrastructure:redis-backup:running', 'new-owner-token')
    finish(); await until(async () => (await f.routine.status()).phase === 'failed')
    await new Promise(resolve => setImmediate(resolve))
    expect(f.redis.values.get('unoapi-infrastructure:redis-backup:running')).toBe('new-owner-token')
    expect([...f.redis.values.keys()].filter(key => key.includes(':window:'))).toEqual([])
  } finally { finish?.(); f.routine.stop() }
})
