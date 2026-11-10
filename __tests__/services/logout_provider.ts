import { mockDeep } from 'jest-mock-extended'
import { defaultConfig } from '../../src/services/config'
import type { Client } from '../../src/services/client'
import { clients } from '../../src/services/client'
import type { DataStore } from '../../src/services/data_store'
import type { Listener } from '../../src/services/listener'
import { LogoutBaileys } from '../../src/services/logout_baileys'
import type { SessionStore } from '../../src/services/session_store'
import * as redis from '../../src/services/redis'
import type { WaStoreSession } from 'zapo-js'
import { LogoutJob } from '../../src/jobs/logout'

jest.mock('../../src/services/redis', () => ({
  getRedis: jest.fn().mockResolvedValue({ set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) }),
  delConfig: jest.fn(),
  delSessionStatus: jest.fn(),
  delSessionTransientKeys: jest.fn(),
  delZapoSessionRuntimeLease: jest.fn(),
  setConfig: jest.fn(),
}))

describe('provider logout isolation', () => {
  test.each(['migrating', 'restoring'])('queued logout preserves auth/config/lease during %s and exposes a retryable error', async state => {
    const getStore = jest.fn(), registry = { get: jest.fn() }
    const config: any = { ...defaultConfig, provider: 'zapo', useRedis: true, getStore,
      sessionStorage: { backend: 'redis', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1, state } }
    const service = new LogoutBaileys(jest.fn(), async () => config, mockDeep<Listener>(), jest.fn(), registry as never)
    await expect(new LogoutJob(service).consume('', { phone: '5566000000191', ts: Date.now() })).rejects.toThrow('operation_in_progress')
    expect(getStore).not.toHaveBeenCalled(); expect(registry.get).not.toHaveBeenCalled()
    expect(redis.delConfig).not.toHaveBeenCalled(); expect(redis.delZapoSessionRuntimeLease).not.toHaveBeenCalled()
  })

  test('transition beginning during status lookup cannot reach logout or local auth cleanup', async () => {
    const sessionStore = mockDeep<SessionStore>(), client = mockDeep<Client>(), registry = { get: jest.fn() }
    const config: any = { ...defaultConfig, provider: 'zapo', useRedis: true, getStore: async () => ({ sessionStore }) }
    sessionStore.isStatusOnline.mockImplementationOnce(async () => {
      config.sessionStorage = { backend: 'redis', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1, state: 'migrating' }
      return true
    })
    const getClient = jest.fn().mockResolvedValue(client)
    await expect(new LogoutBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), registry as never).run('5566000000192')).rejects.toThrow('operation_in_progress')
    expect(getClient).not.toHaveBeenCalled(); expect(client.logout).not.toHaveBeenCalled(); expect(registry.get).not.toHaveBeenCalled()
  })
  test('SQLite deregister marks only the native link unlinked, preserves historical config and releases the cached native store', async () => {
    const session = mockDeep<WaStoreSession>(), dataStore = mockDeep<DataStore>(), sessionStore = mockDeep<SessionStore>()
    const storage = { backend: 'sqlite' as const, storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 3, state: 'active' as const }
    const registry = { get: jest.fn().mockReturnValue({ session: () => session }), release: jest.fn() }
    const logout = new LogoutBaileys(jest.fn(), async () => ({ ...defaultConfig, provider: 'zapo', useRedis: true, sessionStorage: storage, getStore: async () => ({ dataStore, sessionStore }) }), mockDeep<Listener>(), jest.fn(), registry as never)
    await logout.run('5566000000170')
    expect(session.auth.clear).toHaveBeenCalledTimes(1); expect(session.messages.clear).not.toHaveBeenCalled(); expect(session.contacts.clear).not.toHaveBeenCalled()
    expect(dataStore.cleanSession).not.toHaveBeenCalled(); expect(redis.delConfig).not.toHaveBeenCalled()
    expect(redis.setConfig).toHaveBeenCalledWith('5566000000170', { autoConnect: false, sessionStorageUnlinked: true, sessionStorage: { ...storage, state: 'offline' } })
    expect(registry.release).toHaveBeenCalledTimes(1)
  })
  test('stale destructive logout cannot clear a primary device', async () => {
    const client = mockDeep<Client>(); clients.set('primary', client)
    const storeFactory = jest.fn()
    const logout = new LogoutBaileys(jest.fn(), async () => ({ ...defaultConfig, provider: 'zapo', mobilePrimaryDraftId: 'draft', getStore: storeFactory }), mockDeep<Listener>(), jest.fn())
    await logout.run('primary')
    expect(client.logout).not.toHaveBeenCalled()
    expect(storeFactory).not.toHaveBeenCalled()
    expect(redis.delConfig).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    clients.clear()
    jest.clearAllMocks()
  })

  test('Zapo logout keeps the legacy Baileys auth rollback', async () => {
    const client = mockDeep<Client>()
    const dataStore = mockDeep<DataStore>()
    const sessionStore = mockDeep<SessionStore>()
    const zapoSession = mockDeep<WaStoreSession>()
    const zapoStores = { get: jest.fn().mockReturnValue({ session: jest.fn().mockReturnValue(zapoSession) }) }
    sessionStore.isStatusOnline.mockResolvedValue(true)
    clients.set('5566', client)
    const logout = new LogoutBaileys(
      jest.fn(),
      async () => ({
        ...defaultConfig,
        provider: 'zapo',
        useRedis: true,
        getStore: async () => ({ dataStore, sessionStore }),
      }),
      mockDeep<Listener>(),
      jest.fn(),
      zapoStores as never,
    )

    await logout.run('5566')

    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(dataStore.cleanSession).not.toHaveBeenCalled()
    expect(zapoSession.auth.clear).toHaveBeenCalledTimes(1)
    expect(zapoSession.contacts.clear).not.toHaveBeenCalled()
    expect(zapoSession.messages.clear).not.toHaveBeenCalled()
    expect(zapoSession.threads.clear).not.toHaveBeenCalled()
    expect(redis.delConfig).toHaveBeenCalledWith('5566')
    expect(redis.delSessionTransientKeys).toHaveBeenCalledWith('5566')
    expect(redis.delZapoSessionRuntimeLease).toHaveBeenCalledWith('5566')
  })

  test('Zapo deregistration clears stored auth even when no client is active', async () => {
    const dataStore = mockDeep<DataStore>()
    const sessionStore = mockDeep<SessionStore>()
    const zapoSession = mockDeep<WaStoreSession>()
    const zapoStores = { get: jest.fn().mockReturnValue({ session: jest.fn().mockReturnValue(zapoSession) }) }
    const getClient = jest.fn()
    const logout = new LogoutBaileys(
      getClient,
      async () => ({
        ...defaultConfig,
        provider: 'zapo',
        useRedis: true,
        getStore: async () => ({ dataStore, sessionStore }),
      }),
      mockDeep<Listener>(),
      jest.fn(),
      zapoStores as never,
    )

    await logout.run('5566')

    expect(getClient).not.toHaveBeenCalled()
    expect(zapoSession.auth.clear).toHaveBeenCalledTimes(1)
    expect(redis.delConfig).toHaveBeenCalledWith('5566')
    expect(redis.delZapoSessionRuntimeLease).toHaveBeenCalledWith('5566')
  })

  test('Baileys logout still removes its own auth and config', async () => {
    const client = mockDeep<Client>()
    const dataStore = mockDeep<DataStore>()
    const sessionStore = mockDeep<SessionStore>()
    sessionStore.isStatusOnline.mockResolvedValue(true)
    clients.set('5566', client)
    const logout = new LogoutBaileys(
      jest.fn(),
      async () => ({
        ...defaultConfig,
        provider: 'baileys',
        useRedis: true,
        getStore: async () => ({ dataStore, sessionStore }),
      }),
      mockDeep<Listener>(),
      jest.fn(),
    )

    await logout.run('5566')

    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(dataStore.cleanSession).toHaveBeenCalledWith(true)
  })
})
