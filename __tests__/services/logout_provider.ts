import { mockDeep } from 'jest-mock-extended'
import { defaultConfig } from '../../src/services/config'
import type { Client } from '../../src/services/client'
import { clients } from '../../src/services/client'
import type { DataStore } from '../../src/services/data_store'
import type { Listener } from '../../src/services/listener'
import { LogoutBaileys } from '../../src/services/logout_baileys'
import type { SessionStore } from '../../src/services/session_store'
import * as redis from '../../src/services/redis'

jest.mock('../../src/services/redis', () => ({
  delConfig: jest.fn(),
  delSessionStatus: jest.fn(),
  delSessionTransientKeys: jest.fn(),
}))

describe('provider logout isolation', () => {
  beforeEach(() => {
    clients.clear()
    jest.clearAllMocks()
  })

  test('Zapo logout keeps the legacy Baileys auth rollback', async () => {
    const client = mockDeep<Client>()
    const dataStore = mockDeep<DataStore>()
    const sessionStore = mockDeep<SessionStore>()
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
    )

    await logout.run('5566')

    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(dataStore.cleanSession).not.toHaveBeenCalled()
    expect(redis.delConfig).toHaveBeenCalledWith('5566')
    expect(redis.delSessionTransientKeys).toHaveBeenCalledWith('5566')
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
