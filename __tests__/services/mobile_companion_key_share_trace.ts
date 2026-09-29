import { traceCompanionKeyShare } from '../../src/services/mobile_primary/companion_key_share_trace'
import logger from '../../src/services/logger'
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }))
beforeEach(() => jest.clearAllMocks())

test('observes exactly one SDK call and preserves receiver; never logs keys or target', async () => {
  const original = jest.fn(async function (this: any) { expect(this).toBe(mobile) })
  const mobile = { shareAppStateSyncKeys: original }
  const stop = traceCompanionKeyShare(mobile, 'draft')
  await mobile.shareAppStateSyncKeys('private-target')
  expect(original).toHaveBeenCalledTimes(1)
  expect(original).toHaveBeenCalledWith('private-target')
  expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'app_state_key_share' }), 'MOBILE_COMPANION_KEY_SHARE_SUBMITTED')
  expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('private-target')
  stop(); expect(mobile.shareAppStateSyncKeys).toBe(original)
})

test('logs sanitized failure and rethrows the same error without retry', async () => {
  const error = new Error('SECRET_KEY payload token')
  const original = jest.fn().mockRejectedValue(error)
  const mobile = { shareAppStateSyncKeys: original }
  traceCompanionKeyShare(mobile, 'draft')
  await expect(mobile.shareAppStateSyncKeys('target')).rejects.toBe(error)
  expect(original).toHaveBeenCalledTimes(1)
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ diagnostic: expect.objectContaining({ reason: 'provider_error' }) }), 'MOBILE_COMPANION_KEY_SHARE_FAILED')
  expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('SECRET_KEY')
})

test('reports pending without cancelling or retrying, and cleans up timers', async () => {
  jest.useFakeTimers()
  try {
    let resolve!: () => void
    const mobile = { shareAppStateSyncKeys: jest.fn(() => new Promise<void>(r => { resolve = r })) }
    const stop = traceCompanionKeyShare(mobile, 'draft')
    const pending = mobile.shareAppStateSyncKeys('target')
    await jest.advanceTimersByTimeAsync(15000)
    expect(logger.warn).toHaveBeenCalledWith(expect.any(Object), 'MOBILE_COMPANION_KEY_SHARE_PENDING')
    resolve(); await pending; stop()
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})

test('disposal clears pending diagnostic timers without overwriting another wrapper', () => {
  jest.useFakeTimers()
  try {
    const mobile = { shareAppStateSyncKeys: jest.fn(() => new Promise<void>(() => undefined)) }
    const stop = traceCompanionKeyShare(mobile, 'draft')
    void mobile.shareAppStateSyncKeys('target')
    const other = jest.fn(); mobile.shareAppStateSyncKeys = other
    stop(); expect(mobile.shareAppStateSyncKeys).toBe(other)
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})
