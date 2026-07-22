import { CONTACT_SYNC_SCAN_COUNT, STATUS_RECIPIENT_RETENTION_SEC } from '../../defaults'
import { BASE_KEY, getRedis } from '../redis'
import { phoneNumberToJid } from '../transformer/jid'

type RedisClient = Awaited<ReturnType<typeof getRedis>>
type RedisFactory = () => Promise<RedisClient>

const normalizeRecipient = (value: string): string | undefined => {
  const raw = `${value || ''}`.trim()
  if (!raw || raw.includes('@lid') || raw.includes('@g.us')) return undefined
  const jid = phoneNumberToJid(raw)
  return /^\d+@s\.whatsapp\.net$/.test(jid) ? jid : undefined
}

export class StatusRecipients {
  constructor(
    private readonly redisFactory: RedisFactory = getRedis,
    private readonly retentionSec = STATUS_RECIPIENT_RETENTION_SEC,
  ) {}

  private key(phone: string) {
    return `${BASE_KEY}status-recipients:${phone}`
  }

  private async prune(redis: RedisClient, phone: string, nowMs: number) {
    const cutoff = nowMs - Math.max(1, this.retentionSec) * 1000
    await redis.zRemRangeByScore(this.key(phone), 0, cutoff)
  }

  async touch(phone: string, recipients: readonly string[], nowMs = Date.now()): Promise<number> {
    const normalized = Array.from(new Set(recipients.flatMap((value) => {
      const jid = normalizeRecipient(value)
      return jid ? [jid] : []
    })))
    if (!normalized.length) return 0
    const redis = await this.redisFactory()
    await redis.zAdd(this.key(phone), normalized.map((value) => ({ score: nowMs, value })))
    await this.prune(redis, phone, nowMs)
    await redis.expire(this.key(phone), Math.max(1, this.retentionSec))
    return normalized.length
  }

  async load(phone: string, nowMs = Date.now()): Promise<string[]> {
    const redis = await this.redisFactory()
    await this.prune(redis, phone, nowMs)
    return redis.zRange(this.key(phone), 0, -1)
  }

  async loadOrBootstrap(phone: string, nowMs = Date.now()): Promise<string[]> {
    const cached = await this.load(phone, nowMs)
    if (cached.length) return cached

    const redis = await this.redisFactory()
    const prefix = `${BASE_KEY}contact-info:${phone}:`
    const count = Math.max(10, CONTACT_SYNC_SCAN_COUNT || 500)
    const recipients: string[] = []
    let cursor = '0'
    do {
      const result = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: count })
      cursor = `${result.cursor}`
      const keys = result.keys || []
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue
        const jid = normalizeRecipient(key.slice(prefix.length))
        if (jid) recipients.push(jid)
      }
      if (keys.length) {
        const transaction = redis.multi()
        for (const key of keys) transaction.expire(key, Math.max(1, this.retentionSec))
        await transaction.exec()
      }
    } while (cursor !== '0')
    await this.touch(phone, recipients, nowMs)
    return Array.from(new Set(recipients))
  }
}

export const statusRecipients = new StatusRecipients()
