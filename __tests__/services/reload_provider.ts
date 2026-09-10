import { mockDeep } from 'jest-mock-extended'
import { clients } from '../../src/services/client'
import type { Client } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import type { Listener } from '../../src/services/listener'
import { ReloadBaileys } from '../../src/services/reload_baileys'
import { UNOAPI_SERVER_NAME } from '../../src/defaults'
import type { Store } from '../../src/services/store'

describe('worker reload provider isolation', () => {
  beforeEach(() => clients.clear())

  test.each(['connecting', 'offline'])('retires the stale Zapo client during manual reload in %s state', async (state) => {
    const phone = `reload-${state}`
    const oldClient = mockDeep<Client>()
    const store = mockDeep<Store>()
    store.sessionStore.isStatusConnecting.mockResolvedValue(state === 'connecting')
    const config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, getStore: jest.fn().mockResolvedValue(store) }
    const getClient = jest.fn().mockResolvedValueOnce(oldClient).mockResolvedValueOnce(mockDeep<Client>())
    const reload = new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo')
    await reload.run(phone)
    expect(oldClient.disconnect).toHaveBeenCalledTimes(1)
    expect(getClient).toHaveBeenCalledTimes(2)
    expect(oldClient.disconnect.mock.invocationCallOrder[0]).toBeLessThan(getClient.mock.invocationCallOrder[1])
  })

  test('disconnects an old client without constructing the new engine in the wrong worker', async () => {
    const oldClient = mockDeep<Client>()
    clients.set('5566', oldClient)
    const getClient = jest.fn()
    const reload = new ReloadBaileys(
      getClient,
      async () => ({ ...defaultConfig, provider: 'zapo' }),
      mockDeep<Listener>(),
      jest.fn(),
      'baileys',
    )

    await reload.run('5566')

    expect(oldClient.disconnect).toHaveBeenCalledWith({ preserveStatus: true })
    expect(getClient).not.toHaveBeenCalled()
    expect(clients.has('5566')).toBe(false)
  })
})
