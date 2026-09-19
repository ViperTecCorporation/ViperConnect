import type { ConfirmChannel, Options, Message } from 'amqplib'
import { randomUUID } from 'crypto'

const publishers = new WeakMap<ConfirmChannel, Map<string, (error?: Error) => void>>()

// One set of listeners per channel, even when a history batch publishes in parallel.
export const publishConfirmed = (
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish,
  timeoutMs = 30_000,
): Promise<void> => {
  let pending = publishers.get(channel)
  if (!pending) {
    pending = new Map()
    publishers.set(channel, pending)
    const entries = pending
    channel.on('return', (message: Message) => {
      entries.get(message.properties.messageId)?.(new Error('amqp_publish_unroutable'))
    })
    channel.on('close', () => {
      for (const finish of entries.values()) finish(new Error('amqp_publish_channel_closed'))
    })
    channel.on('error', (error: Error) => {
      for (const finish of entries.values()) finish(error)
    })
  }
  const entries = pending
  return new Promise<void>((resolve, reject) => {
    const messageId = randomUUID()
    const finish = (error?: Error) => {
      if (!entries.delete(messageId)) return
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(new Error('amqp_publish_confirm_timeout'))
      // Discard an uncertain channel; callers retain/retry their original job.
      void channel.close().catch(() => undefined)
    }, timeoutMs)
    entries.set(messageId, finish)
    try {
      channel.publish(exchange, routingKey, content, { ...options, mandatory: true, messageId },
        error => finish(error || undefined))
    } catch (error) {
      finish(error as Error)
    }
  })
}
