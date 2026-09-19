import { isHistoryQueue, withHistoryQueue } from '../../src/services/history_queue_context'

test('history routing stays isolated across concurrent async work and errors', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const history = withHistoryQueue(async () => {
    expect(isHistoryQueue()).toBe(true)
    await pending
    expect(isHistoryQueue()).toBe(true)
  })
  expect(isHistoryQueue()).toBe(false)
  await Promise.resolve()
  expect(isHistoryQueue()).toBe(false)
  release()
  await history
  await expect(withHistoryQueue(async () => { throw new Error('failed') })).rejects.toThrow('failed')
  expect(isHistoryQueue()).toBe(false)
  expect(() => withHistoryQueue(() => { throw new Error('sync') })).toThrow('sync')
  expect(isHistoryQueue()).toBe(false)
})
