import { MobileBackupTasks } from '../../src/services/mobile_primary/backup_tasks'
import { MobileDeviceError } from '../../src/services/mobile_device_service'

const body = { password: 'test-backup-password', mode: 'complete', confirmSuspend: true }
function setup() {
  const values = new Map<string, string>()
  const redis = {
    get: jest.fn(async (key: string) => values.get(key) || null),
    eval: jest.fn(async (script: string, { keys: k, arguments: a }: any) => {
      if (script.includes("redis.call('EXISTS'")) {
        if (values.has(k[0])) return 0
        values.set(k[0], a[0]); values.set(k[1], a[1]); values.delete(k[2]); return 1
      }
      if (script.includes("redis.call('PEXPIRE'")) {
        if (values.get(k[0]) !== a[0]) return 0
        values.set(k[1], a[1]); return 1
      }
      if (values.get(k[0]) !== a[0] || JSON.parse(values.get(k[1]) || '{}').id !== a[0]) return 0
      if (a[2]) values.set(k[2], a[2])
      values.set(k[1], a[1]); values.delete(k[0]); return 1
    }),
  }
  let finish!: (file: any) => void, fail!: (error: any) => void
  const exporter = jest.fn(() => new Promise<any>((resolve, reject) => { finish = resolve; fail = reject }))
  const deps = { redis, export: exporter, exists: jest.fn(async () => ({})) }
  return { values, redis, exporter, deps, tasks: new MobileBackupTasks(deps), finish: (file: any) => finish(file), fail: (error: any) => fail(error) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test('heartbeat renews long exports without persisting password or archive; lost ownership is rejected', async () => {
  const s = setup(), task = await s.tasks.start('device', body)
  const heartbeat = (s.exporter.mock.calls[0] as any[])[2]
  const clock = jest.spyOn(Date, 'now').mockReturnValue(task.createdAt + 700000)
  try {
    await heartbeat()
    expect((await s.tasks.status('device'))?.status).toBe('running')
    expect(JSON.stringify([...s.values])).not.toContain(body.password)
    s.values.set('mobile-primary:{v1}:backup-task:lock', 'successor')
    await expect(heartbeat()).rejects.toMatchObject({ code: 'session_backup_task_lost' })
  } finally { clock.mockRestore(); s.fail(new Error('synthetic')); await flush() }
})

test('returns before export and persists encrypted file for a new service instance, without password', async () => {
  const s = setup(), task = await s.tasks.start('device', body)
  expect(task.status).toBe('running')
  expect(JSON.stringify([...s.values])).not.toContain(body.password)
  expect(JSON.stringify(s.redis.eval.mock.calls)).not.toContain(body.password)
  await expect(s.tasks.download('device', task.id)).rejects.toMatchObject({ status: 409 })
  s.finish({ archive: 'encrypted-content', fileName: 'device.viperdevice' }); await flush()
  const reopened = new MobileBackupTasks(s.deps)
  expect((await reopened.status('device'))?.status).toBe('ready')
  expect(await reopened.download('device', task.id)).toEqual({ archive: 'encrypted-content', fileName: 'device.viperdevice' })
  expect(JSON.stringify(await reopened.status('device'))).not.toContain('encrypted-content')
  expect(s.redis.eval.mock.calls[1][1].arguments[3]).toBe('86400')
  expect(JSON.stringify([...s.values])).not.toContain(body.password)
})
test('concurrent submissions are rejected and unknown errors are sanitized', async () => {
  const s = setup(); await s.tasks.start('device', body)
  await expect(s.tasks.start('other', body)).rejects.toMatchObject({ code: 'mobile_backup_busy' })
  s.fail(new Error('private credentials')); await flush()
  expect(await s.tasks.status('device')).toMatchObject({ status: 'failed', error: 'mobile_backup_failed' })
  expect(JSON.stringify([...s.values])).not.toContain('private credentials')
})
test('registration errors survive as safe actionable codes', async () => {
  const s = setup(); await s.tasks.start('device', body)
  s.fail(new MobileDeviceError(409, 'mobile_registration_required')); await flush()
  expect(await s.tasks.status('device')).toMatchObject({ status: 'failed', error: 'mobile_registration_required' })
})
test('interruption, expiration and stale completions never return a wrong file', async () => {
  const s = setup(); const task = await s.tasks.start('device', body)
  const now = jest.spyOn(Date, 'now').mockReturnValue(task.createdAt + 600001)
  try { expect((await s.tasks.status('device'))?.status).toBe('interrupted') } finally { now.mockRestore() }
  s.values.set('mobile-primary:{v1}:backup-task:lock', 'successor')
  s.finish({ archive: 'late', fileName: 'late' }); await flush()
  expect(s.values.has('mobile-primary:{v1}:backup-task:device:file')).toBe(false)
  s.values.delete('mobile-primary:{v1}:backup-task:lock')
  const next = await s.tasks.start('device', body)
  s.finish({ archive: 'new', fileName: 'new' }); await flush()
  await expect(s.tasks.download('device', task.id)).rejects.toMatchObject({ status: 409 })
  s.values.delete('mobile-primary:{v1}:backup-task:device:file')
  await expect(s.tasks.download('device', next.id)).rejects.toMatchObject({ status: 410 })
})
test('invalid consent, mode and password never schedule work', async () => {
  const s = setup()
  for (const input of [{ ...body, password: 'short' }, { ...body, mode: 'unknown' }, { ...body, confirmSuspend: false }]) await expect(s.tasks.start('device', input)).rejects.toMatchObject({ status: 400 })
  expect(s.exporter).not.toHaveBeenCalled(); expect(s.redis.eval).not.toHaveBeenCalled()
})
