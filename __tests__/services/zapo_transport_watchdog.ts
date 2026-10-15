import { ZapoTransportWatchdog } from '../../src/services/zapo/zapo_transport_watchdog'

describe('ZapoTransportWatchdog', () => {
  let watchdog: ZapoTransportWatchdog
  beforeEach(() => { jest.useFakeTimers(); watchdog = new ZapoTransportWatchdog() })
  afterEach(() => { watchdog.stop(); jest.useRealTimers() })

  test('success and non-transport errors reset consecutive timeout failures', () => {
    const error = new Error('query timeout (id) after 15000ms')
    expect(watchdog.failed(error)).toBe(false)
    expect(watchdog.failed(error)).toBe(false)
    watchdog.succeeded()
    expect(watchdog.failed(error)).toBe(false)
    expect(watchdog.failed(new Error('11: audio_download_failed: HTTP 403'))).toBe(false)
    expect(watchdog.failed(error)).toBe(false)
    expect(watchdog.failed(error)).toBe(false)
    expect(watchdog.failed(error)).toBe(true)
  })

  test('stop and inactive sockets prevent recovery', async () => {
    const availability = jest.fn().mockResolvedValue(undefined)
    const recover = jest.fn().mockResolvedValue(undefined)
    watchdog.start(() => false, () => false, availability, recover)
    await jest.advanceTimersByTimeAsync(90_000)
    expect(availability).not.toHaveBeenCalled()
    watchdog.start(() => false, () => true, availability, recover)
    await jest.advanceTimersByTimeAsync(15_000)
    watchdog.stop()
    await jest.advanceTimersByTimeAsync(90_000)
    expect(availability).toHaveBeenCalledTimes(1)
    expect(recover).not.toHaveBeenCalled()
  })
})
