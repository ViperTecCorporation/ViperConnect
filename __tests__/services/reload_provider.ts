import { mockDeep } from 'jest-mock-extended'
import { clients } from '../../src/services/client'
import type { Client } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import type { Listener } from '../../src/services/listener'
import { ReloadBaileys } from '../../src/services/reload_baileys'

describe('worker reload provider isolation', () => {
  beforeEach(() => clients.clear())

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

    expect(oldClient.disconnect).toHaveBeenCalledTimes(1)
    expect(getClient).not.toHaveBeenCalled()
    expect(clients.has('5566')).toBe(false)
  })
})
