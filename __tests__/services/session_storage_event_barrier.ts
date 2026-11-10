import { SessionEventBarrier } from '../../src/services/session_storage/event_barrier'

test('barrier preserves synchronous results and waits every already accepted async event', async () => {
  const barrier = new SessionEventBarrier(), completed: number[] = []
  expect(barrier.hasPending()).toBe(false)
  expect(barrier.run(() => 42)).toBe(42)
  let finish!: () => void
  const accepted = barrier.run(() => new Promise<void>(resolve => { finish = () => { completed.push(1); resolve() } }))
  expect(barrier.hasPending()).toBe(true)
  barrier.beginDrain()
  let drained = false; const drain = barrier.drain().then(() => { drained = true })
  await Promise.resolve(); expect(drained).toBe(false)
  finish(); await accepted; await drain
  expect(completed).toEqual([1]); expect(drained).toBe(true)
  expect(barrier.hasPending()).toBe(false)
})

test('failed accepted event prevents snapshot rather than simulating a clean drain', async () => {
  const barrier = new SessionEventBarrier(); let reject!: (error: Error) => void
  const accepted = barrier.run(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const eventResult = expect(accepted).rejects.toThrow('write_failed')
  barrier.beginDrain(); const drained = expect(barrier.drain()).rejects.toThrow('inflight_event_failed')
  reject(new Error('write_failed')); await eventResult; await drained
})

test('hung event times out without claiming a clean migration', async () => {
  jest.useFakeTimers()
  try {
    const barrier = new SessionEventBarrier()
    barrier.run(() => new Promise(() => undefined)); barrier.beginDrain()
    const drained = expect(barrier.drain(50)).rejects.toThrow('inflight_events')
    await jest.advanceTimersByTimeAsync(51); await drained
  } finally { jest.useRealTimers() }
})

test('cancelled drain restores normal tracking and clears the failed attempt', async () => {
  const barrier = new SessionEventBarrier()
  barrier.beginDrain()
  await expect(barrier.run(async () => { throw new Error('aborted') })).rejects.toThrow('aborted')
  barrier.cancelDrain()
  await barrier.run(async () => 1)
  barrier.beginDrain()
  await expect(barrier.drain()).resolves.toBeUndefined()
})
