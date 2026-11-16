import { mockDeep } from 'jest-mock-extended'
import { clients } from '../../src/services/client'
import type { Client } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import type { Listener } from '../../src/services/listener'
import { ReloadBaileys } from '../../src/services/reload_baileys'
import { UNOAPI_SERVER_NAME } from '../../src/defaults'
import type { Store } from '../../src/services/store'
import { ReloadJob } from '../../src/jobs/reload'

describe('worker reload provider isolation', () => {
  beforeEach(() => clients.clear())

  test.each(['migrating', 'restoring'])('reload cannot interrupt %s or discard the requested retry', async state => {
    const getClient = jest.fn(), current = mockDeep<Client>(), phone = `reload-protected-${state}`
    clients.set(phone, current)
    const config: any = { ...defaultConfig, provider: 'zapo', sessionStorage: { backend: 'redis', storageId: 'synthetic', owner: 'server_1', generation: 1, state } }
    await expect(new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo').run(phone)).rejects.toThrow('operation_in_progress')
    expect(current.disconnect).not.toHaveBeenCalled(); expect(getClient).not.toHaveBeenCalled()
  })

  test('ordinary suspended QR reload does not create an offline placeholder', async () => {
    const store = mockDeep<Store>(), getClient = jest.fn(), phone = 'qr-suspended'
    const config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store) }
    await new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo').run(phone)
    expect(getClient).not.toHaveBeenCalled(); expect(clients.has(phone)).toBe(false)
    expect(store.sessionStore.setStatus).toHaveBeenCalledWith(phone, 'offline')
  })

  test('two immediate QR reload jobs pause then enable exactly one new client instead of losing activation to debounce', async () => {
    const phone = 'qr-paused-then-enabled', store = mockDeep<Store>(), client = mockDeep<Client>()
    let config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store) }
    const getClient = jest.fn().mockImplementation(async () => { await client.connect(1); clients.set(phone, client); return client })
    const service = new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo'), job = new ReloadJob(service)
    await job.consume('', { phone })
    expect(getClient).not.toHaveBeenCalled()
    config = { ...config, autoConnect: true }
    await job.consume('', { phone })
    expect(getClient).toHaveBeenCalledTimes(1); expect(client.connect).toHaveBeenCalledTimes(1)
    expect(client.disconnect).not.toHaveBeenCalled(); expect(config.autoConnect).toBe(true)
    await job.consume('', { phone })
    expect(getClient).toHaveBeenCalledTimes(1)
  })

  test('a changed proxy bypasses debounce while a failed reload does not consume the retry window', async () => {
    const phone = 'qr-proxy-and-retry', store = mockDeep<Store>()
    let config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store), proxyUrl: 'socks5://first.test:1080' }
    const getClient = jest.fn().mockRejectedValueOnce(new Error('synthetic-connect-failed')).mockResolvedValue({})
    const service = new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo')
    await service.run(phone)
    config = { ...config, autoConnect: true, proxyUrl: 'socks5://second.test:1080' }
    await expect(service.run(phone)).rejects.toThrow('synthetic-connect-failed')
    await service.run(phone)
    expect(getClient).toHaveBeenCalledTimes(2)
  })

  test('reload jobs queue a changed intent while the previous pause is still in flight', async () => {
    const phone = 'qr-job-in-flight', store = mockDeep<Store>(), old = mockDeep<Client>(); clients.set(phone, old)
    let release!: () => void
    old.disconnect.mockImplementationOnce(() => new Promise<void>(done => { release = done }))
    let config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store) }
    const getClient = jest.fn().mockResolvedValue({})
    const job = new ReloadJob(new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo'))
    const first = job.consume('', { phone })
    while (!release) await Promise.resolve()
    config = { ...config, autoConnect: true }
    let completed = false
    const second = job.consume('', { phone }).then(() => { completed = true })
    await Promise.resolve(); expect(completed).toBe(false)
    release(); await first; await second
    expect(getClient).toHaveBeenCalledTimes(1)
  })

  test('a direct non-Redis changed intent stays retryable while another reload is in flight', async () => {
    const phone = 'qr-direct-in-flight', store = mockDeep<Store>(), old = mockDeep<Client>(); clients.set(phone, old)
    let release!: () => void
    old.disconnect.mockImplementationOnce(() => new Promise<void>(done => { release = done }))
    let config = { ...defaultConfig, useRedis: false, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, autoConnect: false, getStore: jest.fn().mockResolvedValue(store) }
    const getClient = jest.fn().mockResolvedValue({})
    const service = new ReloadBaileys(getClient, async () => config, mockDeep<Listener>(), jest.fn(), 'zapo')
    const first = service.run(phone)
    while (!release) await Promise.resolve()
    config = { ...config, autoConnect: true }
    await expect(service.run(phone)).rejects.toThrow('session_storage_operation_in_progress')
    expect(getClient).not.toHaveBeenCalled()
    release(); await first; await service.run(phone)
    expect(getClient).toHaveBeenCalledTimes(1)
  })

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
    clients.set(phone, oldClient)
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
