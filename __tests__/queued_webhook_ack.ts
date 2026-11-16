import { EventEmitter } from 'events'
const connect = jest.fn()
jest.mock('amqplib', () => ({ connect }))
jest.mock('../src/services/redis', () => ({ getConfig: jest.fn(async () => ({ webhooks: [] })) }))
import { amqpConsume } from '../src/amqp'
import { OutgoingJob } from '../src/jobs/outgoing'
import { UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_X_COUNT_RETRIES, UNOAPI_X_MAX_RETRIES } from '../src/defaults'

test('real AMQP wrapper ACKs removed live/history deliveries even at the retry limit, without retry or dead-letter publish', async () => {
  const channels: any[] = []
  const connection = new EventEmitter() as any
  connection.createChannel = jest.fn(async () => {
    const channel = Object.assign(new EventEmitter(), {
      prefetch: jest.fn(), assertExchange: jest.fn(), assertQueue: jest.fn(async (queue: string) => ({ queue })),
      bindQueue: jest.fn(), consume: jest.fn(), ack: jest.fn(),
      publish: jest.fn((_e, _r, _b, _o, callback) => callback?.(null)),
    })
    channels.push(channel)
    return channel
  })
  connection.createConfirmChannel = connection.createChannel
  connect.mockResolvedValue(connection)
  const sendHttp = jest.fn(), config = jest.fn()
  for (const queue of ['unoapi.outgoing', 'unoapi.outgoing.history']) {
    const job = new OutgoingJob(config as any, { sendHttp } as any, queue)
    await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, queue, '*', (phone, data) => job.consume(phone, data), { type: 'topic' })
    const channel = channels.findLast(c => c.consume.mock.calls.length)
    const envelope = {
      content: Buffer.from(JSON.stringify({ payload: {}, webhook: { id: 'removed', urlAbsolute: 'https://example.test/removed', enabled: true } })),
      fields: { routingKey: `${queue}.5566996222471` },
      properties: { headers: { [UNOAPI_X_COUNT_RETRIES]: 99, [UNOAPI_X_MAX_RETRIES]: 3 } },
    }
    await channel.consume.mock.calls[0][1](envelope)
    expect(channel.ack).toHaveBeenCalledWith(envelope)
  }
  expect(sendHttp).not.toHaveBeenCalled(); expect(config).not.toHaveBeenCalled()
  for (const channel of channels) expect(channel.publish).not.toHaveBeenCalled()
})
