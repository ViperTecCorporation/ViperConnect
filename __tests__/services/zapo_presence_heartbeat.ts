import { ZapoPresenceHeartbeat, ZAPO_PRESENCE_INTERVAL_MS } from '../../src/services/zapo/zapo_presence_heartbeat'
import type { WaClient } from 'zapo-js'

describe('ZapoPresenceHeartbeat', () => {
  let heartbeat: ZapoPresenceHeartbeat
  let send: jest.Mock
  let client: Pick<WaClient, 'presence'>
  const flush = async () => { await jest.advanceTimersByTimeAsync(0) }

  beforeEach(() => {
    jest.useFakeTimers()
    heartbeat = new ZapoPresenceHeartbeat('test-session')
    send = jest.fn().mockResolvedValue(undefined)
    client = { presence: { send } } as unknown as Pick<WaClient, 'presence'>
  })
  afterEach(() => { heartbeat.stop(); jest.useRealTimers() })

  test('pulses immediately and every three hours, restoring unavailable for false', async () => {
    heartbeat.start(client, false, () => true)
    await flush()
    expect(send.mock.calls).toEqual([['available'], ['unavailable']])
    await jest.advanceTimersByTimeAsync(ZAPO_PRESENCE_INTERVAL_MS - 1)
    expect(send).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    expect(send.mock.calls).toEqual([['available'], ['unavailable'], ['available'], ['unavailable']])
  })

  test('true retains online and duplicate open does not add loops', async () => {
    heartbeat.start(client, true, () => true)
    heartbeat.start(client, true, () => true)
    await flush()
    await jest.advanceTimersByTimeAsync(ZAPO_PRESENCE_INTERVAL_MS)
    expect(send.mock.calls).toEqual([['available'], ['available']])
    expect(jest.getTimerCount()).toBe(1)
  })

  test('stop cancels the loop and restart sends a fresh pulse', async () => {
    heartbeat.start(client, true, () => true)
    await flush()
    heartbeat.stop()
    heartbeat.stop()
    expect(jest.getTimerCount()).toBe(0)
    await jest.advanceTimersByTimeAsync(ZAPO_PRESENCE_INTERVAL_MS)
    expect(send).toHaveBeenCalledTimes(1)
    heartbeat.start(client, true, () => true)
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('stale socket never sends', async () => {
    heartbeat.start(client, false, () => false)
    await jest.advanceTimersByTimeAsync(ZAPO_PRESENCE_INTERVAL_MS)
    expect(send).not.toHaveBeenCalled()
  })

  test('pending sends do not overlap and old completion cannot restore a new socket', async () => {
    let resolve!: () => void
    send.mockReturnValueOnce(new Promise<void>((done) => { resolve = done }))
    heartbeat.start(client, false, () => true)
    await jest.advanceTimersByTimeAsync(ZAPO_PRESENCE_INTERVAL_MS * 2)
    expect(send).toHaveBeenCalledTimes(1)
    heartbeat.stop()
    heartbeat.start(client, true, () => true)
    await flush()
    resolve()
    await flush()
    expect(send.mock.calls).toEqual([['available'], ['available']])
  })

  test('send or restore failure is handled and the next cycle still runs', async () => {
    send.mockRejectedValueOnce(new Error('available failed'))
    heartbeat.start(client, false, () => true)
    await flush()
    expect(send.mock.calls).toEqual([['available'], ['unavailable']])
    send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('restore failed'))
    await jest.advanceTimersByTimeAsync(ZAPO_PRESENCE_INTERVAL_MS * 2)
    expect(send).toHaveBeenCalledTimes(6)
  })
})
