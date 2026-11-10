jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), getConfig: jest.fn(), getSessionPhones: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
jest.mock('../../src/services/session_storage/backup_objects', () => ({ createBackupObjects: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { getRedis, getConfig, getSessionPhones } from '../../src/services/redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { createBackupObjects } from '../../src/services/session_storage/backup_objects'
import { configuredRestoreOwners, restoreWorkerDirectory, uploadStandaloneBackup, sessionBackupLibrary, downloadSessionBackup } from '../../src/services/session_storage/standalone_web'
import { StandaloneWebTasks, SAVE_STANDALONE_WEB_TASK } from '../../src/services/session_storage/standalone_web_tasks'
import { SessionStorageError } from '../../src/services/session_storage/types'

const phone = '999123456789', owner = 'destination', savedEnv = { ...process.env }
function fixture() {
  const values = new Map<string, string>(), json = new Map<string, any>(), saved = new Map<string, number>()
  const redis: any = { get: jest.fn(async (key: string) => values.get(key) || null), set: jest.fn(async (key: string, value: string) => { values.set(key, value); return 'OK' }), eval: jest.fn(async (script: string, { keys, arguments: args }: any) => {
    if (script === SAVE_STANDALONE_WEB_TASK) { if (values.get(keys[0]) !== args[0]) return 0; values.set(keys[1], args[1]); return 1 }
    if (script.includes("'SET',KEYS[2],ARGV[1],'EX',604800")) { if (values.get(keys[0]) !== args[0] || values.has(keys[1])) return 0; values.set(keys[1], args[0]); return 1 }
    if (script.includes("'EXISTS',KEYS[3]")) { if (keys.some((key: string) => values.has(key))) return 0; values.set(keys[0], args[0]); values.set(keys[1], args[1]); return 1 }
    if (values.get(keys[0]) === args[0]) values.delete(keys[0]); return 1
  }) }
  const objects: any = { save: jest.fn(async (key: string, source: Readable) => { let bytes = 0; for await (const chunk of source) bytes += chunk.length; saved.set(key, bytes) }),
    open: jest.fn(async () => Readable.from([Buffer.from('synthetic archive')])),
    remove: jest.fn(async (key: string) => { json.delete(key); saved.delete(key) }),
    json: jest.fn(async (key: string) => json.has(key) ? { value: json.get(key), etag: 'synthetic' } : undefined),
    putJson: jest.fn(async (key: string, value: any) => { if (json.has(key)) return false; json.set(key, value); return true }) }
  jest.mocked(getRedis).mockResolvedValue(redis); jest.mocked(getConfig).mockResolvedValue(undefined); jest.mocked(getSessionPhones).mockResolvedValue([])
  jest.mocked(createBackupObjects).mockReturnValue(objects)
  jest.mocked(sessionStorageRpc).mockImplementation(async (_phone, config, operation) => operation === 'standalone.capability' ? { owner: config.server, available: true } as any : undefined)
  return { values, json, saved, redis, objects, tasks: new StandaloneWebTasks(redis) }
}
beforeEach(() => { jest.clearAllMocks(); process.env.UNOAPI_SERVER_NAME = owner; process.env.STORAGE_ENDPOINT = 'http://synthetic'; process.env.STORAGE_BUCKET_NAME = 'synthetic'; delete process.env.SESSION_STORAGE_RESTORE_WORKERS })
afterEach(() => { process.env = { ...savedEnv } })

test('allowed workers come only from configured names/persisted owners; capability probing never registers an absent session', async () => {
  fixture(); process.env.SESSION_STORAGE_RESTORE_WORKERS = 'worker_2,worker_3'
  jest.mocked(getSessionPhones).mockResolvedValue([phone]); jest.mocked(getConfig).mockResolvedValue({ provider: 'zapo', server: 'worker_4' })
  expect(await configuredRestoreOwners()).toEqual([owner, 'worker_2', 'worker_3', 'worker_4'])
  jest.mocked(sessionStorageRpc).mockRejectedValueOnce(new Error('private credentials'))
  expect(await restoreWorkerDirectory()).toMatchObject({ workers: [expect.objectContaining({ owner, available: false }), expect.objectContaining({ available: true }), expect.anything(), expect.anything()] })
  process.env.SESSION_STORAGE_RESTORE_WORKERS = '../arbitrary'
  await expect(configuredRestoreOwners()).rejects.toThrow('configuration_invalid')
})
test('upload creates one durable ID before staging and lost RPC reply returns that same polling task without rerunning restore', async () => {
  const f = fixture(), payload = Buffer.from([0, 1, 254, 255])
  jest.mocked(sessionStorageRpc).mockImplementation(async (_phone, _config, operation) => { if (operation === 'standalone.restore') throw new Error('rpc timeout') })
  const task = await uploadStandaloneBackup(phone, owner, Readable.from([payload]), payload.length)
  expect(task).toMatchObject({ phone, owner, operation: 'restore', status: 'running', progress: { phase: 'queued' } })
  expect(await f.tasks.status(phone, task.id)).toEqual(task)
  expect([...f.json.values()][0]).toMatchObject({ phone, owner, uploadId: task.id, confirmOriginOffline: true })
  expect([...f.saved.values()]).toEqual([4]); expect(f.objects.remove).not.toHaveBeenCalled()
  expect(jest.mocked(sessionStorageRpc).mock.calls.map(call => call[2])).toEqual(['standalone.check', 'standalone.restore'])
  await expect(uploadStandaloneBackup(phone, owner, Readable.from([payload]), payload.length)).rejects.toThrow('busy')
  expect(jest.mocked(sessionStorageRpc).mock.calls.filter(call => call[2] === 'standalone.restore')).toHaveLength(1)
})
test.each([0, NaN, -1, 256 * 1024 * 1024 + 1])('invalid declared size %s does not stage any data', async bytes => {
  const f = fixture()
  await expect(uploadStandaloneBackup(phone, owner, Readable.from([]), bytes)).rejects.toThrow('size_invalid')
  expect(sessionStorageRpc).not.toHaveBeenCalled(); expect(f.objects.save).not.toHaveBeenCalled()
})
test('unknown owner or existing destination is refused before reservation and S3 writes', async () => {
  const f = fixture()
  await expect(uploadStandaloneBackup(phone, 'unknown_worker', Readable.from(['x']), 1)).rejects.toThrow('wrong_owner')
  jest.mocked(sessionStorageRpc).mockRejectedValueOnce(new SessionStorageError(409, 'session_storage_standalone_destination_exists'))
  await expect(uploadStandaloneBackup(phone, owner, Readable.from(['x']), 1)).rejects.toThrow()
  expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.objects.save).not.toHaveBeenCalled()
})
test('incomplete/oversized upload cleans private staging and releases its reservation without dispatch', async () => {
  for (const declared of [1, 3]) {
    const f = fixture()
    await expect(uploadStandaloneBackup(phone, owner, Readable.from([Buffer.from('xx')]), declared)).rejects.toThrow()
    expect(f.objects.remove).toHaveBeenCalledTimes(2)
    expect([...f.values.entries()].some(([key]) => key === `unoapi-session-storage:standalone-job:${phone}`)).toBe(false)
    expect(jest.mocked(sessionStorageRpc).mock.calls.filter(call => call[2] === 'standalone.restore')).toHaveLength(0)
  }
})
test('a worker claim is idempotent, durable and leaves successful restore offline without another run', async () => {
  const f = fixture(), id = randomUUID(), task = await f.tasks.reserve(phone, id, owner)
  task.progress = { phase: 'queued' }; await f.tasks.save(task)
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), run = jest.fn(async () => { await wait; return { autoConnect: false, status: 'offline', connected: false, replayed: false } })
  await f.tasks.execute(phone, id, owner, run); await f.tasks.execute(phone, id, owner, run)
  expect(run).toHaveBeenCalledTimes(1); release()
  await new Promise(resolve => setImmediate(resolve))
  expect(await f.tasks.status(phone, id)).toMatchObject({ status: 'ready', result: { autoConnect: false, status: 'offline', connected: false } })
  await f.tasks.execute(phone, id, owner, run); expect(run).toHaveBeenCalledTimes(1)
})
test('post-promotion failure keeps recovery IDs in a failed task, never replaying it', async () => {
  const f = fixture(), id = randomUUID(), task = await f.tasks.reserve(phone, id, owner)
  task.progress = { phase: 'queued' }; await f.tasks.save(task)
  const error: any = new SessionStorageError(503, 'session_storage_standalone_recovery_required'); error.recovery = { operationId: randomUUID(), storageId: randomUUID() }
  const run = jest.fn(async () => { throw error })
  await f.tasks.execute(phone, id, owner, run); await new Promise(resolve => setImmediate(resolve))
  expect(await f.tasks.status(phone, id)).toMatchObject({ status: 'failed', result: { recovery: error.recovery, connected: false, replayed: false } })
  await f.tasks.execute(phone, id, owner, run); expect(run).toHaveBeenCalledTimes(1)
})
test('backup library/download reads only verified sidecars and exposes neither object keys nor credentials', async () => {
  const f = fixture(), id = randomUUID(), manifest = { id, phone, version: 1, status: 'ready', kind: 'linked-session', storageId: randomUUID(), generation: 1,
    createdAt: new Date().toISOString(), bytes: 12, sha256: 'a'.repeat(64), objectKey: `backups/session-storage/${phone}/${id}.viperstorage`, protection: 'none' }
  f.values.set(`unoapi-session-storage:last-backup:${phone}`, JSON.stringify(manifest)); f.json.set(manifest.objectKey + '.manifest.json', manifest)
  f.json.set(`backups/session-storage/${phone}/slots/${new Date().getUTCDay()}.json`, { version: 1, day: new Date().getUTCDay(), timeZone: 'UTC', manifest })
  const library = await sessionBackupLibrary(phone)
  expect(library.latest).toMatchObject({ id, protection: 'none' }); expect(JSON.stringify(library)).not.toContain('objectKey')
  expect((await downloadSessionBackup(phone, 'latest')).fileName).toContain(id)
  await expect(downloadSessionBackup(phone, '../../private')).rejects.toThrow('backup_id_invalid')
})
