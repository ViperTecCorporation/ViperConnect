import { zapoOperationDeadline } from '../../src/services/zapo/zapo_operation_deadline'

afterEach(() => jest.useRealTimers())

test('returns success and preserves library errors', async () => {
  const signal = new AbortController().signal
  await expect(zapoOperationDeadline(Promise.resolve('ok'), 100, signal, 'timeout')).resolves.toBe('ok')
  await expect(zapoOperationDeadline(Promise.reject(new Error('library')), 100, signal, 'timeout')).rejects.toThrow('library')
})

test('times out pending operations and handles their late rejection', async () => {
  jest.useFakeTimers()
  let reject!: (error: Error) => void
  const task = new Promise<void>((_, r) => { reject = r })
  const result = zapoOperationDeadline(task, 100, new AbortController().signal, 'timeout')
  const assertion = expect(result).rejects.toThrow('timeout')
  await jest.advanceTimersByTimeAsync(100)
  await assertion
  reject(new Error('late'))
  expect(jest.getTimerCount()).toBe(0)
})

test('cancels pending and already aborted operations', async () => {
  const controller = new AbortController()
  const task = new Promise<void>(() => undefined)
  const result = zapoOperationDeadline(task, 100, controller.signal, 'timeout')
  controller.abort()
  await expect(result).rejects.toThrow('zapo_operation_cancelled')
  await expect(zapoOperationDeadline(task, 100, controller.signal, 'timeout')).rejects.toThrow('zapo_operation_cancelled')
})
