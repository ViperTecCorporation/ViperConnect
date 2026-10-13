import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { MobileDeviceError } from '../mobile_device_service'
import { validateBackupPassword } from '../mobile_primary/backup_archive'
import type { MediaStore } from '../media_store'

export const RESTORE_PART_BYTES = 8 * 1024 * 1024
const RETENTION = 86400
const PREFIX = 'session-transfer:{v1}:upload:'
interface RedisMetadata {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export interface RestoreUpload {
  id: string; owner: string; size: number; parts: number; received: number; expiresAt: number
  state: 'uploading' | 'restoring' | 'ready' | 'failed'; result?: unknown; error?: string
}
interface Dependencies {
  redis: RedisMetadata; storage(): Promise<MediaStore>
  scheduleRemoval(key: string): Promise<void>
  restore(source: AsyncIterable<Buffer | string>): Promise<unknown>
}
const fail = (code: string, status = 409): never => { throw new MobileDeviceError(status, code) }

/** Encrypted bytes stay in shared media storage; Redis contains receipts and task state only. */
export class MultipartSessionRestore {
  constructor(private readonly deps: Dependencies) {}
  private key(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail('session_upload_invalid', 400)
    return PREFIX + id
  }
  private object(id: string, index: number) { return `session-restore-uploads/${id}/${index}.part` }
  private async load(owner: string, id: string): Promise<RestoreUpload> {
    const raw = await this.deps.redis.get(this.key(id))
    if (!raw) return fail('session_upload_expired', 410)
    const value: RestoreUpload = JSON.parse(raw)
    if (value.owner !== owner) return fail('session_upload_not_found', 404)
    if (value.expiresAt <= Date.now()) return fail('session_upload_expired', 410)
    return value
  }
  private async locked<T>(id: string, action: (token: string, assert: () => Promise<void>) => Promise<T>): Promise<T> {
    const key = this.key(id) + ':lock', token = randomUUID()
    if (!Number(await this.deps.redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',120000); return 1", { keys: [key], arguments: [token] }))) return fail('session_upload_busy')
    let lost = false
    const assert = async () => {
      if (lost || !Number(await this.deps.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],120000); return 1", { keys: [key], arguments: [token] }))) { lost = true; fail('session_upload_lease_lost') }
    }
    const timer = setInterval(() => { void assert().catch(() => { lost = true }) }, 30000)
    timer.unref()
    try { return await action(token, assert) } finally {
      clearInterval(timer)
      await this.deps.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [key], arguments: [token] })
    }
  }
  private async save(value: RestoreUpload, token: string) {
    if (!Number(await this.deps.redis.eval("if redis.call('GET',KEYS[2])~=ARGV[1] or redis.call('EXISTS',KEYS[1])~=1 then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1", {
      keys: [this.key(value.id), this.key(value.id) + ':lock'], arguments: [token, JSON.stringify(value), String(Math.max(1, value.expiresAt - Date.now()))],
    }))) fail('session_upload_lease_lost')
  }
  async start(owner: string, body: any) {
    if (!owner || !body || Object.keys(body).join(',') !== 'size' || !Number.isSafeInteger(body.size) || body.size < 1) return fail('session_upload_invalid', 400)
    const value: RestoreUpload = { id: randomUUID(), owner, size: body.size, parts: Math.ceil(body.size / RESTORE_PART_BYTES), received: 0, state: 'uploading', expiresAt: Date.now() + RETENTION * 1000 }
    await this.deps.storage() // Fail before accepting bytes if storage cannot be configured.
    await this.deps.redis.eval("redis.call('SET',KEYS[1],ARGV[1],'EX',86400); return 1", { keys: [this.key(value.id)], arguments: [JSON.stringify(value)] })
    return { id: value.id, partSize: RESTORE_PART_BYTES, parts: value.parts, expiresAt: value.expiresAt }
  }
  async status(owner: string, id: string) {
    const value = await this.load(owner, id)
    const state = value.state === 'restoring' && !await this.deps.redis.get(this.key(id) + ':lock') ? 'interrupted' : value.state
    return { id, state, received: value.received, parts: value.parts, expiresAt: value.expiresAt, result: value.result, error: state === 'interrupted' ? 'session_restore_interrupted' : value.error }
  }
  async part(owner: string, id: string, index: number, sha256: string, source: AsyncIterable<Buffer | string>) {
    await this.load(owner, id)
    if (!Number.isSafeInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(sha256)) return fail('session_upload_part_invalid', 400)
    return this.locked(id, async (token, assert) => {
      const value = await this.load(owner, id)
      if (value.state !== 'uploading' || index >= value.parts || index > value.received) return fail('session_upload_part_order')
      const expected = index === value.parts - 1 ? value.size - index * RESTORE_PART_BYTES : RESTORE_PART_BYTES
      const buffer = Buffer.allocUnsafe(expected), hash = createHash('sha256'); let size = 0
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (size + bytes.length > expected) return fail('session_upload_part_too_large', 413)
        bytes.copy(buffer, size); size += bytes.length; hash.update(bytes)
      }
      if (size !== expected || hash.digest('hex') !== sha256) return fail('session_upload_part_checksum', 400)
      const receipt = this.key(id) + `:part:${index}`
      if (index < value.received) {
        if (await this.deps.redis.get(receipt) !== sha256) return fail('session_upload_part_conflict')
        return { received: value.received, parts: value.parts }
      }
      await assert()
      const storage = await this.deps.storage(), key = this.object(id, index)
      // Schedule even before the write: an interrupted process must not orphan an object.
      await this.deps.scheduleRemoval(key)
      const upload = Readable.from([buffer])
      try { if (!await storage.saveMediaStream(key, upload, 'application/octet-stream', false, 0)) return fail('session_upload_storage_failed', 503) } finally { upload.destroy() }
      await assert()
      value.received++
      if (!Number(await this.deps.redis.eval("if redis.call('GET',KEYS[2])~=ARGV[1] or redis.call('EXISTS',KEYS[1])~=1 then return 0 end; redis.call('SET',KEYS[3],ARGV[3],'PX',ARGV[4]); redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[4]); return 1", {
        keys: [this.key(id), this.key(id) + ':lock', receipt], arguments: [token, JSON.stringify(value), sha256, String(Math.max(1, value.expiresAt - Date.now()))],
      }))) fail('session_upload_lease_lost')
      return { received: value.received, parts: value.parts }
    })
  }
  async complete(owner: string, id: string, body: any) {
    validateBackupPassword(body?.password)
    if (!body || body.confirmOriginOffline !== true || Object.keys(body).sort().join(',') !== 'confirmOriginOffline,password') return fail('mobile_restore_confirmation_required', 400)
    await this.load(owner, id)
    let launch = false
    await this.locked(id, async token => {
      const value = await this.load(owner, id)
      if (value.state !== 'uploading') return
      if (value.received !== value.parts) return fail('session_upload_incomplete')
      value.state = 'restoring'; await this.save(value, token); launch = true
    })
    if (launch) void this.execute(owner, id, body).catch(() => { /* A lost process/lease is exposed as interrupted; never reimport automatically. */ })
    return { id, state: 'restoring' }
  }
  private async execute(owner: string, id: string, body: any) {
    await this.locked(id, async (token, assert) => {
      const value = await this.load(owner, id), storage = await this.deps.storage()
      try {
        const archive = async function* (self: MultipartSessionRestore) {
          yield Buffer.from(JSON.stringify(body) + '\n')
          for (let index = 0; index < value.parts; index++) {
            await assert()
            const expected = index === value.parts - 1 ? value.size - index * RESTORE_PART_BYTES : RESTORE_PART_BYTES
            const source = await storage.downloadMediaStream(self.object(id, index))
            if (!source) return fail('session_upload_storage_failed', 503)
            const hash = createHash('sha256'); let size = 0
            // Verify stored bytes before passing the part into the authenticated importer.
            const buffer = Buffer.allocUnsafe(expected)
            try { for await (const bytes of source) { if (size + bytes.length > expected) fail('session_upload_part_checksum', 400); bytes.copy(buffer, size); size += bytes.length; hash.update(bytes) } } finally { source.destroy() }
            if (size !== expected || hash.digest('hex') !== await self.deps.redis.get(self.key(id) + `:part:${index}`)) return fail('session_upload_part_checksum', 400)
            yield buffer
          }
        }
        value.result = await this.deps.restore(archive(this)); value.state = 'ready'
      } catch (error) {
        value.state = 'failed'; value.error = error instanceof MobileDeviceError ? error.code : 'session_restore_failed'
      }
      await assert(); await this.save(value, token)
      await this.cleanup(value, storage)
    })
  }
  private async cleanup(value: RestoreUpload, storage: MediaStore) {
    for (let index = 0; index < value.received; index++) {
      await storage.removeMedia(this.object(value.id, index)).catch(() => {})
      await this.deps.redis.eval("return redis.call('DEL',KEYS[1])", { keys: [this.key(value.id) + `:part:${index}`], arguments: [] })
    }
  }
  async cancel(owner: string, id: string) {
    await this.load(owner, id)
    return this.locked(id, async token => {
      const value = await this.load(owner, id)
      if (value.state === 'restoring') return fail('session_upload_busy')
      value.state = 'failed'; value.error = 'session_upload_cancelled'; await this.save(value, token)
      await this.cleanup(value, await this.deps.storage())
      return { cancelled: true }
    })
  }
}
