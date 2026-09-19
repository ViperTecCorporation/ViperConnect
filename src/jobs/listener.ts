import { amqpPublish } from '../amqp'
import { UNOAPI_EXCHANGE_BRIDGE_NAME, UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_HISTORY, UNOAPI_QUEUE_LISTENER, UNOAPI_SERVER_NAME } from '../defaults'
import { Listener } from '../services/listener'
import logger from '../services/logger'
import { Outgoing } from '../services/outgoing'
import { DecryptError } from '../services/transformer'
import { getConfig } from '../services/config'
import { providerQueueName } from '../services/providers/provider_queue'
import { packWaMessage, unpackWaMessage } from '../services/wa_message_envelope'
import { withHistoryQueue } from '../services/history_queue_context'

export class ListenerJob {
  private listener: Listener
  private outgoing: Outgoing
  private getConfig: getConfig

  constructor(listener: Listener, outgoing: Outgoing, getConfig: getConfig, private readonly historyQueue = false) {
    this.listener = listener
    this.outgoing = outgoing
    this.getConfig = getConfig
  }

  async consume(phone: string, data: object, options?: { countRetries: number; maxRetries: number, priority: 0 }) {
    const config = await this.getConfig(phone)
    if (config.server !== UNOAPI_SERVER_NAME) {
      logger.info(`Ignore listener routing key ${phone} server ${config.server} is not server current server ${UNOAPI_SERVER_NAME}...`)
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = data as any
    const { messages, type } = a
    const history = type === 'history'
    const exchange = history ? UNOAPI_EXCHANGE_BROKER_NAME : UNOAPI_EXCHANGE_BRIDGE_NAME
    const exchangeType = history ? 'topic' : 'direct'
    const listenerQueue = providerQueueName(history ? UNOAPI_QUEUE_HISTORY : UNOAPI_QUEUE_LISTENER, UNOAPI_SERVER_NAME, config.provider)
    if (history && !this.historyQueue) {
      // Old queued/delayed envelopes migrate lazily, without unpacking or processing.
      await amqpPublish(exchange, listenerQueue, phone, data, {
        type: exchangeType,
        ...(options ? { maxRetries: options.maxRetries, countRetries: Math.max(0, options.countRetries - 1) } : {}),
      })
      return
    }
    if (a.splited) {
      // Keep the packed AMQP payload untouched so a retry can safely serialize
      // the original envelope again.
      let unpackedMessages = a.messages || []
      try {
        unpackedMessages = unpackedMessages.map(unpackWaMessage)
      } catch {}
      try {
        const process = () => this.listener.process(phone, unpackedMessages, type)
        await (history ? withHistoryQueue(process) : process())
      } catch (error) {
        if (error instanceof DecryptError && options && options?.countRetries >= options?.maxRetries) {
          // send message asking to open whatsapp to see
          await this.outgoing.send(phone, error.getContent())
        } else {
          throw error
        }
      }
    } else {
      if (type == 'delete' && messages.keys) {
        await Promise.all(
          messages.keys.map(async (m: object) => {
            return amqpPublish(
              exchange,
              listenerQueue,
              phone,
              { messages: { keys: [m] }, type, splited: true },
              { type: exchangeType }
            )
         })
        )
      } else {
        const shouldPack = ['message', 'notify', 'qrcode', 'append', 'history'].includes(type)
        await Promise.all(messages.
          map(async (m: any) => {
            // Pack WAProto messages as base64 only when appropriate
            const payloadMsg = shouldPack ? packWaMessage(m) : m
            return amqpPublish(
              exchange,
              listenerQueue,
              phone,
              { messages: [payloadMsg], type, splited: true },
              { type: exchangeType }
            )
          })
        )
      }
    }
  }
}
