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

jest.mock('../../src/services/redis', () => ({
  delConfig: jest.fn(),
  delSessionStatus: jest.fn(),
  delSessionTransientKeys: jest.fn(),
  delZapoSessionRuntimeLease: jest.fn(),
}))

describe('provider logout isolation', () => {
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
    expect(zapoSession.contacts.clear).toHaveBeenCalledTimes(1)
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
