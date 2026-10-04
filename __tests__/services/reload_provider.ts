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

  test('suspends primary without constructing a client and resumes immediately without debounce', async () => {
    const phone = 'mobile-suspend'; const old = mockDeep<Client>(); clients.set(phone, old)
    const store = mockDeep<Store>()
    let config = { ...defaultConfig, provider: 'zapo' as const, mobilePrimaryDraftId: 'draft', server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store) }
    const getClient = jest.fn().mockResolvedValue(mockDeep<Client>())
    const reload = new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo')
    await reload.run(phone)
    expect(old.disconnect).toHaveBeenCalledTimes(1)
    expect(old.logout).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled()
    expect(store.sessionStore.setStatus).toHaveBeenCalledWith(phone, 'offline')
    config = { ...config, autoConnect: true }
    await reload.run(phone)
    expect(getClient).toHaveBeenCalledTimes(1)
  })

  test('primary reload ignores another worker or server', async () => {
    const getClient = jest.fn(); const old = mockDeep<Client>(); clients.set('mobile-wrong', old)
    for (const [engine, server] of [['baileys', UNOAPI_SERVER_NAME], ['zapo', 'another-server']] as const) {
      const reload = new ReloadBaileys(getClient, async () => ({ ...defaultConfig, provider: 'zapo', mobilePrimaryDraftId: 'draft', server }), mockDeep<Listener>(), jest.fn(), engine)
      await reload.run('mobile-wrong')
    }
    expect(old.disconnect).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled()
  })

  test('queued primary reconciliation rereads state and recovers after a failure', async () => {
    const phone = 'mobile-concurrent'; const old = mockDeep<Client>(); clients.set(phone, old)
    let release!: () => void
    old.disconnect.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const store = mockDeep<Store>()
    let config = { ...defaultConfig, provider: 'zapo' as const, mobilePrimaryDraftId: 'draft', server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store) }
    const getClient = jest.fn().mockRejectedValueOnce(new Error('connect failed')).mockResolvedValue({})
    const reload = new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo')
    const suspend = reload.run(phone)
    while (!release) await Promise.resolve()
    config = { ...config, autoConnect: true }
    const resume = reload.run(phone)
    const failed = expect(resume).rejects.toThrow('connect failed')
    release(); await suspend; await failed
    await reload.run(phone)
    expect(getClient).toHaveBeenCalledTimes(2)
    expect(old.logout).not.toHaveBeenCalled()
  })

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
