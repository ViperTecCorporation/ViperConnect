import { EventEmitter } from 'events'

const setup = () => {
  jest.resetModules()
  jest.doMock('../src/defaults', () => ({ ...jest.requireActual('../src/defaults'), VALIDATE_ROUTING_KEY: true }))
  const channels: any[] = []
  const create = jest.fn(async () => {
    const channel = Object.assign(new EventEmitter(), {
      prefetch: jest.fn(), assertExchange: jest.fn(), bindQueue: jest.fn(),
      assertQueue: jest.fn(async (queue) => ({ queue })), publish: jest.fn(),
      ack: jest.fn(), consume: jest.fn(), close: jest.fn(async () => undefined),
    })
    channels.push(channel)
    return channel
  })
  const connection = Object.assign(new EventEmitter(), { createChannel: create, createConfirmChannel: create })
  jest.doMock('amqplib', () => ({ connect: jest.fn(async () => connection) }))
  const amqp = require('../src/amqp') as typeof import('../src/amqp')
  return { channels, connection, amqp }
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve()
  expect(check()).toBe(true)
}
const message = { content: Buffer.from('{"id":"original"}'), fields: { routingKey: 'source.5566999999999' }, properties: { headers: {} } }

test('strict validation accepts consumer wildcard but still rejects invalid consumers and wildcard publishers', async () => {
  const { amqp, channels } = setup()
  await amqp.amqpConsume('unoapi.broker', 'test.history', '*', async () => {}, { type: 'topic' })
  expect(channels[1].consume).toHaveBeenCalledTimes(1)
  await expect(amqp.amqpConsume('unoapi.broker', 'test.history', 'bad', async () => {})).rejects.toBe('bad is not a number')
  await expect(amqp.amqpPublish('unoapi.broker', 'test.history', '*', {})).rejects.toBe('* is not a number')
})

test('source is ACKed only after destination confirm', async () => {
  const { amqp, channels } = setup()
  await amqp.amqpConsume('unoapi.broker', 'test.source', '*', async (phone, data) => {
    await amqp.amqpPublish('unoapi.broker', 'test.history', phone, data)
  }, { type: 'topic' })
  const [publisher, consumer] = channels
  const delivery = consumer.consume.mock.calls[0][1](message)
  await until(() => publisher.publish.mock.calls.length === 1)
  expect(consumer.ack).not.toHaveBeenCalled()
  publisher.publish.mock.calls[0][4](null)
  await delivery
  expect(consumer.ack).toHaveBeenCalledWith(message)
})

test('failed destination and failed retry retain original delivery and close consumer without ACK', async () => {
  const { amqp, channels } = setup()
  await amqp.amqpConsume('unoapi.broker', 'test.source', '*', async (phone, data) => {
    await amqp.amqpPublish('unoapi.broker', 'test.history', phone, data)
  }, { type: 'topic', notifyFailedMessages: false })
  const [publisher, consumer] = channels
  publisher.publish.mockImplementation((_e, _r, _b, _o, cb) => cb(new Error('broker nack')))
  await consumer.consume.mock.calls[0][1](message)
  expect(publisher.publish).toHaveBeenCalledTimes(2)
  expect(consumer.ack).not.toHaveBeenCalled()
  expect(consumer.close).toHaveBeenCalledTimes(1)
})

test('concurrent publishers share one confirm channel and replace it after closure', async () => {
  const { amqp, connection } = setup()
  const [first, second] = await Promise.all([amqp.amqpGetChannel(), amqp.amqpGetChannel()])
  expect(first).toBe(second)
  expect(connection.createConfirmChannel).toHaveBeenCalledTimes(1)
  first.emit('close')
  expect(await amqp.amqpGetChannel()).not.toBe(first)
  expect(connection.createConfirmChannel).toHaveBeenCalledTimes(2)
})

test.each([0, 2])('retry/dead-letter must also be confirmed before source ACK (previous attempts=%i)', async retries => {
  const { amqp, channels } = setup()
  const defaults = require('../src/defaults')
  await amqp.amqpConsume('unoapi.broker', 'test.source', '*', async () => { throw new Error('processing failed') },
    { type: 'topic', notifyFailedMessages: false })
  const [publisher, consumer] = channels
  const input = { ...message, properties: { headers: {
    [defaults.UNOAPI_X_COUNT_RETRIES]: retries, [defaults.UNOAPI_X_MAX_RETRIES]: 3,
  } } }
  const delivery = consumer.consume.mock.calls[0][1](input)
  await until(() => publisher.publish.mock.calls.length === 1)
  expect(publisher.publish.mock.calls[0][0]).toBe(retries === 0 ? 'unoapi.broker.delayed' : 'unoapi.broker.dead')
  expect(consumer.ack).not.toHaveBeenCalled()
  publisher.publish.mock.calls[0][4](null)
  await delivery
  expect(consumer.ack).toHaveBeenCalledWith(input)
})
