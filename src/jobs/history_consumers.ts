import { amqpConsume, ConsumeCallback } from '../amqp'
import { UNOAPI_EXCHANGE_BROKER_NAME } from '../defaults'
import { withHistoryQueue } from '../services/history_queue_context'

// Fixed per process, not per session. Each consumer has its own channel/QoS.
export const startHistoryConsumers = async (
  queue: string,
  callback: ConsumeCallback,
  notifyFailedMessages: boolean,
) => {
  for (let index = 0; index < 2; index += 1) {
    await amqpConsume(
      UNOAPI_EXCHANGE_BROKER_NAME,
      queue,
      '*',
      (phone, data, options) => withHistoryQueue(() => callback(phone, data, options)),
      { type: 'topic', prefetch: 1, notifyFailedMessages, consumerId: `history-${index}` },
    )
  }
}
