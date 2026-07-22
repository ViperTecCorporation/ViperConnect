import { randomUUID } from 'node:crypto'
import { BASE_KEY, getRedis } from './redis'

type RedisClient = Awaited<ReturnType<typeof getRedis>>
type RedisFactory = () => Promise<RedisClient>

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`

export class RedisLease {
  private readonly token = randomUUID()
  private acquired = false

  constructor(
    name: string,
    private readonly ttlMs: number,
    private readonly redisFactory: RedisFactory = getRedis,
  ) {
    this.key = `${BASE_KEY}lease:${name}`
  }

  private readonly key: string

  async acquire() {
    if (this.acquired) return true
    const redis = await this.redisFactory()
    const result = await redis.set(this.key, this.token, { NX: true, PX: Math.max(1000, this.ttlMs) })
    this.acquired = result === 'OK'
    return this.acquired
  }

  async renew() {
    if (!this.acquired) return false
    const redis = await this.redisFactory()
    const result = await redis.eval(RENEW_SCRIPT, {
      keys: [this.key],
      arguments: [this.token, `${Math.max(1000, this.ttlMs)}`],
    })
    this.acquired = Number(result) === 1
    return this.acquired
  }

  async release() {
    if (!this.acquired) return false
    const redis = await this.redisFactory()
    const result = await redis.eval(RELEASE_SCRIPT, {
      keys: [this.key],
      arguments: [this.token],
    })
    this.acquired = false
    return Number(result) === 1
  }
}
