import { SessionStorageTasks, SessionBackupScheduler } from '../../src/services/session_storage/tasks'

const phone = '999123456789'
function redisFixture() {
  const values = new Map<string, string>()
  return { get: jest.fn(async (key: string) => values.get(key) || null), eval: jest.fn(async (_lua: string, input: { keys: string[]; arguments: string[] }) => {
    const [key, task] = input.keys, [id, raw] = input.arguments
    if (_lua.includes("redis.call('EXISTS',KEYS[1])")) { if (values.has(key)) return 0; values.set(key, id); values.set(task, raw); return 1 }
    if (_lua.includes("redis.call('PEXPIRE'")) { if (values.get(key) !== id) return 0; values.set(task, raw); return 1 }
    if (values.get(key) !== id) return 0; values.delete(key); return 1
  }), values }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

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

test('scheduler needs explicit enablement, not a backup key, and task heartbeat renews long silent work then cleans timer', async () => {
  const old = process.env.SESSION_STORAGE_BACKUP_KEY, oldFile = process.env.SESSION_STORAGE_BACKUP_KEY_FILE, oldEnabled = process.env.SESSION_STORAGE_BACKUP_ENABLED
  delete process.env.SESSION_STORAGE_BACKUP_KEY; delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; delete process.env.SESSION_STORAGE_BACKUP_ENABLED
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

test('enabled scheduler runs new backups without any legacy key environment', async () => {
  const saved = [process.env.SESSION_STORAGE_BACKUP_ENABLED, process.env.SESSION_STORAGE_BACKUP_KEY_FILE, process.env.SESSION_STORAGE_BACKUP_KEY]
  process.env.SESSION_STORAGE_BACKUP_ENABLED = 'true'; delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; delete process.env.SESSION_STORAGE_BACKUP_KEY
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
