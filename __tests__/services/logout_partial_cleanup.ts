jest.mock('../../src/services/redis', () => ({
  getConfig: jest.fn(),
  subscribeConfigUpdates: jest.fn(),
  setBusinessAccountIdMapping: jest.fn(),
  getRedis: jest.fn(),
  delConfig: jest.fn(),
  delSessionStatus: jest.fn(),
  delSessionTransientKeys: jest.fn(),
  delZapoSessionRuntimeLease: jest.fn(),
  setConfig: jest.fn(),
}))
jest.mock('../../src/services/store_redis', () => ({ getStoreRedis: jest.fn() }))
jest.mock('../../src/services/client_zapo', () => ({ ClientZapo: jest.fn() }))

import { mockDeep } from 'jest-mock-extended'
import type { WaStoreSession } from 'zapo-js'
import { configs } from '../../src/services/config'
import { clients, type Client } from '../../src/services/client'
import { ClientZapo } from '../../src/services/client_zapo'
import { getConfigRedis } from '../../src/services/config_redis'
import { getStoreRedis } from '../../src/services/store_redis'
import { getClientProvider } from '../../src/services/providers/client_factory'
import { LogoutBaileys } from '../../src/services/logout_baileys'
import { LogoutJob } from '../../src/jobs/logout'
import type { SessionStore } from '../../src/services/session_store'
import type { DataStore } from '../../src/services/data_store'
import type { Listener } from '../../src/services/listener'
import * as redis from '../../src/services/redis'

beforeEach(() => {
  configs.clear(); clients.clear(); jest.resetAllMocks()
  jest.mocked(redis.subscribeConfigUpdates).mockResolvedValue(undefined)
  jest.mocked(redis.setBusinessAccountIdMapping).mockResolvedValue(undefined)
  jest.mocked(redis.getRedis).mockResolvedValue({ set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) } as never)
})
afterEach(() => { configs.clear(); clients.clear() })

test.each(['status', 'transients', 'lease'])('retry finishes logout after config deletion and a failed %s cleanup without opening a socket', async failure => {
  const phone = `99901000009${failure === 'status' ? '01' : failure === 'transients' ? '02' : '03'}`
  let persisted: any = { provider: 'zapo', server: 'server_1', autoConnect: true }
  jest.mocked(redis.getConfig).mockImplementation(async () => persisted)
  jest.mocked(redis.delConfig).mockImplementation(async () => { persisted = undefined; return undefined as never })
  const failing = failure === 'status' ? redis.delSessionStatus : failure === 'transients' ? redis.delSessionTransientKeys : redis.delZapoSessionRuntimeLease
  jest.mocked(failing).mockRejectedValueOnce(new Error(`synthetic_${failure}_failure_after_del_config`))
    .mockResolvedValue(undefined as never)

  const sessionStore = mockDeep<SessionStore>(), dataStore = mockDeep<DataStore>(), native = mockDeep<WaStoreSession>()
  // Keep a stale online status, as happens when the status deletion fails. The
  // first attempt owns an existing client; retry simulates worker recreation.
  sessionStore.isStatusOnline.mockResolvedValue(true)
  jest.mocked(getStoreRedis).mockResolvedValue({ sessionStore, dataStore } as never)
  const existing = mockDeep<Client>()
  clients.set(phone, existing)
  const registry = { get: jest.fn().mockReturnValue({ session: () => native }) }
  const job = new LogoutJob(new LogoutBaileys(getClientProvider, getConfigRedis, mockDeep<Listener>(), jest.fn(), registry as never))
  const payload = { phone, ts: Date.now() }

  await expect(job.consume('', payload)).rejects.toThrow(`synthetic_${failure}_failure_after_del_config`)
  expect(persisted).toBeUndefined()
  expect(redis.delConfig).toHaveBeenCalledTimes(1)
  expect(existing.logout).toHaveBeenCalledTimes(1)
  expect(native.auth.clear).toHaveBeenCalledTimes(1)

  clients.clear()
  await expect(job.consume('', payload)).resolves.toBeUndefined()
  expect(redis.delConfig).toHaveBeenCalledTimes(2)
  expect(redis.delSessionStatus).toHaveBeenCalledTimes(2)
  expect(redis.delSessionTransientKeys).toHaveBeenCalledTimes(failure === 'status' ? 1 : 2)
  expect(redis.delZapoSessionRuntimeLease).toHaveBeenCalledTimes(failure === 'lease' ? 2 : 1)
  expect(redis.delSessionStatus).toHaveBeenLastCalledWith(phone)
  expect(redis.delSessionTransientKeys).toHaveBeenLastCalledWith(phone)
  expect(redis.delZapoSessionRuntimeLease).toHaveBeenLastCalledWith(phone)
  expect(native.auth.clear).toHaveBeenCalledTimes(2)
  expect(native.messages.clear).not.toHaveBeenCalled()
  expect(native.contacts.clear).not.toHaveBeenCalled()
  expect(dataStore.cleanSession).not.toHaveBeenCalled()
  // The real provider factory sees missing registration and refuses before
  // constructing a replacement client, although the old online flag remains.
  expect(ClientZapo).not.toHaveBeenCalled()
  expect(existing.connect).not.toHaveBeenCalled()
  expect(clients.has(phone)).toBe(false)
})

test.each(['fixture', 'migrating', 'restoring'])('orphan-cleanup allowance does not bypass the %s fence', async state => {
  const phone = '9990100000904'
  jest.mocked(redis.getConfig).mockResolvedValue({ provider: 'zapo', server: 'server_1', autoConnect: true,
    sessionStorage: { backend: 'redis', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1,
      state: state === 'fixture' ? 'offline' : state, ...(state === 'fixture' ? { fixture: true } : {}) } } as never)
  const registry = { get: jest.fn() }
  const job = new LogoutJob(new LogoutBaileys(getClientProvider, getConfigRedis, mockDeep<Listener>(), jest.fn(), registry as never))
  await expect(job.consume('', { phone, ts: Date.now() })).rejects.toThrow(state === 'fixture' ? 'external_effects_forbidden' : 'operation_in_progress')
  expect(getStoreRedis).not.toHaveBeenCalled(); expect(registry.get).not.toHaveBeenCalled()
  expect(redis.delConfig).not.toHaveBeenCalled(); expect(redis.delSessionStatus).not.toHaveBeenCalled()
  expect(redis.delSessionTransientKeys).not.toHaveBeenCalled(); expect(redis.delZapoSessionRuntimeLease).not.toHaveBeenCalled()
  expect(ClientZapo).not.toHaveBeenCalled()
})
