import { DATA_TTL, PROFILE_PICTURE_WEBHOOK_INTERVAL_SEC } from '../defaults'
import { BASE_KEY, getRedis } from './redis'
import { profilePictureCacheIds } from './profile_picture_cache'

type RedisClient = Awaited<ReturnType<typeof getRedis>>
type RedisFactory = () => Promise<RedisClient>

export type ProfilePictureWebhookMarkerOptions = {
  useRedis: boolean
  intervalSeconds?: number
  retentionSeconds?: number
  redisFactory?: RedisFactory
}

export class ProfilePictureWebhookMarker {
  private readonly sentAt = new Map<string, number>()
  private readonly intervalMs: number
  private readonly retentionSeconds: number
  private readonly redisFactory: RedisFactory

  constructor(private readonly options: ProfilePictureWebhookMarkerOptions) {
    this.intervalMs = Math.max(0, options.intervalSeconds ?? PROFILE_PICTURE_WEBHOOK_INTERVAL_SEC) * 1_000
    this.retentionSeconds = Math.max(1, options.retentionSeconds ?? DATA_TTL)
    this.redisFactory = options.redisFactory ?? getRedis
  }

  async isDue(phone: string, jid: string, nowMs = Date.now()): Promise<boolean> {
    if (this.intervalMs === 0) return true
    const member = this.member(jid)
    if (!member) return false

    if (this.options.useRedis) {
      try {
        const redis = await this.redisFactory()
        const score = await redis.zScore(this.key(phone), member)
        return score === null || nowMs - score >= this.intervalMs
      } catch {}
    }
    const score = this.sentAt.get(`${phone}:${member}`)
    return score === undefined || nowMs - score >= this.intervalMs
  }

  async markSent(phone: string, jid: string, nowMs = Date.now()): Promise<void> {
    const member = this.member(jid)
    if (!member) return
    this.sentAt.set(`${phone}:${member}`, nowMs)
    if (!this.options.useRedis) return

    try {
      const redis = await this.redisFactory()
      const key = this.key(phone)
      const cutoff = nowMs - this.retentionSeconds * 1_000
      await redis.zAdd(key, [{ score: nowMs, value: member }])
      await redis.zRemRangeByScore(key, 0, cutoff)
      await redis.expire(key, this.retentionSeconds)
    } catch {}
  }

  async invalidate(phone: string, jid: string): Promise<void> {
    const member = this.member(jid)
    if (!member) return
    this.sentAt.delete(`${phone}:${member}`)
    if (!this.options.useRedis) return
    try {
      const redis = await this.redisFactory()
      await redis.zRem(this.key(phone), member)
    } catch {}
  }

  private key(phone: string) {
    return `${BASE_KEY}profile-picture-webhook:${phone}`
  }

  private member(jid: string) {
    return profilePictureCacheIds(jid)[0]
  }
}
