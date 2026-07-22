import { STATUS_RECIPIENT_RETENTION_SEC } from '../../defaults'
import { BASE_KEY, getRedis } from '../redis'

const normalizeUsername = (value: string) => `${value || ''}`.trim().replace(/^@/, '').toLowerCase()

export class ZapoUsernameIndex {
  private readonly local = new Map<string, { lid: string; seenAt: number }>()
  private readonly reverseLocal = new Map<string, { name: string; seenAt: number }>()

  constructor(private readonly retentionSec = STATUS_RECIPIENT_RETENTION_SEC) {}

  private key(phone: string) {
    return `${BASE_KEY}zapo-username-lid:${phone}`
  }

  private seenKey(phone: string) {
    return `${this.key(phone)}:seen`
  }

  private async ensureTemporalIndex(redis: Awaited<ReturnType<typeof getRedis>>, phone: string, nowMs: number) {
    if (await redis.zCard(this.seenKey(phone))) return
    const names = (await redis.hKeys(this.key(phone))).filter((field) => !field.startsWith('lid:'))
    if (names.length) await redis.zAdd(this.seenKey(phone), names.map((value) => ({ score: nowMs, value })))
  }

  private async prune(phone: string, nowMs: number) {
    const cutoff = nowMs - Math.max(1, this.retentionSec) * 1000
    for (const [key, value] of this.local) {
      if (key.startsWith(`${phone}:`) && value.seenAt < cutoff) this.local.delete(key)
    }
    for (const [key, value] of this.reverseLocal) {
      if (key.startsWith(`${phone}:`) && value.seenAt < cutoff) this.reverseLocal.delete(key)
    }
    const redis = await getRedis()
    await this.ensureTemporalIndex(redis, phone, nowMs)
    const expired = await redis.zRangeByScore(this.seenKey(phone), 0, cutoff)
    for (const name of expired) {
      const lid = `${await redis.hGet(this.key(phone), name) || ''}`
      await redis.hDel(this.key(phone), name)
      if (lid) {
        const reverse = `${await redis.hGet(this.key(phone), `lid:${lid}`) || ''}`
        if (reverse === name) await redis.hDel(this.key(phone), `lid:${lid}`)
      }
    }
    await redis.zRemRangeByScore(this.seenKey(phone), 0, cutoff)
  }

  async touch(phone: string, username: string, lid: string, nowMs = Date.now()): Promise<void> {
    const name = normalizeUsername(username)
    const rawLid = `${lid || ''}`.trim()
    const canonicalLid = rawLid.includes('@lid') ? `${rawLid.split('@')[0].split(':')[0]}@lid` : ''
    if (!name || !canonicalLid.endsWith('@lid')) return
    this.local.set(`${phone}:${name}`, { lid: canonicalLid, seenAt: nowMs })
    this.reverseLocal.set(`${phone}:${canonicalLid}`, { name, seenAt: nowMs })
    try {
      const redis = await getRedis()
      await this.ensureTemporalIndex(redis, phone, nowMs)
      await redis.hSet(this.key(phone), name, canonicalLid)
      await redis.hSet(this.key(phone), `lid:${canonicalLid}`, name)
      await redis.zAdd(this.seenKey(phone), [{ score: nowMs, value: name }])
      await redis.expire(this.key(phone), Math.max(1, this.retentionSec))
      await redis.expire(this.seenKey(phone), Math.max(1, this.retentionSec))
      await this.prune(phone, nowMs)
    } catch {}
  }

  async removeByLid(phone: string, lid: string): Promise<void> {
    const canonicalLid = `${`${lid || ''}`.split('@')[0].split(':')[0]}@lid`
    let name = this.reverseLocal.get(`${phone}:${canonicalLid}`)?.name
    try {
      const redis = await getRedis()
      name = name || `${await redis.hGet(this.key(phone), `lid:${canonicalLid}`) || ''}`
      if (name) await redis.hDel(this.key(phone), name)
      await redis.hDel(this.key(phone), `lid:${canonicalLid}`)
      if (name) await redis.zRem(this.seenKey(phone), name)
    } catch {}
    if (name) this.local.delete(`${phone}:${name}`)
    this.reverseLocal.delete(`${phone}:${canonicalLid}`)
  }

  async resolve(phone: string, username: string, nowMs = Date.now()): Promise<string | undefined> {
    const name = normalizeUsername(username)
    if (!name) return undefined
    const local = this.local.get(`${phone}:${name}`)
    if (local && nowMs - local.seenAt <= Math.max(1, this.retentionSec) * 1000) return local.lid
    if (local) this.local.delete(`${phone}:${name}`)
    try {
      const redis = await getRedis()
      await this.prune(phone, nowMs)
      const lid = `${await redis.hGet(this.key(phone), name) || ''}`
      if (lid.endsWith('@lid')) {
        this.local.set(`${phone}:${name}`, { lid, seenAt: nowMs })
        this.reverseLocal.set(`${phone}:${lid}`, { name, seenAt: nowMs })
        return lid
      }
    } catch {}
    return undefined
  }
}

export const zapoUsernameIndex = new ZapoUsernameIndex()
