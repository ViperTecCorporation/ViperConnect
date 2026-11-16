import { SessionStorageTasks, SessionBackupScheduler } from '../../src/services/session_storage/tasks'

const phone = '999123456789'
function redisFixture() {
  const values = new Map<string, string>()
  return { get: jest.fn(async (key: string) => values.get(key) || null), eval: jest.fn(async (_lua: string, input: { keys: string[]; arguments: string[] }) => {
    const [key, task, worker] = input.keys, [id, raw] = input.arguments
    if (_lua.includes("redis.call('EXISTS',KEYS[1])")) { if (values.has(key)) return 0; if (worker && values.has(worker)) return -1; values.set(key, id); values.set(task, raw); if (worker) values.set(worker, id); return 1 }
    if (_lua.includes("redis.call('PEXPIRE'")) { if (values.get(key) !== id || worker && values.get(worker) !== id) return 0; values.set(task, raw); return 1 }
    if (_lua.includes('for _,key in ipairs(KEYS)')) { let removed = 0; for (const k of input.keys) if (values.get(k) === id) { values.delete(k); removed++ }; return removed }
    if (values.get(key) !== id) return 0; values.delete(key); return 1
  }), values }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('a second number on the same worker is refused before its callback, task or session reservation', async () => {
  const redis = redisFixture(), tasks = new SessionStorageTasks(redis, 'worker_a'), secondPhone = '999987654321'
  let finish!: () => void
  const first = await tasks.start(phone, 'migration', async () => new Promise(resolve => { finish = () => resolve({ backupVerified: true }) }))
  const second = jest.fn(async () => {})
  await expect(tasks.start(secondPhone, 'migration', second)).rejects.toMatchObject({ status: 409, code: 'session_storage_worker_migration_busy' })
  expect(second).not.toHaveBeenCalled()
  expect(redis.values.has(`unoapi-session-storage:task:lock:${secondPhone}`)).toBe(false)
  expect([...redis.values.keys()].some(k => k.startsWith(`unoapi-session-storage:task:${secondPhone}:`))).toBe(false)
  finish(); await flush()
  expect((await tasks.status(phone, first.id)).status).toBe('ready')
  await tasks.start(secondPhone, 'migration', second); await flush()
  expect(second).toHaveBeenCalledTimes(1)
})

test('different owners can migrate in parallel and ordinary session operations are not worker-wide blocked', async () => {
  const redis = redisFixture(), a = new SessionStorageTasks(redis, 'worker_a'), b = new SessionStorageTasks(redis, 'worker_b')
  let release!: () => void
  await a.start(phone, 'migration', async () => new Promise<void>(resolve => { release = resolve }))
  const other = jest.fn(async () => {})
  await b.start('999987654321', 'migration', other); await flush(); expect(other).toHaveBeenCalledTimes(1)
  await a.start('999111111111', 'backup', other); await flush(); expect(other).toHaveBeenCalledTimes(2)
  release(); await flush()
})

test('failed migration releases its worker slot and cannot remove another task token', async () => {
  const redis = redisFixture(), tasks = new SessionStorageTasks(redis, 'worker_a'), workerLock = 'unoapi-session-storage:migration-lock:worker_a'
  const task = await tasks.start(phone, 'migration', async () => { throw new Error('synthetic failure') })
  await flush(); expect((await tasks.status(phone, task.id)).status).toBe('failed'); expect(redis.values.has(workerLock)).toBe(false)
  let finish!: () => void
  await tasks.start(phone, 'migration', async () => new Promise<void>(resolve => { finish = resolve }))
  redis.values.set(workerLock, 'other-owner-token'); finish(); await flush()
  expect(redis.values.get(workerLock)).toBe('other-owner-token')
})

test('worker reservation releases before post-backup reconnect/background cleanup, not after it', async () => {
  const redis = redisFixture(), tasks = new SessionStorageTasks(redis, 'worker_a')
  let inspected = false
  await tasks.start(phone, 'migration', async () => ({ backupVerified: true }), async () => {
    expect(redis.values.has('unoapi-session-storage:migration-lock:worker_a')).toBe(false); inspected = true
  })
  await flush(); expect(inspected).toBe(true)
})

test('heartbeat renews the worker reservation throughout long copy/backup work', async () => {
  jest.useFakeTimers()
  try {
    const redis = redisFixture(), tasks = new SessionStorageTasks(redis, 'worker_a')
    let finish!: () => void
    const task = await tasks.start(phone, 'migration', async () => new Promise<void>(resolve => { finish = resolve }))
    await jest.advanceTimersByTimeAsync(610000)
    expect((await tasks.status(phone, task.id)).status).toBe('running')
    expect(redis.eval.mock.calls.filter(call => call[0].includes('PEXPIRE') && call[1].keys[2] === 'unoapi-session-storage:migration-lock:worker_a').length).toBeGreaterThan(15)
    finish(); await jest.advanceTimersByTimeAsync(0)
    expect(redis.values.has('unoapi-session-storage:migration-lock:worker_a')).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})

test('post-commit effects run after durable ready and release, never under the migration lock', async () => {
  const redis = redisFixture(), tasks = new SessionStorageTasks(redis)
  let inspected = false
  const task = await tasks.start(phone, 'migration', async id => {
    expect(redis.values.get(`unoapi-session-storage:task:lock:${phone}`)).toBe(id)
    return { backupId: 'verified', sourcePreserved: true }
  }, async () => {
    expect(redis.values.has(`unoapi-session-storage:task:lock:${phone}`)).toBe(false)
    const stored = [...redis.values.entries()].find(([key]) => key.startsWith(`unoapi-session-storage:task:${phone}:`))![1]
    expect(JSON.parse(stored).status).toBe('ready'); inspected = true
  })
  await flush(); expect(inspected).toBe(true)
  expect((await tasks.status(phone, task.id)).status).toBe('ready')
  const reconnect = jest.fn(async () => {})
  await tasks.start(phone, 'migration', async () => { throw new Error('unverified backup') }, reconnect)
  await flush(); expect(reconnect).not.toHaveBeenCalled()
})

test('task persists progress/completion, uses same-session lock and exposes failures without private exceptions', async () => {
  const redis = redisFixture(), tasks = new SessionStorageTasks(redis)
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const task = await tasks.start(phone, 'migration', async (_id, progress) => { await progress({ phase: 'copying', processed: 2 }); await pending; return { sourcePreserved: true } })
  await flush(); expect((await tasks.status(phone, task.id)).progress.phase).toBe('copying')
  await expect(tasks.start(phone, 'backup', async () => {})).rejects.toThrow('session_storage_busy')
  finish(); await flush(); expect((await tasks.status(phone, task.id))).toMatchObject({ status: 'ready', result: { sourcePreserved: true } })
  const failed = await tasks.start(phone, 'backup', async () => { throw new Error('secret-private-path') }); await flush()
  expect(await tasks.status(phone, failed.id)).toMatchObject({ status: 'failed', error: 'session_storage_operation_failed' })
  expect(JSON.stringify(await tasks.status(phone, failed.id))).not.toContain('secret-private-path')
})

test('stale running task is reported interrupted and missing task is explicit', async () => {
  const redis = redisFixture(), tasks = new SessionStorageTasks(redis), id = 'd716024e-7424-48ab-85f5-815855d64363'
  redis.values.set(`unoapi-session-storage:task:${phone}:${id}`, JSON.stringify({ id, phone, status: 'running', updatedAt: Date.now() - 700000 }))
  expect((await tasks.status(phone, id)).status).toBe('interrupted')
  await expect(tasks.status(phone, 'not-id')).rejects.toThrow('session_storage_task_invalid')
  await expect(tasks.status(phone, 'a716024e-7424-48ab-85f5-815855d64363')).rejects.toThrow('session_storage_task_not_found')
})

test('scheduler claims UTC windows, continues after failure and runs only one backup at a time', async () => {
  let active = 0, max = 0
  const catalog: any = { reserveBackupWindow: jest.fn(async () => ({ token: 'synthetic' })), renewBackupWindow: jest.fn(async () => true), finishBackupWindow: jest.fn(async () => true) }
  const runtime = { enabled: () => true, sessions: jest.fn(async () => [phone, '999987654321']), backup: jest.fn(async (number: string) => { active++; max = Math.max(max, active); await flush(); active--; if (number === phone) throw new Error('upload failed') }) }
  const scheduler = new SessionBackupScheduler(catalog, runtime), run = scheduler.tick(43200001)
  expect(await scheduler.tick(43200001)).toEqual({ skipped: true, completed: 0, failed: 0 })
  expect(await run).toEqual({ skipped: false, completed: 1, failed: 1 }); expect(max).toBe(1)
  expect(catalog.reserveBackupWindow).toHaveBeenCalledWith(phone, 43200001)
  expect(catalog.finishBackupWindow).toHaveBeenCalledWith(phone, expect.anything(), false, 'session_storage_backup_failed')
  expect(catalog.finishBackupWindow).toHaveBeenCalledWith('999987654321', expect.anything(), true)
  catalog.reserveBackupWindow.mockResolvedValue(undefined); runtime.backup.mockClear(); await scheduler.tick(43200001); expect(runtime.backup).not.toHaveBeenCalled()
})

test('explicit false disables the scheduler, and task heartbeat renews long silent work then cleans timer', async () => {
  const old = process.env.SESSION_STORAGE_BACKUP_KEY, oldFile = process.env.SESSION_STORAGE_BACKUP_KEY_FILE, oldEnabled = process.env.SESSION_STORAGE_BACKUP_ENABLED
  delete process.env.SESSION_STORAGE_BACKUP_KEY; delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; process.env.SESSION_STORAGE_BACKUP_ENABLED = 'false'
  const runtime = { sessions: jest.fn(async () => [phone]), backup: jest.fn(async () => {}) }
  try { expect((await new SessionBackupScheduler({} as any, runtime).tick()).skipped).toBe(true); expect(runtime.sessions).not.toHaveBeenCalled() }
  finally { if (old !== undefined) process.env.SESSION_STORAGE_BACKUP_KEY = old; if (oldFile !== undefined) process.env.SESSION_STORAGE_BACKUP_KEY_FILE = oldFile; if (oldEnabled === undefined) delete process.env.SESSION_STORAGE_BACKUP_ENABLED; else process.env.SESSION_STORAGE_BACKUP_ENABLED = oldEnabled }
  jest.useFakeTimers()
  try {
    const redis = redisFixture(), tasks = new SessionStorageTasks(redis)
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve })
    const task = await tasks.start(phone, 'backup', async () => pending)
    await jest.advanceTimersByTimeAsync(610000)
    expect((await tasks.status(phone, task.id)).status).toBe('running')
    expect(redis.eval.mock.calls.filter(call => call[0].includes('PEXPIRE')).length).toBeGreaterThan(15)
    finish(); await jest.advanceTimersByTimeAsync(0)
    expect((await tasks.status(phone, task.id)).status).toBe('ready'); expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})

test.each([undefined, 'true'])('default or explicit enabled scheduler runs backups without legacy keys: %s', async enabled => {
  const saved = [process.env.SESSION_STORAGE_BACKUP_ENABLED, process.env.SESSION_STORAGE_BACKUP_KEY_FILE, process.env.SESSION_STORAGE_BACKUP_KEY]
  if (enabled === undefined) delete process.env.SESSION_STORAGE_BACKUP_ENABLED; else process.env.SESSION_STORAGE_BACKUP_ENABLED = enabled
  delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; delete process.env.SESSION_STORAGE_BACKUP_KEY
  try {
    const catalog: any = { reserveBackupWindow: jest.fn(async () => ({ token: 'synthetic' })), renewBackupWindow: jest.fn(async () => true), finishBackupWindow: jest.fn(async () => true) }
    const backup = jest.fn(async () => undefined)
    expect(await new SessionBackupScheduler(catalog, { sessions: async () => [phone], backup }).tick()).toMatchObject({ completed: 1, failed: 0 })
    expect(backup).toHaveBeenCalledWith(phone)
  } finally {
    for (const [index, name] of ['SESSION_STORAGE_BACKUP_ENABLED', 'SESSION_STORAGE_BACKUP_KEY_FILE', 'SESSION_STORAGE_BACKUP_KEY'].entries()) {
      if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]
    }
  }
})
