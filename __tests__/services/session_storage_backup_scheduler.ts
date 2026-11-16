import { SessionStorageCatalog, RESERVE_BACKUP_WINDOW_LUA, FINISH_BACKUP_WINDOW_LUA } from '../../src/services/session_storage/catalog'
import { SessionBackupScheduler } from '../../src/services/session_storage/tasks'

const phone = '999123456789', halfDay = 43200000
const lockKey = `unoapi-session-storage:backup-scheduler-lock:${phone}`
const statusKey = `unoapi-session-storage:backup-schedule:${phone}`
const doneKey = (window: number) => `unoapi-session-storage:backup-window:${phone}:${window}`

/** Isolated model of the three allowlisted scheduler Lua commands, not a live Redis substitute. */
function fixture() {
  const values = new Map<string, string>(), deadlines = new Map<string, number>()
  const read = (key: string) => { if ((deadlines.get(key) ?? Infinity) <= Date.now()) { values.delete(key); deadlines.delete(key) }; return values.get(key) ?? null }
  const get = async (key: string) => read(key)
  const redis = { get, eval: jest.fn(async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
    if (script === RESERVE_BACKUP_WINDOW_LUA) {
      if (read(keys[0]) !== null || read(keys[1]) !== null) return 0
      values.set(keys[1], args[0]); deadlines.set(keys[1], Date.now() + Number(args[2]))
      const status = JSON.parse(read(keys[2]) || '{}')
      values.set(keys[2], JSON.stringify({ ...status, phase: 'running', window: Number(args[3]), updatedAt: Number(args[1]) })); return 1
    }
    if (script === FINISH_BACKUP_WINDOW_LUA) {
      if (read(keys[1]) !== args[0]) return 0
      const status = JSON.parse(read(keys[2]) || '{}'), at = Number(args[1]), window = Number(args[2])
      if (args[3] === 'true') { values.set(keys[0], args[1]); deadlines.set(keys[0], Date.now() + 259200000); status.lastSuccess = { at, window } }
      else status.lastError = { at, window, code: args[4] }
      values.set(keys[2], JSON.stringify({ ...status, phase: args[3] === 'true' ? 'ready' : 'failed', window, updatedAt: at })); values.delete(keys[1]); deadlines.delete(keys[1]); return 1
    }
    if (script.includes("redis.call('PEXPIRE'")) {
      if (read(keys[0]) !== args[0]) return 0
      deadlines.set(keys[0], Date.now() + Number(args[1])); return 1
    }
    throw new Error('unmodeled_scheduler_lua')
  }) }
  return { redis, values, deadlines, catalog: new SessionStorageCatalog(redis) }
}
const runtime = (backup: (phone: string) => Promise<void>) => ({ enabled: () => true, sessions: async () => [phone], backup })

test('a failed upload releases its reservation, retries in the same UTC window and retains both sanitized receipts', async () => {
  const f = fixture(), run = jest.fn<Promise<void>, []>(async () => { throw new Error('https://private:secret@example.test/private-path') })
  const scheduler = new SessionBackupScheduler(f.catalog, runtime(run))
  expect(await scheduler.tick(halfDay + 1)).toEqual({ skipped: false, completed: 0, failed: 1 })
  expect(f.values.has(doneKey(1))).toBe(false); expect(await f.redis.get(lockKey)).toBeNull()
  expect(await f.catalog.backupScheduleStatus(phone)).toMatchObject({ phase: 'failed', lastError: { window: 1, code: 'session_storage_backup_failed' } })
  expect(JSON.stringify(await f.catalog.backupScheduleStatus(phone))).not.toContain('private')
  run.mockImplementationOnce(async () => undefined)
  expect(await scheduler.tick(halfDay + 2)).toEqual({ skipped: false, completed: 1, failed: 0 })
  expect(await f.catalog.backupScheduleStatus(phone)).toMatchObject({ phase: 'ready', lastSuccess: { window: 1 }, lastError: { code: 'session_storage_backup_failed' } })
  const restarted = new SessionBackupScheduler(f.catalog, runtime(run))
  expect((await restarted.tick(halfDay + 3)).completed).toBe(0); expect(run).toHaveBeenCalledTimes(2)
})

test('separate scheduler instances and different UTC windows cannot overlap the same session backup', async () => {
  const f = fixture(); let finish!: () => void
  const backup = jest.fn(async () => new Promise<void>(resolve => { finish = resolve }))
  const first = new SessionBackupScheduler(f.catalog, runtime(backup)).tick(halfDay + 1)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  expect((await new SessionBackupScheduler(f.catalog, runtime(backup)).tick(halfDay * 2 + 1)).completed).toBe(0)
  expect(backup).toHaveBeenCalledTimes(1); finish()
  expect((await first).completed).toBe(1)
  expect(f.values.has(doneKey(1))).toBe(true); expect(f.values.has(doneKey(2))).toBe(false)
})

test('simultaneous owner reservations select exactly one token atomically', async () => {
  const f = fixture(), reservations = await Promise.all(Array.from({ length: 20 }, () => f.catalog.reserveBackupWindow(phone, halfDay)))
  expect(reservations.filter(Boolean)).toHaveLength(1)
  expect(await f.redis.get(lockKey)).toBe(reservations.find(Boolean)?.token)
})

test('heartbeat keeps a long snapshot reserved and cleans every timer after completion', async () => {
  jest.useFakeTimers()
  try {
    const f = fixture(); let finish!: () => void
    const backup = jest.fn(async () => new Promise<void>(resolve => { finish = resolve }))
    const run = new SessionBackupScheduler(f.catalog, runtime(backup)).tick()
    await jest.advanceTimersByTimeAsync(610000)
    expect(backup).toHaveBeenCalledTimes(1); expect(await f.redis.get(lockKey)).not.toBeNull()
    expect(f.redis.eval.mock.calls.filter(([script]) => script.includes("redis.call('PEXPIRE'")).length).toBeGreaterThan(15)
    expect((await new SessionBackupScheduler(f.catalog, runtime(backup)).tick()).completed).toBe(0)
    finish(); expect((await run).completed).toBe(1); expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})

test('a crashed reservation expires; stale owners cannot renew, publish success or release a successor lock', async () => {
  jest.useFakeTimers()
  try {
    const f = fixture(), old = (await f.catalog.reserveBackupWindow(phone))!
    await jest.advanceTimersByTimeAsync(120001)
    const next = (await f.catalog.reserveBackupWindow(phone))!
    expect(next.token).not.toBe(old.token)
    expect(await f.catalog.renewBackupWindow(phone, old)).toBe(false)
    expect(await f.catalog.finishBackupWindow(phone, old, true)).toBe(false)
    expect(await f.catalog.finishBackupWindow(phone, old, false)).toBe(false)
    expect(await f.redis.get(lockKey)).toBe(next.token)
    expect(await f.catalog.finishBackupWindow(phone, next, false, 'session_storage_snapshot_invalid')).toBe(true)
    expect(await f.catalog.reserveBackupWindow(phone)).toBeDefined()
    expect(await f.catalog.backupScheduleStatus(phone)).toMatchObject({ phase: 'running', lastError: { code: 'session_storage_snapshot_invalid' } })
  } finally { jest.useRealTimers() }
})

test('lease loss after a completed upload cannot masquerade as a successful scheduled backup', async () => {
  const f = fixture()
  const backup = async () => { f.values.set(lockKey, 'successor-owner') }
  expect(await new SessionBackupScheduler(f.catalog, runtime(backup)).tick(halfDay + 1)).toEqual({ skipped: false, completed: 0, failed: 1 })
  expect(f.values.has(doneKey(1))).toBe(false); expect(await f.redis.get(lockKey)).toBe('successor-owner')
  expect((await f.catalog.backupScheduleStatus(phone))?.lastSuccess).toBeUndefined()
})

test('catalog rejects malformed reservations/status and only exposes allowlisted status fields', async () => {
  const f = fixture()
  await expect(f.catalog.reserveBackupWindow(phone, NaN)).rejects.toThrow('session_storage_window_invalid')
  await expect(f.catalog.reserveBackupWindow('../phone')).rejects.toThrow('session_storage_phone_invalid')
  await expect(f.catalog.renewBackupWindow(phone, { token: 'invalid', window: 1, startedAt: 0 })).rejects.toThrow('session_storage_backup_reservation_invalid')
  expect(await f.catalog.backupScheduleStatus(phone)).toBeUndefined()
  f.values.set(statusKey, '{invalid private value')
  await expect(f.catalog.backupScheduleStatus(phone)).rejects.toThrow('session_storage_backup_schedule_invalid')
  f.values.set(statusKey, JSON.stringify({ phase: 'failed', window: 1, updatedAt: 1, secret: 'not-public', lastSuccess: { at: 0, window: 0, token: 'not-public' }, lastError: { at: 1, window: 1, code: 'https://not-public' } }))
  expect(await f.catalog.backupScheduleStatus(phone)).toEqual({ phase: 'failed', window: 1, updatedAt: 1, lastSuccess: { at: 0, window: 0 }, lastError: { at: 1, window: 1, code: 'session_storage_backup_failed' } })
})
