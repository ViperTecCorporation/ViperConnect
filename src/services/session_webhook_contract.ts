import { randomUUID } from 'crypto'
import { SESSION_LIFECYCLE_EVENTS, PublicSessionWebhookDestination, SessionWebhookDestination } from './session_webhook_types'

export class SessionWebhookValidationError extends Error {}

export function publicSessionDestination(value: SessionWebhookDestination): PublicSessionWebhookDestination {
  const { bearer_token, signing_secret, ...rest } = value
  return { ...rest, has_bearer_token: !!bearer_token, has_signing_secret: !!signing_secret }
}

export function validateSessionDestination(input: Record<string, unknown>, previous?: SessionWebhookDestination): SessionWebhookDestination {
  const fail = (field: string): never => { throw new SessionWebhookValidationError(`invalid_${field}`) }
  const text = (field: string, max: number): string => {
    const value = input[field]
    if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(field)
    return value.trim()
  }
  const name = text('name', 100)
  const server = text('server', 100)
  const url = text('url', 2048)
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) fail('url')
  } catch { fail('url') }
  for (const field of ['enabled', 'auto_include_new_sessions']) if (typeof input[field] !== 'boolean') fail(field)
  if (!Array.isArray(input.session_ids) || input.session_ids.length > 1000 || input.session_ids.some(id => typeof id !== 'string' || !/^\d{5,20}$/.test(id))) fail('session_ids')
  if (!Array.isArray(input.events) || !input.events.length || input.events.some(event => !SESSION_LIFECYCLE_EVENTS.includes(event))) fail('events')
  const interval = input.heartbeat_interval_seconds ?? 300
  if (!Number.isInteger(interval) || Number(interval) < 60 || Number(interval) > 86400) fail('heartbeat_interval_seconds')
  const secret = (field: 'bearer_token' | 'signing_secret'): string => {
    const value = input[field] === undefined ? previous?.[field] || '' : input[field]
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) return fail(field)
    if (field === 'signing_secret' && value.length > 0 && value.length < 32) return fail(field)
    return value
  }
  return {
    id: previous?.id || randomUUID(), name, server, url,
    enabled: input.enabled as boolean, auto_include_new_sessions: input.auto_include_new_sessions as boolean,
    session_ids: [...new Set(input.session_ids as string[])], events: [...new Set(input.events as SessionWebhookDestination['events'])],
    heartbeat_interval_seconds: Number(interval), bearer_token: secret('bearer_token'), signing_secret: secret('signing_secret'), revision: randomUUID(),
  }
}
