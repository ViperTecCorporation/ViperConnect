import { AMQP_URL, UNOAPI_QUEUE_NAME } from '../defaults'
import { redactLogValue } from './log_redaction'

export type RabbitQueue = {
  name: string
  messages: number
  messages_ready: number
  messages_unacknowledged: number
  consumers: number
  state?: string
  memory?: number
  idle_since?: string
}

export type RabbitQueueMessage = {
  exchange: string
  routing_key: string
  redelivered: boolean
  message_count: number
  properties: unknown
  payload: unknown
}

export type RabbitManagementOptions = {
  baseUrl: string
  username: string
  password: string
  vhost: string
  queuePrefix: string
}

type Fetcher = typeof fetch
const voipWebhookQueues = new Set(['viperconnect.voip.webhooks.outgoing', 'viperconnect.voip.webhooks.dead'])

export class RabbitManagementError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'RabbitManagementError'
  }
}

export const rabbitManagementOptions = (
  amqpUrl = AMQP_URL,
  managementUrl = process.env.RABBITMQ_MANAGEMENT_URL || '',
): RabbitManagementOptions => {
  const parsed = new URL(amqpUrl)
  const secure = parsed.protocol === 'amqps:'
  const vhostPath = parsed.pathname.replace(/^\/+/, '')
  return {
    baseUrl: (managementUrl || `${secure ? 'https' : 'http'}://${parsed.hostname}:${secure ? 15671 : 15672}`).replace(/\/+$/, ''),
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    vhost: vhostPath ? decodeURIComponent(vhostPath) : '/',
    queuePrefix: UNOAPI_QUEUE_NAME,
  }
}

export const normalizeRabbitMessage = (message: any): RabbitQueueMessage => {
  let payload: unknown = message?.payload ?? ''
  if (message?.payload_encoding === 'base64') {
    payload = Buffer.from(`${payload}`, 'base64').toString('utf8')
  }
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {}
  }
  return {
    exchange: `${message?.exchange || ''}`,
    routing_key: `${message?.routing_key || ''}`,
    redelivered: message?.redelivered === true,
    message_count: Number(message?.message_count) || 0,
    properties: redactLogValue(message?.properties || {}),
    payload: redactLogValue(payload),
  }
}

export const rabbitMessageMatchesSession = (message: RabbitQueueMessage, session = ''): boolean => {
  const value = `${session || ''}`.trim()
  if (!value) return true
  return message.routing_key.includes(value) || JSON.stringify(message.payload).includes(value)
}

export class RabbitManagement {
  constructor(
    private readonly options = rabbitManagementOptions(),
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private queuePath(name = ''): string {
    return `/api/queues/${encodeURIComponent(this.options.vhost)}${name ? `/${encodeURIComponent(name)}` : ''}`
  }

  private assertQueueName(name: string, includeVoip = false): void {
    if (includeVoip && voipWebhookQueues.has(name)) return
    if (name !== this.options.queuePrefix && !name.startsWith(`${this.options.queuePrefix}.`)) {
      throw new RabbitManagementError(403, 'rabbit_queue_not_allowed')
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`)
      if (init.body) headers.set('Content-Type', 'application/json')
      const response = await this.fetcher(`${this.options.baseUrl}${path}`, { ...init, headers, signal: controller.signal })
      const text = await response.text()
      if (!response.ok) {
        throw new RabbitManagementError(response.status, `rabbit_management_http_${response.status}`)
      }
      return (text ? JSON.parse(text) : undefined) as T
    } catch (error) {
      if (error instanceof RabbitManagementError) throw error
      throw new RabbitManagementError(502, error instanceof Error ? error.message : 'rabbit_management_unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  async listQueues(): Promise<RabbitQueue[]> {
    const queues = await this.request<any[]>(this.queuePath())
    return queues
      .filter((queue) => {
        const name = `${queue?.name || ''}`
        return name === this.options.queuePrefix || name.startsWith(`${this.options.queuePrefix}.`) || voipWebhookQueues.has(name)
      })
      .map((queue) => ({
        name: `${queue.name}`,
        messages: Number(queue.messages) || 0,
        messages_ready: Number(queue.messages_ready) || 0,
        messages_unacknowledged: Number(queue.messages_unacknowledged) || 0,
        consumers: Number(queue.consumers) || 0,
        state: queue.state ? `${queue.state}` : undefined,
        memory: Number(queue.memory) || 0,
        idle_since: queue.idle_since ? `${queue.idle_since}` : undefined,
      }))
      .sort((left, right) => right.messages - left.messages || left.name.localeCompare(right.name))
  }

  async previewMessages(name: string, count = 20, session = ''): Promise<RabbitQueueMessage[]> {
    this.assertQueueName(name, true)
    const safeCount = Math.min(200, Math.max(1, Number(count) || 20))
    const messages = await this.request<any[]>(`${this.queuePath(name)}/get`, {
      method: 'POST',
      body: JSON.stringify({
        count: safeCount,
        ackmode: 'ack_requeue_true',
        encoding: 'auto',
        truncate: 100_000,
      }),
    })
    return messages
      .map(normalizeRabbitMessage)
      .filter((message) => rabbitMessageMatchesSession(message, session))
      .slice(0, safeCount)
  }

  async removeMessages(name: string, count: number): Promise<number> {
    this.assertQueueName(name)
    const messages = await this.request<any[]>(`${this.queuePath(name)}/get`, {
      method: 'POST',
      body: JSON.stringify({
        count: Math.min(50, Math.max(1, Number(count) || 1)),
        ackmode: 'ack_requeue_false',
        encoding: 'auto',
        truncate: 1,
      }),
    })
    return messages.length
  }

  async purgeQueue(name: string): Promise<void> {
    this.assertQueueName(name)
    await this.request<void>(`${this.queuePath(name)}/contents`, { method: 'DELETE' })
  }

  async deleteQueue(name: string): Promise<void> {
    this.assertQueueName(name)
    await this.request<void>(this.queuePath(name), { method: 'DELETE' })
  }
}
