import { connect, Connection, Channel, Replies, ChannelModel, Options, ConsumeMessage } from 'amqplib'
import {
  AMQP_URL,
  UNOAPI_X_COUNT_RETRIES,
  UNOAPI_X_MAX_RETRIES,
  UNOAPI_MESSAGE_RETRY_LIMIT,
  UNOAPI_MESSAGE_RETRY_DELAY,
  UNOAPI_QUEUE_BIND,
  NOTIFY_FAILED_MESSAGES,
  UNOAPI_QUEUE_NOTIFICATION,
  IGNORED_CONNECTIONS_NUMBERS,
  VALIDATE_ROUTING_KEY,
  CONSUMER_TIMEOUT_MS,
  UNOAPI_SERVER_NAME,
  UNOAPI_EXCHANGE_BROKER_NAME,
  UNOAPI_EXCHANGE_BRIDGE_NAME,
  IGNORED_TO_NUMBERS,
  WEBHOOK_CB_REQUEUE_DELAY_MS
} from './defaults'
import logger from './services/logger'
import { version } from '../package.json'
import { extractDestinyPhone } from './services/transformer'
import { isTransientInfraError } from './services/error_utils'
import { v1 as uuid } from 'uuid'
import { providerFromQueueName, providerQueueName } from './services/providers/provider_queue'

const withTimeout = (millis, error, promise) => {
  let timeoutPid
  const timeout = new Promise((_resolve, reject) =>
    timeoutPid = setTimeout(
      () => reject(error),
      millis))
  return Promise.race([
    promise,
    timeout
  ]).finally(() => {
    if (timeoutPid) {
      clearTimeout(timeoutPid)
    }
  })
}

export const queueDeadName = (queue: string) => `${queue}.dead`
export const queueDelayedName = (queue: string) => `${queue}.delayed`

let amqpChannelModel: ChannelModel | undefined
let amqpChannel: Channel | undefined
let amqpConnection: Connection | undefined
const AMQP_CONNECT_MAX_RETRIES = parseInt(process.env.AMQP_CONNECT_MAX_RETRIES || '30')
const AMQP_CONNECT_RETRY_DELAY_MS = parseInt(process.env.AMQP_CONNECT_RETRY_DELAY_MS || '2000')

type QueueObject = {
  queueMain: Replies.AssertQueue
  queueDead: Replies.AssertQueue
  queueDelayed: Replies.AssertQueue
}
const exchanges = new Map<string, boolean>()
const queues = new Map<string, QueueObject>()
const routes = new Map<string, boolean>()
const ROUTES_CACHE_LIMIT = 10000
type ConsumerConfig = {
  exchange: string
  queue: string
  routingKey: string
  callback: ConsumeCallback
  options: Partial<CreateOption>
}
const consumerConfigs = new Map<string, ConsumerConfig>()

export const extractRoutingKeyFromBindingKey = (bindingKey) => {
  const parts = bindingKey.split('.')
  return parts[parts.length - 1]
}

const validateFormatNumber = (v: string) => {
  if (![UNOAPI_SERVER_NAME].includes(v) && '' != v && '.*' != v && !/^\d+$/.test(v)) {
    throw `${v} is not a number`
  }
}
const validateRoutingKey = VALIDATE_ROUTING_KEY ? validateFormatNumber : (_) => _

export type ExchangeType = 'direct' | 'topic'

export type CreateOption = {
  delay: number
  priority: number
  notifyFailedMessages: boolean
  prefetch: number
  type: ExchangeType
}

export type PublishOption = CreateOption & {
  dead: boolean
  maxRetries: number
  countRetries: number
}

export interface ConsumeCallback {
  (routingKey: string, data: object, options?: { countRetries: number; maxRetries: number }): Promise<unknown>
}

const toRpcError = (error: unknown) => {
  const err = error as any
  return {
    message: err?.message || `${error}`,
    name: err?.name,
    stack: err?.stack,
  }
}

const replyRpc = async (channel: Channel, payload: ConsumeMessage, response: object) => {
  const replyTo = payload.properties.replyTo
  const correlationId = payload.properties.correlationId
  if (!replyTo || !correlationId) return
  channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(response)), { correlationId })
}

const resetAmqpState = (reason: unknown) => {
  try {
    logger.warn(reason as any, 'Resetting AMQP state after connection issue')
  } catch {
    logger.warn('Resetting AMQP state after connection issue')
  }
  amqpChannel = undefined
  amqpChannelModel = undefined
  exchanges.clear()
  queues.clear()
}

const consumerId = (exchange: string, queue: string, routingKey: string) => `${exchange}::${queue}::${routingKey}`

export const amqpConnect = async (amqpUrl = AMQP_URL) => {
  if (!amqpChannelModel) {
    let attempt = 0
    let lastError: unknown
    while (!amqpChannelModel && attempt < AMQP_CONNECT_MAX_RETRIES) {
      attempt += 1
      try {
        logger.info(`Connecting RabbitMQ at ${amqpUrl}...`)
        amqpChannelModel = await connect(amqpUrl)
        amqpConnection = amqpChannelModel.connection
      } catch (error) {
        lastError = error
        if (!isTransientInfraError(error) || attempt >= AMQP_CONNECT_MAX_RETRIES) {
          throw error
        }
        logger.warn(
          error as any,
          'Transient RabbitMQ connection failure on attempt %d/%d, retrying in %d ms',
          attempt,
          AMQP_CONNECT_MAX_RETRIES,
          AMQP_CONNECT_RETRY_DELAY_MS
        )
        await new Promise((resolve) => setTimeout(resolve, AMQP_CONNECT_RETRY_DELAY_MS))
      }
    }
    if (!amqpChannelModel && lastError) {
      throw lastError
    }
  } else {
    logger.info(`Already connected RabbitMQ!`)
  }

  amqpChannelModel.on('error', (err) => {
    logger.error(err, 'Connection Error')
    resetAmqpState(err)
  })
  amqpChannelModel.on('close', (err) => {
    logger.error(err, 'Connection Closed')
    resetAmqpState(err)
  })

  return amqpChannelModel
}

export const amqpDisconnect = async (amqpChannelModel: ChannelModel) => {
  logger.debug('Disconnecting RabbitMQ')
  return amqpChannelModel?.close()
}

export const amqpGetChannel = async () => {
  if (!amqpChannel) {
    logger.info('Creating channel...')
    await amqpConnect()
    amqpChannel = await amqpChannelModel?.createChannel()
    if (amqpChannel) {
      amqpChannel.on('error', (err) => logger.error(err, 'Channel Error'))
      amqpChannel.on('close', (err) => logger.error(err, 'Channel Closed'))
    }
    logger.info('Created channel!')
  }
  return amqpChannel
}

export const amqpGetExchange = async (exchange: string, type: ExchangeType, prefetch: number) => {
  if (!exchanges.get(exchange)) {
    logger.info('Creating exchange %s...', exchange)
    const channel = await amqpGetChannel()
    await channel?.prefetch(prefetch)
    await channel?.assertExchange(exchange, type, { durable: true,  arguments: { 'x-max-priority': 5 }})

    const exchangeDeadId = queueDeadName(exchange)
    await amqpChannel?.assertExchange(exchangeDeadId, 'topic', { durable: true })

    const exchangeDelayedId = queueDelayedName(exchange)
    await amqpChannel?.assertExchange(exchangeDelayedId, 'topic', { durable: true , arguments: {
      'x-dead-letter-exchange': exchange
    }})
    logger.info('Created exchange %s!', exchange)
    exchanges.set(exchange, true)
  }
}

const bindingKey = (queueName, routingKey) => {
  return `${queueName}${routingKey ? `.${routingKey}` : ''}`
}

const bindQueue = async (channel, exchangeName, queueName, routingKey, delayed = false) => {
  const queueNameToBind = delayed ? queueDelayedName(queueName) : queueName
  const destiny = bindingKey(queueNameToBind, routingKey)
  logger.info('Bind exchange %s binding key %s', exchangeName, destiny)
  await channel.bindQueue(queueName, exchangeName, destiny)
  return destiny
}

export const amqpGetQueue = async (
  exchange: string,
  queue: string,
  routingKey: string,
  options: Partial<CreateOption> = {
    delay: 0,
    priority: 0,
    notifyFailedMessages: NOTIFY_FAILED_MESSAGES,
    type: 'topic',
    prefetch: 1
  },
): Promise<QueueObject> => {
  if (!queues.get(queue)) {
    await amqpGetExchange(exchange, options.type!, options.prefetch!)
    const channel = await amqpGetChannel()
    logger.info('Creating queue %s...', queue)
    const queueMain = await channel?.assertQueue(queue, { durable: true })!
    let deadLetterExchange = exchange

    const queueDeadId = queueDeadName(queue)
    const exchangeDeadId = queueDeadName(exchange)
    const queueDead = await channel?.assertQueue(queueDeadId, { durable: true })!
    await amqpChannel?.bindQueue(queueDeadId, exchangeDeadId, `${queueDeadId}.*`)

    const exchangeDelayedId = queueDelayedName(exchange)
    const queueDelayedId = queueDelayedName(queue)
    const queueDelayed = await amqpChannel?.assertQueue(queueDelayedId, { durable: true, arguments: {
      'x-dead-letter-exchange': deadLetterExchange
    }})!
    await amqpChannel?.bindQueue(queueDelayedId, exchangeDelayedId, `${queueDelayedId}.*`)

    queues.set(queue, { queueMain, queueDead, queueDelayed })
    logger.info('Created queue %s!', queue)
  }


  validateRoutingKey(routingKey)
  const provider = providerFromQueueName(queue)
  const routeId = `${routingKey}:${provider || 'legacy'}`
  if (/^\d+$/.test(routingKey) && !routes.get(routeId)) {
    const bindQueueName = provider
      ? providerQueueName(UNOAPI_QUEUE_BIND, UNOAPI_SERVER_NAME, provider)
      : `${UNOAPI_QUEUE_BIND}.${UNOAPI_SERVER_NAME}`
    await amqpPublish(UNOAPI_EXCHANGE_BRIDGE_NAME, bindQueueName, '', { routingKey }, { type: 'direct' })
    routes.set(routeId, true)
    if (routes.size > ROUTES_CACHE_LIMIT) {
      const first = routes.keys().next().value
      routes.delete(first)
    }
  }
  return queues.get(queue)!
}


const getExchangeType = (exchange): ExchangeType => {
  if (UNOAPI_EXCHANGE_BRIDGE_NAME == exchange) {
    return 'direct'
  } else if (UNOAPI_EXCHANGE_BROKER_NAME == exchange) {
    return 'topic'
  } else {
    throw `Unknow exchange ${exchange}`
  }
}

export const amqpPublish = async (
  exchange: string,
  queue: string,
  routingKey: string,
  payload: object,
  options: Partial<PublishOption> = { 
    delay: 0,
    dead: false,
    maxRetries: UNOAPI_MESSAGE_RETRY_LIMIT,
    countRetries: 0,
    priority: 0
  },
) => {
  validateRoutingKey(routingKey)
  const channel = await amqpGetChannel()
  const prefetch = options.prefetch ?? 1
  options.prefetch = prefetch
  options.type = options.type || getExchangeType(exchange)
  logger.debug('Publishing at exchange: %s, with queue: %s, routing key: %s and type: %s', exchange, queue, routingKey, options.type)
  await amqpGetExchange(exchange, options.type!, prefetch)
  const { queueMain, queueDead, queueDelayed } = await amqpGetQueue(exchange, queue, routingKey, options)
  const { delay, dead, maxRetries, countRetries } = options
  const headers: any = {}
  headers[UNOAPI_X_COUNT_RETRIES] = countRetries
  headers[UNOAPI_X_MAX_RETRIES] = maxRetries
  let queueUsed = queueMain
  let exchangeUsed = exchange
  const properties: Options.Publish = {
    persistent: true,
    deliveryMode: 2,
    headers,
  }
  if (options.priority) {
    properties.priority = options.priority
  }
  if (delay) {
    const delayMilliseconds: number = typeof delay == 'number' ? delay : UNOAPI_MESSAGE_RETRY_DELAY
    properties.expiration = delayMilliseconds
    exchangeUsed = queueDelayedName(exchange)
    queueUsed = queueDelayed
  } else if (dead) {
    queueUsed = queueDead
    exchangeUsed = queueDeadName(exchange)
  }
  const destiny = bindingKey(queueUsed.queue, routingKey)
  await channel?.publish(exchangeUsed, destiny, Buffer.from(JSON.stringify(payload)), properties)
  logger.debug(
    'Published at exchange %s, with binding key: %s, payload: %s, properties: %s',
    exchangeUsed,
    destiny,
    JSON.stringify(payload),
    JSON.stringify(properties)
  )
}

export const amqpRpc = async <T = unknown>(
  exchange: string,
  queue: string,
  routingKey: string,
  payload: object,
  options: Partial<PublishOption> & { timeoutMs?: number } = {
    delay: 0,
    dead: false,
    maxRetries: UNOAPI_MESSAGE_RETRY_LIMIT,
    countRetries: 0,
    priority: 0,
  },
): Promise<T> => {
  validateRoutingKey(routingKey)
  const channel = await amqpGetChannel()
  const prefetch = options.prefetch ?? 1
  options.prefetch = prefetch
  options.type = options.type || getExchangeType(exchange)
  await amqpGetExchange(exchange, options.type!, prefetch)
  const { queueMain } = await amqpGetQueue(exchange, queue, routingKey, options)
  const replyQueue = await channel?.assertQueue('', { exclusive: true, autoDelete: true })
  if (!channel || !replyQueue) {
    throw new Error('AMQP channel is not available')
  }

  const correlationId = uuid()
  const timeoutMs = options.timeoutMs ?? CONSUMER_TIMEOUT_MS
  const { delay, dead, maxRetries = UNOAPI_MESSAGE_RETRY_LIMIT, countRetries = 0 } = options
  if (delay || dead) {
    throw new Error('AMQP RPC does not support delayed or dead-letter publishing')
  }

  const headers: any = {}
  headers[UNOAPI_X_COUNT_RETRIES] = countRetries
  headers[UNOAPI_X_MAX_RETRIES] = maxRetries
  const properties: Options.Publish = {
    persistent: true,
    deliveryMode: 2,
    headers,
    replyTo: replyQueue.queue,
    correlationId,
  }
  if (options.priority) {
    properties.priority = options.priority
  }

  return new Promise<T>(async (resolve, reject) => {
    let consumerTag = ''
    const timeoutPid = setTimeout(async () => {
      try {
        if (consumerTag) await channel.cancel(consumerTag)
        await channel.deleteQueue(replyQueue.queue)
      } catch {}
      reject(new Error(`timeout ${timeoutMs} is exceeded rpc queue: ${queue}, routing key: ${routingKey}`))
    }, timeoutMs)

    try {
      const consumer = await channel.consume(replyQueue.queue, async (message) => {
        if (!message || message.properties.correlationId !== correlationId) return
        clearTimeout(timeoutPid)
        try {
          if (consumerTag) await channel.cancel(consumerTag)
          await channel.deleteQueue(replyQueue.queue)
        } catch {}
        try {
          const response = JSON.parse(message.content.toString())
          if (!response?.ok) {
            const err = new Error(response?.error?.message || 'AMQP RPC failed')
            ;(err as any).remote = response?.error
            reject(err)
            return
          }
          resolve(response.result as T)
        } catch (error) {
          reject(error)
        }
      }, { noAck: true })
      consumerTag = consumer.consumerTag
      const destiny = bindingKey(queueMain.queue, routingKey)
      channel.publish(exchange, destiny, Buffer.from(JSON.stringify(payload)), properties)
      logger.debug(
        'Published RPC at exchange %s, with binding key: %s, payload: %s, properties: %s',
        exchange,
        destiny,
        JSON.stringify(payload),
        JSON.stringify(properties)
      )
    } catch (error) {
      clearTimeout(timeoutPid)
      try {
        if (consumerTag) await channel.cancel(consumerTag)
        await channel.deleteQueue(replyQueue.queue)
      } catch {}
      reject(error)
    }
  })
}

export const amqpConsume = async (
  exchange: string,
  queue: string,
  routingKey: string,
  callback: ConsumeCallback,
  options: Partial<CreateOption> = {
    delay: UNOAPI_MESSAGE_RETRY_DELAY, 
    priority: 0,
    notifyFailedMessages: NOTIFY_FAILED_MESSAGES
  },
) => {
  logger.debug('Configurate to consume exchange: %s, queue: %s, routing key: %s and type: %s', exchange, queue, routingKey, options.type)
  validateRoutingKey(routingKey)
  const prefetch = options.prefetch ?? 1
  const type = options.type || getExchangeType(exchange)
  const normalizedOptions = { ...options, prefetch, type }
  const id = consumerId(exchange, queue, routingKey)
  if (consumerConfigs.has(id)) {
    logger.debug('Consumer %s already registered, skipping duplicate registration', id)
    return
  }

  consumerConfigs.set(id, { exchange, queue, routingKey, callback, options: normalizedOptions })

  const startConsumer = async () => {
    try {
      await amqpGetExchange(exchange, type, prefetch)
      await amqpGetQueue(exchange, queue, routingKey, normalizedOptions)
      const connection = await amqpConnect()
      const channel = await connection.createChannel()
      await channel.prefetch(prefetch)

      const fn = async (payload: ConsumeMessage | null) => {
        if (!payload) {
          throw `payload not be null `
        }
        const content: string = payload.content.toString()
        const routingKeyLocal = extractRoutingKeyFromBindingKey(payload.fields.routingKey)
        const data = JSON.parse(content)
        const headers = payload.properties.headers || {}
        const maxRetries = parseInt(headers[UNOAPI_X_MAX_RETRIES] || UNOAPI_MESSAGE_RETRY_LIMIT)
        const countRetries = parseInt(headers[UNOAPI_X_COUNT_RETRIES] || '0') + 1
        const isRpc = !!(payload.properties.replyTo && payload.properties.correlationId)
        try {
          logger.debug('Received in queue %s, with routing key: %s, with message: %s with headers: %s', queue, routingKeyLocal, content, JSON.stringify(payload.properties.headers))
          if (!isRpc && IGNORED_CONNECTIONS_NUMBERS.includes(routingKeyLocal)) {
            logger.info(`Ignore messages from ${routingKeyLocal}`)
          } else if (!isRpc &&
            IGNORED_TO_NUMBERS.length > 0 &&
            (data as any).payload &&
            IGNORED_TO_NUMBERS.includes(extractDestinyPhone((data as any).payload, false))
          ) {
            logger.info(`Ignore messages to ${extractDestinyPhone((data as any).payload, false)}`)
          } else {
            const timeoutError = `timeout ${CONSUMER_TIMEOUT_MS} is exceeded consume queue: ${queue}, routing key: ${routingKeyLocal}, payload: ${content}`
            const result = await withTimeout(CONSUMER_TIMEOUT_MS, timeoutError, callback(routingKeyLocal, data, { countRetries, maxRetries }))
            await replyRpc(channel, payload, { ok: true, result })
          }
          logger.debug('Ack message!')
          await channel?.ack(payload)
        } catch (error) {
          logger.error(error, 'Error on consume %s', queue)
          if (payload.properties.replyTo && payload.properties.correlationId) {
            await replyRpc(channel, payload, { ok: false, error: toRpcError(error) })
            await channel?.ack(payload)
            return
          }
          if (countRetries >= maxRetries) {
            logger.info('Reject %s retries', countRetries)
            if (normalizedOptions.notifyFailedMessages) {
              logger.info('Sending error to whatsapp...')
              const errObj: any = error as any
              const errorText = (() => {
                try {
                  if (errObj && typeof errObj === 'object') {
                    return JSON.stringify(errObj)
                  }
                  return `${errObj}`
                } catch {
                  return `${errObj}`
                }
              })()
              await amqpPublish(
                UNOAPI_EXCHANGE_BROKER_NAME,
                UNOAPI_QUEUE_NOTIFICATION,
                routingKeyLocal,
                {
                  payload: {
                    to: routingKeyLocal,
                    type: 'text',
                    text: {
                      body: `Unoapi version ${version} message failed in queue ${queue}\n\nstack trace: ${errObj?.stack || '<none>'}\n\n\nerror: ${errObj?.message || errorText}\n\ndata: ${JSON.stringify(data, undefined, 2)}`,
                    },
                  },
                },
                { maxRetries: 0, type: 'topic' },
              )
              logger.info('Sent error to whatsapp!')
            }
            await amqpPublish(exchange, queue, routingKeyLocal, data, { dead: true, type: normalizedOptions.type })
          } else {
            logger.info('Publish retry %s of %s', countRetries, maxRetries)
            let delay = 60000
            try {
              const err: any = error as any
              if (err && (err.code === 'WEBHOOK_CB_OPEN' || err.name === 'WebhookCircuitOpenError')) {
                delay = err.delayMs || WEBHOOK_CB_REQUEUE_DELAY_MS || delay
                logger.info('WEBHOOK_CB requeue delay %s ms (queue=%s)', delay, queue)
              }
            } catch {}
            await amqpPublish(exchange, queue, routingKeyLocal, data, { delay, maxRetries, countRetries, type: normalizedOptions.type })
          }
          await channel?.ack(payload)
        }
      }

      const bindingKeyValue = await bindQueue(channel, exchange, queue, routingKey)
      await bindQueue(channel, exchange, queue, routingKey, true)

      channel?.on('close', () => {
        logger.warn('Channel closed for queue %s, rebinding consumer...', queue)
        setTimeout(() => {
          startConsumer().catch((err) => logger.error(err, 'Error restarting consumer %s', id))
        }, 1000)
      })
      channel?.on('error', (err) => {
        logger.error(err, 'Channel error for queue %s', queue)
      })

      await channel?.consume(queue, fn)
      logger.info('Waiting for message in queue %s with binding key %s', queue, bindingKeyValue)
    } catch (err) {
      logger.error(err, 'Failed to start consumer %s, will retry', id)
      setTimeout(() => {
        startConsumer().catch((error) => logger.error(error, 'Error restarting consumer %s', id))
      }, 1000)
    }
  }

  await startConsumer()
}
