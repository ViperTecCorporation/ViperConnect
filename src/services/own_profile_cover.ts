import { randomUUID } from 'crypto'
import type { MediaStore } from './media_store'
import { BASE_KEY, getRedis } from './redis'
import { SendError } from './send_error'

/** Permanent local record, independent of the 24h profile snapshot. */
export class OwnProfileCover {
  constructor(private readonly phone: string, private readonly media: MediaStore, private readonly redis: () => Promise<any> = getRedis) {}
  private key() { return `${BASE_KEY}own-profile-cover:v1:${this.phone}` }
  private prefix() { return `${this.phone}/own-profile-cover/` }
  private async locked<T>(fn: (redis: any, token: string) => Promise<T>): Promise<T> {
    const redis = await this.redis(); const token = randomUUID(); const key = `${this.key()}:lock`
    if (!await redis.set(key, token, { NX: true, EX: 300 })) throw new SendError(409, 'profile_cover_busy')
    try { return await fn(redis, token) }
    finally { await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: [key], arguments: [token] }).catch(() => undefined) }
  }

  async preview() {
    const raw = await (await this.redis()).get(this.key())
    if (!raw) return null
    const record = JSON.parse(raw)
    if (!record.id || typeof record.object_key !== 'string' || !record.object_key.startsWith(this.prefix())) return null
    return { id: record.id, url: await this.media.getFileUrl(record.object_key, 900), updated_at: record.updated_at, source: 'uno_upload' }
  }

  async upload(image: Buffer, send: () => Promise<{ id: string }>) {
    if (this.media.type !== 's3') throw new SendError(409, 'profile_cover_requires_s3')
    return this.locked(async (redis, token) => {
    const previous = await redis.get(this.key())
    const object_key = `${this.prefix()}${randomUUID()}.jpeg`
    if (!await this.media.saveMediaBuffer(object_key, image, 'image/jpeg', false)) throw new SendError(502, 'profile_cover_storage_failed')
    let id: string
    try { id = (await send()).id }
    catch (error) {
      // The object is merely a local preview, not the copy hosted by WhatsApp.
      await this.media.removeMedia(object_key).catch(() => undefined)
      throw error
    }
    try {
      const saved = await redis.eval("if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 1 end return 0", {
        keys: [this.key(), `${this.key()}:lock`], arguments: [token, JSON.stringify({ id, object_key, updated_at: new Date().toISOString() })],
      })
      if (!saved) throw new Error('cover_lock_lost')
    } catch {
      // The remote mutation succeeded. Never claim failure and invite duplicate uploads.
      return { success: true, id, warning: 'profile_cover_metadata_not_saved' }
    }
    if (previous) {
      try { const old = JSON.parse(previous); if (typeof old.object_key === 'string' && old.object_key.startsWith(this.prefix()) && old.object_key !== object_key) await this.media.removeMedia(old.object_key) }
      catch { return { success: true, id, warning: 'profile_cover_cleanup_failed' } }
    }
    return { success: true, id }
    })
  }

  async remove(id: string, send: () => Promise<void>) {
    return this.locked(async redis => {
    const raw = await redis.get(this.key())
    await send()
    if (raw) {
      try {
        const record = JSON.parse(raw)
        if (record.id === id) {
          const removed = await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: [this.key()], arguments: [raw] })
          if (removed && typeof record.object_key === 'string' && record.object_key.startsWith(this.prefix())) await this.media.removeMedia(record.object_key)
        }
      } catch { return { success: true, warning: 'profile_cover_cleanup_failed' } }
    }
    return { success: true }
    })
  }
}
