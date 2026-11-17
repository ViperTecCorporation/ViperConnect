import { createStore, WaClient } from 'zapo-js'
import { guardZapoSdkConnect, ZapoSdkRecovery } from '../../src/services/zapo/zapo_sdk_recovery'

describe('SDK recovery lifecycle handoff', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

  test('begin is deduplicated; claim waits for offline persistence and permits one attempt', async () => {
    const expired = jest.fn(), recovery = new ZapoSdkRecovery(expired)
    expect(recovery.active).toBe(false)
    expect(recovery.begin()).toBe(true)
    expect(recovery.begin()).toBe(false)
    let entered = false
    const claim = recovery.claim().then(() => { entered = true })
    await Promise.resolve()
    expect(entered).toBe(false)
    recovery.ready()
    await claim
    expect(entered).toBe(true)
    await expect(recovery.claim()).rejects.toThrow('zapo_sdk_recovery_not_pending')
    const done = recovery.wait()
    recovery.complete()
    await done
    expect(recovery.active).toBe(false)
    expect(expired).not.toHaveBeenCalled()
    await recovery.wait()
    expect(recovery.begin()).toBe(true)
    recovery.cancel()
  })

  test('cancel unblocks pending gates but rejects reconnect and prevents a new episode', async () => {
    const recovery = new ZapoSdkRecovery(jest.fn())
    recovery.begin()
    const claim = recovery.claim()
    const rejected = expect(claim).rejects.toThrow('zapo_operation_cancelled')
    const done = recovery.wait()
    recovery.cancel()
    await rejected
    await done
    expect(recovery.begin()).toBe(false)
    await expect(recovery.claim()).rejects.toThrow('zapo_sdk_recovery_not_pending')
  })

  test('timeout is bounded and repeated closes cannot extend the deadline', async () => {
    jest.useFakeTimers()
    const expired = jest.fn(), recovery = new ZapoSdkRecovery(expired)
    recovery.begin()
    await jest.advanceTimersByTimeAsync(44_999)
    expect(recovery.begin()).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(recovery.active).toBe(false)
    expect(expired).toHaveBeenCalledTimes(1)
    recovery.cancel()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(expired).toHaveBeenCalledTimes(1)
  })

  test('public connect decorator preserves this and gates every invocation', async () => {
    const client = { calls: 0, async connect() { this.calls++ } }
    const run = jest.fn(async connect => connect())
    expect(guardZapoSdkConnect(client, run)).toBe(client)
    await client.connect()
    await client.connect()
    expect(client.calls).toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
    run.mockRejectedValueOnce(new Error('cancelled'))
    await expect(client.connect()).rejects.toThrow('cancelled')
    expect(client.calls).toBe(2)
  })

  test('actual SDK late version fetch cannot reconnect after lifecycle cancellation', async () => {
    const store = createStore()
    const logger = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => logger }
    const client = new WaClient({ store, sessionId: 'synthetic-405', version: '2.3000.1054816457', recoverFromClientTooOld: true }, logger)
    const rawConnect = jest.spyOn(client, 'connect').mockResolvedValue(undefined)
    const recovery = new ZapoSdkRecovery(jest.fn())
    guardZapoSdkConnect(client, async connect => { await recovery.claim(); await connect() })
    let finish!: (value: Response) => void
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    try {
      client.on('connection', event => { if (event.status === 'close' && event.reason === 'failure_client_too_old') { recovery.begin(); recovery.ready() } })
      client.emit('connection', { status: 'close', reason: 'failure_client_too_old', code: 405, isLogout: false })
      recovery.cancel()
      finish({ ok: true, text: async () => '{"client_revision":1054999999}' } as Response)
      for (let turn = 0; turn < 40; turn++) await Promise.resolve()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(rawConnect).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith('client_too_old auto-recover failed', expect.any(Object))
    } finally { recovery.cancel(); await store.destroy() }
  })
})
