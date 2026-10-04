import { randomUUID } from 'crypto'
import { BASE_KEY, getRedis } from './redis'

const TTL = 86400
/** Privacy is always refreshed; snapshots are only a bounded, per-session fallback. */
export class OwnPrivacyCache {
  constructor(private readonly redis: () => Promise<any> = getRedis) {}
  private key(phone: string) { return `${BASE_KEY}own-privacy:v1:${phone}` }
  async read(phone: string, fetch: () => Promise<any>) {
    let redis: any; let cached: any; let generation = '0'
    try {
      redis = await this.redis()
      cached = JSON.parse(await redis.get(this.key(phone)) || 'null')
      generation = await redis.get(`${this.key(phone)}:generation`) || '0'
    } catch { redis = undefined }
    try {
      const raw = await fetch()
      const warnings: string[] = raw.warnings || []
      const data = { settings: raw.settings, blocked: raw.blocked, duration: raw.duration, exceptions: { ...raw.exceptions }, warnings }
      let fallback = false
      for (const section of ['settings', 'blocked', 'duration']) {
        if (data[section] == null && cached?.data?.[section] != null) { data[section] = cached.data[section]; fallback = true }
      }
      for (const key of Object.keys(data.exceptions)) if (data.exceptions[key] == null && cached?.data?.exceptions?.[key] != null) {
        data.exceptions[key] = cached.data.exceptions[key]; fallback = true
      }
      // Never renew old fallback data indefinitely or label it as newly observed.
      const updated_at = fallback ? cached.updated_at : new Date().toISOString()
      if (redis && !fallback && !warnings.length) {
        try { await redis.eval("if (redis.call('GET', KEYS[2]) or '0') == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return nil", {
          keys: [this.key(phone), `${this.key(phone)}:generation`], arguments: [generation, JSON.stringify({ data, updated_at }), String(TTL)],
        }) } catch { /* Successful upstream reads must survive Redis outages. */ }
      }
      return { ...data, cache: { source: fallback ? 'mixed' : 'live', updated_at, stale: fallback || warnings.length > 0, refresh_failed: warnings.length > 0 } }
    } catch (error) {
      const code = Number((error as any)?.code) || Number(String((error as any)?.message).match(/^(\d{3}):/)?.[1])
      if ([400, 401, 403].includes(code) || !cached?.data) throw error
      return { ...cached.data, cache: { source: 'cache', updated_at: cached.updated_at, stale: true, refresh_failed: true } }
    }
  }
  async invalidate(phone: string) {
    try {
      const redis = await this.redis()
      await redis.eval("redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return redis.call('DEL', KEYS[1])", {
        keys: [this.key(phone), `${this.key(phone)}:generation`], arguments: [randomUUID(), String(TTL * 2)],
      })
    } catch { /* A confirmed write must not be reported as failed because Redis failed. */ }
  }
}
