import { CONTACT_SYNC_SCAN_COUNT, ZAPO_REDIS_KEY_PREFIX, ZAPO_REDIS_MESSAGES_TTL_MS } from '../../defaults'
import { getRedis } from '../redis'

type RedisClient = Awaited<ReturnType<typeof getRedis>>
type RedisFactory = () => Promise<RedisClient>

export class ZapoRedisMaintenance {
  private readonly cursors = new Map<string, string>()

  constructor(
    private readonly redisFactory: RedisFactory = getRedis,
    private readonly prefix = ZAPO_REDIS_KEY_PREFIX,
    private readonly retentionMs = ZAPO_REDIS_MESSAGES_TTL_MS,
  ) {}

  async pruneMessageIndexBatch(sessionId: string, nowMs = Date.now()) {
    if (this.retentionMs <= 0) return { scanned: 0, removed: 0, cursor: '0' }
    const redis = await this.redisFactory()
    const cursor = this.cursors.get(sessionId) || '0'
    const result = await redis.scan(cursor, {
      MATCH: `${this.prefix}msg:idx:${sessionId}:*`,
      COUNT: Math.max(10, CONTACT_SYNC_SCAN_COUNT || 500),
    })
    const cutoff = nowMs - this.retentionMs
    let removed = 0
    for (const key of result.keys || []) {
      removed += Number(await redis.zRemRangeByScore(key, 0, cutoff)) || 0
    }
    const nextCursor = `${result.cursor}`
    this.cursors.set(sessionId, nextCursor)
    return { scanned: (result.keys || []).length, removed, cursor: nextCursor }
  }
}

export const zapoRedisMaintenance = new ZapoRedisMaintenance()
