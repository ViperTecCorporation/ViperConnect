import { randomUUID } from 'crypto'
import { configKey, getRedis, publishConfigUpdate } from './redis'
import logger from './logger'
import { configs } from './config'

const fields = ['id', 'url', 'urlAbsolute', 'token', 'header', 'timeoutMs', 'enabled', 'disabled',
  'sendNewMessages', 'sendUpdateMessages', 'sendGroupMessages', 'sendOutgoingMessages',
  'sendNewsletterMessages', 'sendIncomingMessages', 'sendTranscribeAudio',
  'addToBlackListOnOutgoingMessageWithTtl', 'typebot']
type Hook = Record<string, any>
export interface WebhookHistoryEntry {
  id: string; archived_at: string; reason: string; server: string; webhooks: Hook[]
}
export const webhookHistoryKey = (phone: string) => `unoapi-webhook-history:${phone}`
export const ARCHIVE_WEBHOOKS_LUA = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, 19)
redis.call('PERSIST', KEYS[1])
return 1
`
export const RESTORE_WEBHOOKS_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`
export class WebhookHistoryError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
const pick = (hook: Hook): Hook => Object.fromEntries(fields.filter(key => hook[key] !== undefined).map(key => [key, hook[key]]))
export function publicWebhookHistory(entry: WebhookHistoryEntry) {
  return { ...entry, webhooks: entry.webhooks.map(hook => {
    let destination = ''
    try { destination = new URL(hook.urlAbsolute || hook.url).origin } catch {}
    return { id: hook.id, destination, has_credentials: !!(hook.token || hook.header),
      events: Object.keys(hook).filter(key => key.startsWith('send') && hook[key] === true) }
  }) }
}

export class WebhookHistory {
  private pending = new Set<Promise<unknown>>()
  constructor(private readonly redis: () => Promise<any> = () => getRedis(), private readonly invalidate = (phone: string) => publishConfigUpdate(phone)) {}

  // Never awaited by configuration writes, deregistration, login or reconnect.
  capture(phone: string, config: any, reason: 'updated' | 'removed' | 'restored'): void {
    if (!Array.isArray(config?.webhooks) || !config.webhooks.length) return
    try {
      if (this.pending.size >= 100) throw new Error('busy')
      const entry: WebhookHistoryEntry = { id: randomUUID(), archived_at: new Date().toISOString(),
        reason, server: config.server || 'server_1', webhooks: config.webhooks.map(pick) }
      const serialized = JSON.stringify(entry)
      if (Buffer.byteLength(serialized) > 262144) throw new Error('too_large')
      const task = this.redis().then(redis => redis.eval(ARCHIVE_WEBHOOKS_LUA, {
        keys: [webhookHistoryKey(phone)], arguments: [serialized],
      })).catch(() => { logger.warn({ phone }, 'WEBHOOK_HISTORY_ARCHIVE_FAILED') })
      this.pending.add(task)
      void task.finally(() => this.pending.delete(task))
    } catch { logger.warn({ phone }, 'WEBHOOK_HISTORY_ARCHIVE_FAILED') }
  }

  async entries(phone: string): Promise<WebhookHistoryEntry[]> {
    return (await (await this.redis()).lRange(webhookHistoryKey(phone), 0, 19)).map((value: string) => JSON.parse(value))
  }

  async restore(phone: string, snapshot: string, ids: string[], replace: boolean): Promise<void> {
    const redis = await this.redis()
    const raw = await redis.get(configKey(phone))
    if (!raw) throw new WebhookHistoryError(404, 'session_not_found')
    const current = JSON.parse(raw)
    const entry = (await this.entries(phone)).find(item => item.id === snapshot)
    if (!entry) throw new WebhookHistoryError(404, 'snapshot_not_found')
    if (entry.server !== (current.server || 'server_1')) throw new WebhookHistoryError(409, 'session_server_mismatch')
    const selected = ids.map(id => {
      const matches = entry.webhooks.filter(hook => hook.id === id)
      if (matches.length !== 1) throw new WebhookHistoryError(400, 'invalid_webhook_id')
      // Normalize the legacy flag so the existing editor can enable it later.
      return { ...pick(matches[0]), enabled: false, disabled: false }
    })
    const existing: Hook[] = current.webhooks || []
    if (!replace && existing.some(hook => ids.includes(hook.id))) throw new WebhookHistoryError(409, 'webhook_id_conflict')
    const next = { ...current, webhooks: [...existing.filter(hook => !ids.includes(hook.id)), ...selected] }
    const changed = await redis.eval(RESTORE_WEBHOOKS_LUA, {
      keys: [configKey(phone)], arguments: [raw, JSON.stringify(next)],
    })
    if (Number(changed) !== 1) throw new WebhookHistoryError(409, 'configuration_changed')
    this.capture(phone, current, 'restored')
    configs.delete(phone)
    await this.invalidate(phone) // Cache invalidation only; never calls reload/logout.
  }
}
export const webhookHistory = new WebhookHistory()
