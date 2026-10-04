import { waitAfterHistoryKeys } from '../../src/services/mobile_primary/companion_history_key_delay'

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

test('holds history for two seconds after key submission', async () => {
  const current = jest.fn().mockResolvedValue(true), enqueue = jest.fn()
  const done = waitAfterHistoryKeys(current).then(enqueue)
  await Promise.resolve()
  jest.advanceTimersByTime(1999)
  await Promise.resolve()
  expect(enqueue).not.toHaveBeenCalled()
  jest.advanceTimersByTime(1)
  await done
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(current).toHaveBeenCalledTimes(2)
})

test('does not enqueue if ownership is lost during the delay', async () => {
  const current = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  const enqueue = jest.fn(), done = waitAfterHistoryKeys(current).then(enqueue)
  const rejected = expect(done).rejects.toThrow('mobile_history_not_connected')
  await Promise.resolve()
  jest.advanceTimersByTime(2000)
  await rejected
  expect(enqueue).not.toHaveBeenCalled()
})

test('does not start the timer for an inactive runtime', async () => {
  await expect(waitAfterHistoryKeys(async () => false)).rejects.toThrow('mobile_history_not_connected')
  expect(jest.getTimerCount()).toBe(0)
})
