import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configs } from '../../src/services/config'
import { closeAllSessionDatabases, openSessionDatabase } from '../../src/services/session_storage/database'
import { compatibilityKeyOwner, executeCompatibilityValue, routeCompatibilityValue } from '../../src/services/session_storage/compat_redirect'
import { getConfigRedis } from '../../src/services/config_redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'

jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))

const phone = '999123456789', other = '999987654321'
let directory: string, config: any, oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  oldEnvironment = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'viper-compat-test-'))
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'synthetic_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID; process.env.SESSION_STORAGE_ROOT = directory
  config = { baseStore: directory, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'synthetic_owner', generation: 1, state: 'offline', fixture: true } }
  openSessionDatabase(phone, config, { create: true }); configs.set(phone, config); jest.clearAllMocks()
})
afterEach(() => { configs.delete(phone); configs.delete(other); closeAllSessionDatabases(); process.env = oldEnvironment; rmSync(directory, { recursive: true, force: true }); jest.restoreAllMocks() })

test('compatibility registry routes only exact session families, never global control or phone substrings', async () => {
  const redis = { get: jest.fn(async () => null) }
  for (const key of [`unoapi-message:${phone}:jid:id`, `unoapi-id_rev:${phone}:uno`, `unoapi-jidmap:${phone}:pn_for_lid:123@lid`]) expect(compatibilityKeyOwner(key)).toBe(phone)
  for (const key of [`unoapi-config:${phone}`, `unoapi-status:${phone}`, `unoapi-lease:zapo-session:${phone}`, `unoapi-jidmap:global:pn_for_lid:${phone}`, 'unoapi-message:invalid:jid:id']) {
    expect(compatibilityKeyOwner(key)).toBeUndefined(); expect(await routeCompatibilityValue(key, 'get', redis)).toEqual({ handled: false })
  }
  expect(redis.get).not.toHaveBeenCalled()
  expect(() => executeCompatibilityValue(phone, config, 'get', `unoapi-message:${other}:jid:id`)).toThrow('session_storage_key_scope_invalid')
})

test('legacy string contract preserves binary protobuf base64, NUL and Unicode; raw binary is explicitly rejected', async () => {
  const base64 = Buffer.from([0, 255, 128, 32, 10, 1]).toString('base64'), value = `\u0000ç🙂:${base64}`
  const key = `unoapi-message:${phone}:jid:id`, redis = { get: jest.fn() }
  expect(await routeCompatibilityValue(key, 'set', redis, value, 30)).toEqual({ handled: true, value: 'OK' })
  expect(await routeCompatibilityValue(key, 'get', redis)).toEqual({ handled: true, value })
  expect(openSessionDatabase(phone, config).getValue(key)).toEqual(Buffer.from(value))
  expect(() => executeCompatibilityValue(phone, config, 'set', key, Buffer.from([255]) as any)).toThrow('session_storage_value_invalid')
  expect(redis.get).not.toHaveBeenCalled(); expect(sessionStorageRpc).not.toHaveBeenCalled()
})

test('TTL, deletion and wildcard listing remain scoped to the local session and expired values are hidden', () => {
  const key = `unoapi-key:${phone}:id_1`, deadline = Date.now() + 1000
  executeCompatibilityValue(phone, config, 'set', key, 'one', 1)
  executeCompatibilityValue(phone, config, 'set', `unoapi-key:${phone}:id_2`, 'two', -1)
  const db = openSessionDatabase(phone, config)
  db.putValue(`unoapi-key:${other}:foreign`, 'must-not-leak')
  expect(executeCompatibilityValue(phone, config, 'keys', `unoapi-key:${phone}:id_*`)).toEqual([key, `unoapi-key:${phone}:id_2`])
  jest.spyOn(Date, 'now').mockReturnValue(deadline + 1000)
  expect(executeCompatibilityValue(phone, config, 'get', key)).toBeNull()
  expect(executeCompatibilityValue(phone, config, 'get', `unoapi-key:${phone}:id_2`)).toBe('two')
  expect(executeCompatibilityValue(phone, config, 'delete', `unoapi-key:${phone}:id_2`)).toBe(1)
  expect(executeCompatibilityValue(phone, config, 'delete', `unoapi-key:${phone}:id_2`)).toBe(0)
  expect(() => executeCompatibilityValue(phone, config, 'keys', `unoapi-key:${phone}:[bad]`)).toThrow('session_storage_key_pattern_invalid')
})

test('web/nonowner code dispatches RPC rather than opening a worker-local database; transition states reject local operations', async () => {
  const key = `unoapi-id:${phone}:provider`
  process.env.UNOAPI_PROCESS_ROLE = 'web'
  expect(() => executeCompatibilityValue(phone, config, 'get', key)).toThrow('session_storage_wrong_owner')
  ;(getConfigRedis as jest.Mock).mockResolvedValue(config); (sessionStorageRpc as jest.Mock).mockResolvedValue('uno')
  expect(await routeCompatibilityValue(key, 'get', { get: jest.fn() })).toEqual({ handled: true, value: 'uno' })
  expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'compat.get', [key, undefined, undefined])
  process.env.UNOAPI_PROCESS_ROLE = 'worker'
  expect(() => executeCompatibilityValue(phone, { ...config, sessionStorage: { ...config.sessionStorage, state: 'migrating' } }, 'set', key, 'uno', 60)).toThrow('session_storage_operation_in_progress')
  expect(() => executeCompatibilityValue(phone, { ...config, sessionStorage: { ...config.sessionStorage, state: 'restoring' } }, 'get', key)).toThrow('session_storage_operation_in_progress')
})
