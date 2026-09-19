import { createHmac } from 'crypto'
import { amqpConsume, amqpPublish } from '../amqp'
import { UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_SESSION_EVENTS } from '../defaults'
import { sessionEvent, sessionWebhookStore, SessionWebhookStore } from '../services/session_webhook_store'
import { SessionWebhookDelivery } from '../services/session_webhook_types'
import logger from '../services/logger'

export class SessionWebhooksJob {
  private running = false
  private cursor = 0
  constructor(
    private readonly store: SessionWebhookStore = sessionWebhookStore,
    private readonly publish = amqpPublish,
    private readonly request: typeof fetch = fetch,
  ) {}

  async consume(_phone: string, delivery: SessionWebhookDelivery): Promise<void> {
    const destination = (await this.store.destinations()).find(item => item.id === delivery.destination_id)
    // An edited/deleted/disabled destination must never redirect an old snapshot
    // to a different integration. The receiver can reconcile using the state API.
    if (!destination?.enabled || destination.revision !== delivery.revision) return
    const body = JSON.stringify(delivery.event)
    const timestamp = `${Math.floor(Date.now() / 1000)}`
    const signature = createHmac('sha256', destination.signing_secret).update(`${timestamp}.${body}`).digest('hex')
    try {
      const response = await this.request.call(globalThis, destination.url, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json', 'X-ViperConnect-Event-Id': delivery.event.event_id,
          'X-ViperConnect-Timestamp': timestamp, 'X-ViperConnect-Signature': `sha256=${signature}`,
          ...(destination.bearer_token ? { Authorization: `Bearer ${destination.bearer_token}` } : {}),
        },
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`session_webhook_http_${response.status}`)
    } catch {
      // Let the existing AMQP retry/dead-letter policy act, without leaking URL/token.
      throw new Error('session_webhook_delivery_failed')
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const previous of await this.store.states()) {
        if (previous.state.current === 'connected' && now - Date.parse(previous.last_observed_at) > 120_000) {
          const event = sessionEvent(previous.session.id, 'unavailable', { reason: 'worker_observation_expired' }, new Date(now).toISOString())
          await this.store.record('observe', event, previous.last_observed_at)
        }
      }
      const page = await this.store.pending(this.cursor)
      this.cursor = page.cursor
      for (const item of page.entries) {
        await this.publish(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_SESSION_EVENTS, item.delivery.event.session.id, item.delivery, { type: 'topic' })
        await this.store.acknowledge(item.id)
      }
    } finally { this.running = false }
  }
}

export async function startSessionWebhooks(): Promise<NodeJS.Timeout> {
  const job = new SessionWebhooksJob()
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_SESSION_EVENTS, '*', job.consume.bind(job), {
    type: 'topic', prefetch: 2, notifyFailedMessages: false,
  })
  const tick = () => { void job.tick().catch(() => logger.warn('SESSION_WEBHOOK_OUTBOX_RETRY')) }
  tick()
  const timer = setInterval(tick, 5_000)
  timer.unref()
  return timer
}
