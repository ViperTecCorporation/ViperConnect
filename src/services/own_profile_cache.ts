import { randomUUID } from 'crypto'
import { BASE_KEY, getRedis } from './redis'

const TTL = 86400
const safeProfile = (profile: any) => {
  const result: any = {}
  for (const key of ['name', 'about', 'username', 'verified_name', 'business_account', 'mobile_primary', 'warnings', 'unsupported']) {
    if (profile[key] !== undefined) result[key] = profile[key]
  }
  result.picture = profile.picture ? { url: profile.picture.url, id: profile.picture.id } : null
  result.business = null
  if (profile.business) {
    result.business = {}
    for (const key of ['jid', 'description', 'address', 'email', 'latitude', 'longitude', 'websites', 'categories', 'businessHours']) {
      if (profile.business[key] !== undefined) result.business[key] = profile.business[key]
    }
  }
  return result
}

/** Snapshot cache only; the owning worker remains the source of truth. */
export class OwnProfileCache {
  private readonly pending = new Map<string, Promise<any>>()
  constructor(private readonly redis: () => Promise<any> = getRedis) {}
  private key(phone: string) { return `${BASE_KEY}own-profile:v1:${phone}` }

  async read(phone: string, refresh: boolean, fetch: () => Promise<any>): Promise<any> {
    let redis: any; let cached: any; let generation = '0'
    try {
      redis = await this.redis()
      const raw = await redis.get(this.key(phone))
      if (raw) cached = JSON.parse(raw)
      generation = await redis.get(`${this.key(phone)}:generation`) || '0'
    } catch { redis = undefined }
    if (!refresh && cached?.profile) return this.response(cached, 'cache', true)
    const pendingKey = `${phone}:${generation}`
    const running = this.pending.get(pendingKey)
    if (running) return running
    const work = (async () => {
      try {
        const profile = safeProfile(await fetch())
        const warnings: string[] = profile.warnings || []
        if (cached?.profile) {
          for (const section of warnings) {
            if (['about', 'picture', 'username', 'verified_name'].includes(section)) profile[section] = cached.profile[section]
            if (section === 'business') { profile.business = cached.profile.business; profile.business_account = cached.profile.business_account }
          }
        }
        const snapshot = { profile, updated_at: new Date().toISOString() }
        if (redis) {
          try {
            await redis.eval("if (redis.call('GET', KEYS[2]) or '0') == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return nil", {
              keys: [this.key(phone), `${this.key(phone)}:generation`], arguments: [generation, JSON.stringify(snapshot), String(TTL)],
            })
          } catch { /* Redis failure must not turn a successful WhatsApp read into an error. */ }
        }
        return this.response(snapshot, 'live', warnings.length > 0)
      } catch (error) {
        if (cached?.profile) return { ...this.response(cached, 'cache', true), cache: { ...this.response(cached, 'cache', true).cache, refresh_failed: true } }
        throw error
      }
    })()
    this.pending.set(pendingKey, work)
    try { return await work } finally { if (this.pending.get(pendingKey) === work) this.pending.delete(pendingKey) }
  }

  async invalidate(phone: string): Promise<void> {
    try {
      const redis = await this.redis()
      // Keep the last snapshot as stale fallback if the post-write read fails.
      await redis.eval("redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return 1", {
        keys: [this.key(phone), `${this.key(phone)}:generation`], arguments: [randomUUID(), String(TTL * 2)],
      })
    } catch { /* Post-save UI explicitly refreshes; never report a confirmed write as failed. */ }
  }

  private response(snapshot: any, source: string, stale: boolean) {
    return { ...snapshot.profile, cache: { source, updated_at: snapshot.updated_at, stale } }
  }
}
