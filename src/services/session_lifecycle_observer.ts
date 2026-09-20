import { sessionEvent, sessionWebhookStore, SessionWebhookStore } from './session_webhook_store'
import type { SessionLifecycleEvent } from './session_webhook_types'
import logger from './logger'

/** No HTTP or RabbitMQ confirmation on the provider's callback path. */
export class SessionLifecycleObserver {
  private timer?: NodeJS.Timeout
  private pending = Promise.resolve()
  private unlinked = false
  private heartbeatPending = false
  constructor(private readonly store: Pick<SessionWebhookStore, 'record'> = sessionWebhookStore) {}

  observe(phone: string, connected: boolean, connection: Partial<SessionLifecycleEvent['connection']> = {}, verified = true): void {
    this.stop()
    if (!connected && this.unlinked && connection.is_logout !== true) return
    this.unlinked = !connected && connection.is_logout === true
    const state = connected ? 'connected' : connection.is_logout ? 'unlinked' : 'disconnected'
    const observation = sessionEvent(phone, state, connection)
    if (!verified) observation.last_verified_at = null
    this.enqueue(observation)
    if (connected) {
      this.timer = setInterval(() => {
        if (this.heartbeatPending) return
        const event = sessionEvent(phone, 'connected', connection)
        event.event = 'session.heartbeat'
        this.heartbeatPending = true
        this.enqueue(event)
        void this.pending.then(() => { this.heartbeatPending = false })
      }, 30_000)
      this.timer.unref()
    }
  }

  private enqueue(event: SessionLifecycleEvent): void {
    this.pending = this.pending.then(() => this.store.record('observe', event)).catch(() => {
      // Do not log transport errors: they may contain credentials or raw payloads.
      logger.warn({ phone: event.session.id, event: event.event }, 'SESSION_LIFECYCLE_PERSIST_FAILED')
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async flush(): Promise<void> { await this.pending }
}
