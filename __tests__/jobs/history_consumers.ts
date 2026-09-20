jest.mock('../../src/amqp', () => ({ amqpConsume: jest.fn() }))
import { amqpConsume } from '../../src/amqp'
import { startHistoryConsumers } from '../../src/jobs/history_consumers'
import { isHistoryQueue } from '../../src/services/history_queue_context'

test('registers exactly two independent topic consumers, each with prefetch one', async () => {
  const callback = jest.fn(async () => { expect(isHistoryQueue()).toBe(true) })
  await startHistoryConsumers('unoapi.history.server_1.zapo', callback, false)
  const calls = (amqpConsume as jest.Mock).mock.calls
  expect(calls).toHaveLength(2)
  for (let index = 0; index < 2; index++) {
    expect(calls[index].slice(0, 3)).toEqual(['unoapi.broker', 'unoapi.history.server_1.zapo', '*'])
    expect(calls[index][4]).toEqual({ prefetch: 1, type: 'topic', notifyFailedMessages: false, consumerId: `history-${index}` })
    await calls[index][3]('5566', { messages: [] }, { countRetries: 2, maxRetries: 5 })
  }
  expect(callback).toHaveBeenCalledWith('5566', { messages: [] }, { countRetries: 2, maxRetries: 5 })
  expect(isHistoryQueue()).toBe(false)
})
