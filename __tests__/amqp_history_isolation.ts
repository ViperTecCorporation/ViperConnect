import { EventEmitter } from 'events'
const connect = jest.fn()
jest.mock('amqplib', () => ({ connect }))
import { amqpConsume } from '../src/amqp'
import { startHistoryConsumers } from '../src/jobs/history_consumers'
import { isHistoryQueue } from '../src/services/history_queue_context'
import { UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_X_COUNT_RETRIES, UNOAPI_X_MAX_RETRIES } from '../src/defaults'

test('real consumer wrapper isolates channels, retries, dead letters and reconnect registrations', async () => {
  jest.useFakeTimers()
  const channels: any[] = []
  const connection = new EventEmitter() as any
  connection.createChannel = jest.fn(async () => {
    const channel = Object.assign(new EventEmitter(), {
      prefetch: jest.fn(), assertExchange: jest.fn(),
      assertQueue: jest.fn(async (queue: string) => ({ queue })),
      bindQueue: jest.fn(), publish: jest.fn((_e, _r, _b, _o, callback) => callback?.(null)), ack: jest.fn(),
      consume: jest.fn(),
    })
    channels.push(channel)
    return channel
  })
  connection.createConfirmChannel = connection.createChannel
  connect.mockResolvedValue(connection)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const handler = jest.fn(async (_phone, data) => {
    expect(isHistoryQueue()).toBe(true)
    if (data.fail) throw new Error('webhook unavailable')
    await blocked
  })
  const queue = 'unoapi.outgoing.history'
  const envelope = (fail = false, retries = 0) => ({
    content: Buffer.from(JSON.stringify({ fail, id: 'original' })),
    fields: { routingKey: `${queue}.5566999999999` },
    properties: { headers: { [UNOAPI_X_COUNT_RETRIES]: retries, [UNOAPI_X_MAX_RETRIES]: 3 } },
  })
  try {
    await startHistoryConsumers(queue, handler, false)
    await startHistoryConsumers(queue, handler, false)
    const history = channels.filter(c => c.consume.mock.calls.length)
    expect(history).toHaveLength(2)
    for (const channel of history) {
      expect(channel.prefetch).toHaveBeenCalledWith(1)
      expect(channel.bindQueue).toHaveBeenCalledWith(queue, UNOAPI_EXCHANGE_BROKER_NAME, `${queue}.*`)
      expect(channel.bindQueue).toHaveBeenCalledWith(queue, UNOAPI_EXCHANGE_BROKER_NAME, `${queue}.delayed.*`)
    }
    const liveHandler = jest.fn(async () => { expect(isHistoryQueue()).toBe(false) })
    await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, 'unoapi.outgoing', '*', liveHandler, { type: 'topic', prefetch: 1 })
    const live = channels[channels.length - 1]
    const pending = history.map(c => c.consume.mock.calls[0][1](envelope()))
    await live.consume.mock.calls[0][1](envelope())
    expect(liveHandler).toHaveBeenCalledTimes(1)
    expect(live.ack).toHaveBeenCalledTimes(1)
    history.forEach(c => expect(c.ack).not.toHaveBeenCalled())
    release()
    await Promise.all(pending)
    history.forEach(c => expect(c.ack).toHaveBeenCalledTimes(1))

    const publisher = channels[0]
    await history[0].consume.mock.calls[0][1](envelope(true))
    let published = publisher.publish.mock.calls.at(-1)
    expect(published.slice(0, 2)).toEqual([`${UNOAPI_EXCHANGE_BROKER_NAME}.delayed`, `${queue}.delayed.5566999999999`])
    expect(JSON.parse(published[2].toString())).toEqual({ fail: true, id: 'original' })
    expect(published[3].headers[UNOAPI_X_COUNT_RETRIES]).toBe(1)
    expect(published[3].expiration).toBe(60000)
    await history[1].consume.mock.calls[0][1](envelope(true, 2))
    published = publisher.publish.mock.calls.at(-1)
    expect(published.slice(0, 2)).toEqual([`${UNOAPI_EXCHANGE_BROKER_NAME}.dead`, `${queue}.dead.5566999999999`])

    history[0].emit('close')
    await jest.advanceTimersByTimeAsync(1000)
    const replacement = channels[channels.length - 1]
    expect(replacement.prefetch).toHaveBeenCalledWith(1)
    expect(replacement.consume).toHaveBeenCalledWith(queue, expect.any(Function))
    const count = channels.length
    await startHistoryConsumers(queue, handler, false)
    expect(channels).toHaveLength(count)
  } finally {
    release()
    jest.useRealTimers()
  }
})
