/* eslint-disable @typescript-eslint/no-var-requires */
import { EventEmitter } from 'events'
jest.mock('../src/services/logger', () => ({ __esModule: true, default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const setup = () => {
  jest.resetModules()
  const channels: any[] = []
  const create = jest.fn(async () => {
    const channel = Object.assign(new EventEmitter(), {
      prefetch: jest.fn(), assertExchange: jest.fn(), bindQueue: jest.fn(),
      assertQueue: jest.fn(async queue => ({ queue })), publish: jest.fn(),
      ack: jest.fn(), consume: jest.fn(), close: jest.fn(async () => undefined),
    })
    channels.push(channel)
    return channel
  })
  const connection = Object.assign(new EventEmitter(), { createChannel: create, createConfirmChannel: create })
  jest.doMock('amqplib', () => ({ connect: jest.fn(async () => connection) }))
  return { channels, amqp: require('../src/amqp') as typeof import('../src/amqp'),
    errors: require('../src/services/non_retryable_queue_error') as typeof import('../src/services/non_retryable_queue_error'),
    defaults: require('../src/defaults') as typeof import('../src/defaults'),
    circuit: require('../src/services/webhook_circuit_breaker') as typeof import('../src/services/webhook_circuit_breaker') }
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve()
  expect(check()).toBe(true)
}

test.each(['trusted terminal', 'forged payload', 'forged error name', 'ordinary error', 'temporary migration', 'circuit open'] as const)('%s keeps existing confirmed retry/dead-letter and ACK semantics', async mode => {
  const { channels, amqp, errors, defaults, circuit } = setup()
  const error = mode === 'trusted terminal' ? new errors.NonRetryableQueueError(Object.assign(new Error('409: session_storage_fixture_external_effects_forbidden'), { code: 409, title: 'session_storage_fixture_external_effects_forbidden' }))
    : mode === 'forged error name' ? Object.assign(new Error('not trusted'), { name: 'NonRetryableQueueError', nonRetryable: true })
      : mode === 'circuit open' ? new circuit.WebhookCircuitOpenError('open', 1000, false)
        : new Error(mode === 'temporary migration' ? '409: session_storage_operation_in_progress' : 'temporary error')
  await amqp.amqpConsume('unoapi.broker', 'test.video.policy', '*', async () => { throw error }, { type: 'topic', notifyFailedMessages: false })
  const [publisher, consumer] = channels
  const message = { content: Buffer.from(JSON.stringify({ id: 'original', nonRetryable: true, name: 'NonRetryableQueueError' })), fields: { routingKey: 'test.video.policy.999123456789' }, properties: { headers: { [defaults.UNOAPI_X_COUNT_RETRIES]: 0, [defaults.UNOAPI_X_MAX_RETRIES]: 3 } } }
  const delivery = consumer.consume.mock.calls[0][1](message)
  await until(() => publisher.publish.mock.calls.length === 1)
  expect(publisher.publish.mock.calls[0][0]).toBe(mode === 'trusted terminal' ? 'unoapi.broker.dead' : 'unoapi.broker.delayed')
  if (mode !== 'trusted terminal') {
    expect(publisher.publish.mock.calls[0][3].headers[defaults.UNOAPI_X_COUNT_RETRIES]).toBe(mode === 'circuit open' ? 0 : 1)
    expect(publisher.publish.mock.calls[0][3].headers[defaults.UNOAPI_X_MAX_RETRIES]).toBe(3)
  }
  expect(consumer.ack).not.toHaveBeenCalled()
  publisher.publish.mock.calls[0][4](null)
  await delivery
  expect(consumer.ack).toHaveBeenCalledWith(message)
  expect(publisher.publish).toHaveBeenCalledTimes(1)
})

test.each([false, true])('trusted terminal preserves failed notification policy and waits for final dead-letter confirmation (notify=%s)', async notifyFailedMessages => {
  const { channels, amqp, errors } = setup()
  await amqp.amqpConsume('unoapi.broker', 'test.video.policy', '*', async () => { throw new errors.NonRetryableQueueError(new Error('fixture refusal')) }, { type: 'topic', notifyFailedMessages })
  const [publisher, consumer] = channels
  const message = { content: Buffer.from('{"id":"original"}'), fields: { routingKey: 'test.video.policy.999123456789' }, properties: { headers: {} } }
  const delivery = consumer.consume.mock.calls[0][1](message)
  await until(() => publisher.publish.mock.calls.length === 1)
  if (notifyFailedMessages) {
    expect(publisher.publish.mock.calls[0][0]).toBe('unoapi.broker')
    publisher.publish.mock.calls[0][4](null)
    await until(() => publisher.publish.mock.calls.length === 2)
  }
  expect(publisher.publish.mock.calls.at(-1)[0]).toBe('unoapi.broker.dead')
  expect(consumer.ack).not.toHaveBeenCalled()
  publisher.publish.mock.calls.at(-1)[4](null)
  await delivery
  expect(consumer.ack).toHaveBeenCalledWith(message)
})

test('failed terminal dead-letter publication retains the original unacknowledged delivery', async () => {
  const { channels, amqp, errors } = setup()
  await amqp.amqpConsume('unoapi.broker', 'test.video.policy', '*', async () => { throw new errors.NonRetryableQueueError(new Error('fixture refusal')) }, { type: 'topic', notifyFailedMessages: false })
  const [publisher, consumer] = channels
  publisher.publish.mockImplementation((_exchange, _key, _buffer, _options, callback) => callback(new Error('broker nack')))
  const message = { content: Buffer.from('{"id":"original"}'), fields: { routingKey: 'test.video.policy.999123456789' }, properties: { headers: {} } }
  await consumer.consume.mock.calls[0][1](message)
  expect(publisher.publish).toHaveBeenCalledTimes(1)
  expect(consumer.ack).not.toHaveBeenCalled()
  expect(consumer.close).toHaveBeenCalledTimes(1)
})
