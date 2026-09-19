/** Versioned integration contract; independent from legacy message webhooks. */
export type SessionLifecycleState = 'connected' | 'disconnected' | 'unlinked' | 'removed' | 'unavailable'
export type SessionLifecycleEventName = `session.${SessionLifecycleState}` | 'session.heartbeat'
export interface SessionLifecycleEvent {
  schema_version: 1
  event_id: string
  event: SessionLifecycleEventName
  occurred_at: string
  destination_id: string
  session: { id: string; label: string | null; provider: string; server: string }
  state: { previous: SessionLifecycleState | null; current: SessionLifecycleState; changed_at: string; sequence: number }
  connection: {
    reason: string | null; code: number | null; is_logout: boolean | null
    intentional: boolean | null; reconnect_expected: boolean | null; requires_pairing: boolean | null
  }
  last_verified_at: string | null
  last_observed_at: string
}
export interface SessionWebhookDestination {
  id: string
  name: string
  url: string
  enabled: boolean
  session_ids: string[]
  auto_include_new_sessions: boolean
  /** Required explicit server boundary, including for automatic future membership. */
  server: string
  events: SessionLifecycleEventName[]
  heartbeat_interval_seconds: number
  bearer_token: string
  signing_secret: string
  revision: string
}
export type PublicSessionWebhookDestination = Omit<SessionWebhookDestination, 'bearer_token' | 'signing_secret'> & {
  has_bearer_token: boolean; has_signing_secret: boolean
}
export type SessionWebhookDelivery = { destination_id: string; revision: string; event: SessionLifecycleEvent }
export const SESSION_LIFECYCLE_EVENTS: SessionLifecycleEventName[] = [
  'session.connected', 'session.disconnected', 'session.unlinked', 'session.removed', 'session.unavailable', 'session.heartbeat',
]
