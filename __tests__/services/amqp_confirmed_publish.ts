import { EventEmitter } from 'events'
import { publishConfirmed } from '../../src/services/amqp_confirmed_publish'

const makeChannel = () => Object.assign(new EventEmitter(), {
  publish: jest.fn(), close: jest.fn(async () => undefined),
})

test('waits for broker confirmation, not the publish boolean, and preserves the body', async () => {
  const channel = makeChannel()
  channel.publish.mockReturnValue(false)
  const buffer = Buffer.from('original')
  let done = false
  const task = publishConfirmed(channel as never, 'exchange', 'route', buffer, { persistent: true }).then(() => { done = true })
  await Promise.resolve()
  expect(done).toBe(false)
  const call = channel.publish.mock.calls[0]
  expect(call[2]).toBe(buffer)
  expect(call[3]).toMatchObject({ persistent: true, mandatory: true, messageId: expect.any(String) })
  call[4](null)
  await task
  expect(done).toBe(true)
})

test.each(['nack', 'return', 'close', 'error', 'throw'])('rejects %s instead of reporting delivery success', async fault => {
  const channel = makeChannel()
  if (fault === 'throw') channel.publish.mockImplementation(() => { throw new Error('failed') })
  const task = publishConfirmed(channel as never, 'exchange', 'route', Buffer.from('x'), {})
  const rejected = expect(task).rejects.toThrow()
  const call = channel.publish.mock.calls[0]
  if (fault === 'nack') call[4](new Error('nack'))
  if (fault === 'return') {
    channel.emit('return', { properties: { messageId: call[3].messageId } })
    call[4](null) // A returned mandatory message may still receive broker ACK.
  }
  if (fault === 'close') channel.emit('close')
  if (fault === 'error') channel.emit('error', new Error('connection lost'))
  await rejected
})

test('correlates concurrent returned messages without cross-rejecting confirmed messages or growing listeners', async () => {
  const channel = makeChannel()
  const tasks = Array.from({ length: 100 }, () => publishConfirmed(channel as never, 'e', 'r', Buffer.from('x'), {}))
  const rejected = expect(tasks[42]).rejects.toThrow('unroutable')
  expect(channel.listenerCount('return')).toBe(1)
  expect(channel.listenerCount('close')).toBe(1)
  channel.emit('return', { properties: { messageId: channel.publish.mock.calls[42][3].messageId } })
  for (const call of channel.publish.mock.calls) call[4](null)
  await rejected
  await Promise.all(tasks.filter((_, i) => i !== 42))
})

test('bounds confirmation waiting and discards the uncertain channel', async () => {
  jest.useFakeTimers()
  try {
    const channel = makeChannel()
    const task = publishConfirmed(channel as never, 'e', 'r', Buffer.from('x'), {}, 100)
    const rejected = expect(task).rejects.toThrow('confirm_timeout')
    await jest.advanceTimersByTimeAsync(100)
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
    channel.publish.mock.calls[0][4](null)
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})
