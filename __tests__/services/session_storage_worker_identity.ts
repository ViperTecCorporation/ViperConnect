jest.mock('../../src/amqp', () => ({ amqpConsume: jest.fn(), amqpRpc: jest.fn() }))
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { amqpConsume } from '../../src/amqp'
import { startSessionStorageConsumer } from '../../src/services/session_storage/rpc'
import { requireStorageVolume, storageCapability, storageWorkerIdentity } from '../../src/services/session_storage/capability'

const names = ['UNOAPI_SERVER_NAME', 'UNOAPI_STORAGE_WORKER_ID', 'SESSION_STORAGE_ROOT', 'SESSION_STORAGE_PERSISTENT', 'SESSION_STORAGE_DEFAULT'] as const
let saved: Record<string, string | undefined>, directory: string
beforeEach(() => { saved = Object.fromEntries(names.map(key => [key, process.env[key]])); names.forEach(key => { delete process.env[key] }); directory = mkdtempSync(join(tmpdir(), 'viper-owner-guard-')); jest.clearAllMocks() })
afterEach(() => { for (const key of names) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; rmSync(directory, { recursive: true, force: true }) })

test('worker identity requires an explicit safe server name and permits only an absent/equal storage alias', () => {
  expect(storageWorkerIdentity({})).toMatchObject({ valid: false, reason: 'session_storage_server_name_required' })
  expect(storageWorkerIdentity({ UNOAPI_SERVER_NAME: 'worker_1' })).toEqual({ valid: true, reason: undefined, server: 'worker_1', worker: 'worker_1' })
  expect(storageWorkerIdentity({ UNOAPI_SERVER_NAME: 'worker_1', UNOAPI_STORAGE_WORKER_ID: 'worker_1' }).valid).toBe(true)
  expect(storageWorkerIdentity({ UNOAPI_SERVER_NAME: 'worker_1', UNOAPI_STORAGE_WORKER_ID: 'worker_2' })).toMatchObject({ valid: false, reason: 'session_storage_worker_identity_ambiguous' })
  const invalid = storageWorkerIdentity({ UNOAPI_SERVER_NAME: 'https://private:secret@server' })
  expect(invalid.valid).toBe(false); expect(JSON.stringify(invalid)).not.toContain('private:secret')
})

test('ambiguous identity blocks SQLite capability and volume preparation before creating any files', () => {
  process.env.SESSION_STORAGE_ROOT = directory; process.env.SESSION_STORAGE_PERSISTENT = 'true'; process.env.SESSION_STORAGE_DEFAULT = 'sqlite'
  process.env.UNOAPI_SERVER_NAME = 'worker_1'; process.env.UNOAPI_STORAGE_WORKER_ID = 'worker_2'
  expect(storageCapability()).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis', reason: 'session_storage_worker_identity_ambiguous' })
  expect(() => requireStorageVolume()).toThrow('session_storage_worker_identity_ambiguous'); expect(readdirSync(directory)).toEqual([])
})

test('ambiguous storage consumer declines startup without throwing or registering a wrong queue; legacy Redis worker remains independent', async () => {
  process.env.UNOAPI_SERVER_NAME = 'worker_1'; process.env.UNOAPI_STORAGE_WORKER_ID = 'worker_2'
  expect(await startSessionStorageConsumer()).toEqual({ started: false, reason: 'session_storage_worker_identity_ambiguous' })
  expect(amqpConsume).not.toHaveBeenCalled()
  delete process.env.UNOAPI_STORAGE_WORKER_ID
  expect(await startSessionStorageConsumer()).toEqual({ started: true })
  expect(amqpConsume).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('.session-storage.worker_1'), '', expect.any(Function), expect.objectContaining({ type: 'direct' }))
})
