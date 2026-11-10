import { PROFILE_PICTURE_NOT_FOUND_TTL_SEC } from '../defaults'
import { BASE_KEY } from './redis'
import { profilePictureCacheIds } from './profile_picture_cache'
import type { SessionStateRedis } from './session_storage/state_redis'
import { getSessionPrivateState, rethrowSessionStateFence } from './session_storage/private_state'

type RedisClient = Pick<SessionStateRedis, 'zScore' | 'zRem' | 'zRemRangeByScore' | 'zAdd' | 'expire'>
type RedisFactory = (phone: string) => Promise<RedisClient>

export type ProfilePictureMissCacheOptions = {
  useRedis: boolean
  ttlSeconds?: number
  redisFactory?: RedisFactory
}

export class ProfilePictureMissCache {
  private readonly expiresAt = new Map<string, number>()
  private readonly ttlMs: number
  private readonly redisFactory: RedisFactory

  constructor(private readonly options: ProfilePictureMissCacheOptions) {
    this.ttlMs = Math.max(0, options.ttlSeconds ?? PROFILE_PICTURE_NOT_FOUND_TTL_SEC) * 1_000
    this.redisFactory = options.redisFactory ?? getSessionPrivateState
  }

  async has(phone: string, jid: string, nowMs = Date.now()): Promise<boolean> {
    if (this.ttlMs === 0) return false
    const member = this.member(jid)
    if (!member) return false

    if (this.options.useRedis) {
      try {
        const redis = await this.redisFactory(phone)
        const score = await redis.zScore(this.key(phone), member)
        if (score !== null && score > nowMs) return true
        if (score !== null) await redis.zRem(this.key(phone), member)
        return false
      } catch (error) { rethrowSessionStateFence(error) }
    }

    const expiresAt = this.expiresAt.get(`${phone}:${member}`) || 0
    if (expiresAt > nowMs) return true
    this.expiresAt.delete(`${phone}:${member}`)
    return false
  }

  async mark(phone: string, jid: string, nowMs = Date.now()): Promise<void> {
    if (this.ttlMs === 0) return
    const member = this.member(jid)
    if (!member) return
    const expiresAt = nowMs + this.ttlMs
    this.expiresAt.set(`${phone}:${member}`, expiresAt)
    if (!this.options.useRedis) return

    try {
      const redis = await this.redisFactory(phone)
      const key = this.key(phone)
      await redis.zRemRangeByScore(key, 0, nowMs)
      await redis.zAdd(key, [{ score: expiresAt, value: member }])
      await redis.expire(key, Math.ceil(this.ttlMs / 1_000))
    } catch (error) { rethrowSessionStateFence(error) }
  }

  async invalidate(phone: string, jid: string): Promise<void> {
    const member = this.member(jid)
    if (!member) return
    this.expiresAt.delete(`${phone}:${member}`)
    if (!this.options.useRedis) return

    try {
      const redis = await this.redisFactory(phone)
      await redis.zRem(this.key(phone), member)
    } catch (error) { rethrowSessionStateFence(error) }
  }

  private key(phone: string) {
    return `${BASE_KEY}profile-picture-miss:${phone}`
  }

  private member(jid: string) {
    return profilePictureCacheIds(jid)[0]
  }
}
