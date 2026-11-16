import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VoipService } from './voip_service'
import { getRedis } from './redis'
import { RedisLease } from './redis_lease'
import { STORAGE_OPTIONS } from '../defaults'
import { createBackupObjects } from './session_storage/backup_objects'
import { publishBackupManifest, pruneBackupSlots } from './session_storage/backup_policy'
import { WeeklyBackupSlots, validateWeeklyManifest, type VoipBackupManifest } from './session_storage/backup_slots'
import { SessionStorageError } from './session_storage/types'
import logger from './logger'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const MAX_BYTES = 256 * 1024 * 1024
const instance = () => { const id = process.env.VOIP_BACKUP_INSTANCE_ID || 'voip-main'; if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) throw new SessionStorageError(400, 'voip_backup_instance_invalid'); return id }
const manifestKey = (id: string) => `unoapi-infrastructure:voip-backup:manifest:${id}`
const stateKey = (id: string) => `unoapi-infrastructure:voip-backup:state:${id}`
const digest = () => {
  const hash = createHash('sha256'); let bytes = 0
  return { stream: new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > MAX_BYTES) return callback(new Error('voip_backup_too_large')); hash.update(chunk); callback(null, chunk) } }),
    result: () => ({ bytes, sha256: hash.digest('hex') }) }
}

export class VoipBackups {
  constructor(private readonly service = new VoipService(undefined, undefined, 120000), private readonly deps: any = {}) {}
  private async redis() { return this.deps.redis || getRedis() }
  private objects() { return this.deps.objects || createBackupObjects() }
  private async exclusive<T>(run: (guard: () => Promise<void>) => Promise<T>): Promise<T> {
    const lease = this.deps.lease || new RedisLease(`voip-backup:${instance()}`, 180000)
    if (!await lease.acquire()) throw new SessionStorageError(409, 'voip_backup_busy')
    let lost = false
    const timer = setInterval(() => { void lease.renew().then((ok: boolean) => { if (!ok) lost = true }, () => { lost = true }) }, 15000); timer.unref?.()
    const guard = async () => { if (lost || !await lease.renew()) throw new SessionStorageError(409, 'voip_backup_lease_lost') }
    try { const result = await run(guard); await guard(); return result }
    finally { clearInterval(timer); await lease.release().catch(() => {}) }
  }
  async status() {
    const id = instance(), prefix = `backups/voip/${id}/`, redis = await this.redis(); let state = JSON.parse(await redis.get(stateKey(id)) || 'null')
    if (!this.service.available()) return { enabled: false, reason: 'voip_service_not_configured', instanceId: id }
    if (!STORAGE_OPTIONS(undefined).bucket) return { enabled: false, reason: 'voip_backup_s3_not_configured', instanceId: id }
    let capability: any
    try { capability = await this.service.request('/v1/console/backups/capability') }
    catch (error: any) { return { enabled: false, reason: error?.status === 404 ? 'voip_backup_service_upgrade_required' : 'voip_backup_service_unavailable', instanceId: id, state } }
    if (['restoring', 'restore_unconfirmed'].includes(state?.phase) && capability.lastRestore?.operationId === state.operationId) {
      state = { ...state, phase: 'restored', updatedAt: Date.now() }; await redis.set(stateKey(id), JSON.stringify(state))
    }
    const objects = this.objects(), slots = new WeeklyBackupSlots({ kind: 'voip', id }, objects, redis, { timeZone: process.env.SESSION_STORAGE_BACKUP_TIMEZONE || 'UTC' })
    const files: Array<VoipBackupManifest & { day: number }> = []
    for (let day = 0; day < 7; day++) { const pointer = await slots.slot(day); if (pointer) files.push({ day, ...pointer.manifest as VoipBackupManifest }) }
    return { enabled: !!capability.available, capability, instanceId: id, bucket: STORAGE_OPTIONS(undefined).bucket, prefix, slotsPrefix: prefix + 'slots/',
      automatic: process.env.VOIP_BACKUP_ENABLED !== 'false', intervalHours: 12, recordingsIncluded: false, files, state }
  }
  private async backupUnlocked(guard: () => Promise<void>): Promise<VoipBackupManifest> {
    if (!this.service.available() || !STORAGE_OPTIONS(undefined).bucket) throw new SessionStorageError(409, 'voip_backup_not_configured')
    const capability: any = await this.service.request('/v1/console/backups/capability')
    if (!capability.available) throw new SessionStorageError(409, 'voip_backup_requires_sqlite')
    const redis = await this.redis(), objects = this.objects(), id = randomUUID(), instanceId = instance(), objectKey = `backups/voip/${instanceId}/${id}.vipervoip`
    const directory = await mkdtemp(join(tmpdir(), 'viper-voip-s3-')), path = join(directory, 'archive.vipervoip')
    try {
      const response = await this.service.stream('/v1/console/backups/archive'), measured = digest()
      if (!response.body) throw new SessionStorageError(503, 'voip_backup_empty')
      await pipeline(Readable.fromWeb(response.body as any), measured.stream, createWriteStream(path, { mode: 0o600, flags: 'wx' }))
      const { bytes, sha256 } = measured.result(); if (!bytes) throw new SessionStorageError(503, 'voip_backup_empty')
      await objects.save(objectKey, createReadStream(path))
      const verify = createHash('sha256'); let verifiedBytes = 0
      for await (const part of await objects.open(objectKey)) { verifiedBytes += part.length; if (verifiedBytes > MAX_BYTES) throw new SessionStorageError(503, 'voip_backup_verification_failed'); verify.update(part) }
      if (verifiedBytes !== bytes || verify.digest('hex') !== sha256) throw new SessionStorageError(503, 'voip_backup_verification_failed')
      await guard()
      const manifest: VoipBackupManifest = { id, version: 1, kind: 'voip', status: 'ready', instanceId, createdAt: new Date().toISOString(), objectKey, bytes, sha256, protection: 'none', uploadVerified: true, recordingsIncluded: false }
      // VoIP always uses seven weekday slots, even if session retention is not configured yet.
      await publishBackupManifest({ kind: 'voip', id: instanceId }, manifest, objects, redis, { ...process.env, SESSION_STORAGE_BACKUP_ROTATION: 'weekly' })
      await redis.set(manifestKey(id), JSON.stringify(manifest))
      const previous = JSON.parse(await redis.get(stateKey(instanceId)) || 'null')
      await redis.set(stateKey(instanceId), JSON.stringify(['restoring', 'restore_unconfirmed'].includes(previous?.phase)
        ? { ...previous, lastBackup: manifest } : { phase: 'ready', lastBackup: manifest, updatedAt: Date.now() }))
      return manifest
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  async backup() { return this.exclusive(guard => this.backupUnlocked(guard)) }
  private async manifest(id: string): Promise<VoipBackupManifest> {
    if (!uuid.test(id)) throw new SessionStorageError(400, 'voip_backup_id_invalid')
    const value = await this.objects().json(`backups/voip/${instance()}/${id}.vipervoip.manifest.json`)
    if (!value) throw new SessionStorageError(404, 'voip_backup_not_found')
    validateWeeklyManifest(value.value, { kind: 'voip', id: instance() }); return value.value as VoipBackupManifest
  }
  async download(id: string) { const manifest = await this.manifest(id); return { manifest, stream: await this.objects().open(manifest.objectKey) } }
  async restore(id: string | undefined, upload?: AsyncIterable<Buffer>) {
    return this.exclusive(async guard => {
      const redis = await this.redis(), instanceId = instance(), operationId = randomUUID(), directory = await mkdtemp(join(tmpdir(), 'viper-voip-restore-upload-')), path = join(directory, 'restore.vipervoip')
      try {
        const status = await this.status()
        if (!status.enabled || status.capability?.restoring || ['restoring', 'restore_unconfirmed'].includes(status.state?.phase)) throw new SessionStorageError(409, 'voip_restore_pending_confirmation')
        const source = id ? await this.download(id) : undefined
        if (!source && !upload) throw new SessionStorageError(400, 'voip_backup_file_required')
        const check = digest()
        await pipeline(source?.stream || Readable.from(upload!), check.stream, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
        const actual = check.result()
        if (!actual.bytes || source && (actual.sha256 !== source.manifest.sha256 || actual.bytes !== source.manifest.bytes)) throw new SessionStorageError(409, 'voip_backup_verification_failed')
        const before = await this.backupUnlocked(guard)
        await guard()
        await redis.set(stateKey(instanceId), JSON.stringify({ phase: 'restoring', operationId, beforeBackupId: before.id, updatedAt: Date.now() }))
        try {
          const result = await this.service.request('/v1/console/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Voip-Restore-Confirm': 'true', 'X-Voip-Restore-Operation': operationId }, body: createReadStream(path) as any, duplex: 'half' } as any)
          if ((result as any)?.restored !== true) throw new SessionStorageError(503, 'voip_restore_unconfirmed')
          await redis.set(stateKey(instanceId), JSON.stringify({ phase: 'restored', operationId, beforeBackupId: before.id, updatedAt: Date.now() }))
          return { ...result as any, beforeBackupId: before.id }
        } catch (error) {
          const status = Number((error as any)?.status)
          await redis.set(stateKey(instanceId), JSON.stringify({ phase: [400,403,409,413].includes(status) ? 'restore_rejected' : 'restore_unconfirmed', operationId, beforeBackupId: before.id, updatedAt: Date.now() }))
          throw error
        }
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  }
  async scheduled() {
    if (process.env.VOIP_BACKUP_ENABLED === 'false' || !this.service.available() || !STORAGE_OPTIONS(undefined).bucket) return
    const redis = await this.redis(), key = `unoapi-infrastructure:voip-backup:window:${instance()}:${Math.floor(Date.now() / 43200000)}`
    if (await redis.set(key, 'running', { NX: true, EX: 43200 }) !== 'OK') return
    try {
      await this.backup()
      await redis.set(key, 'ready', { EX: 86400 })
      await pruneBackupSlots({ kind: 'voip', id: instance() }, this.objects(), redis, { ...process.env, SESSION_STORAGE_BACKUP_ROTATION: 'weekly' })
    } catch { await redis.del(key); throw new SessionStorageError(503, 'voip_backup_scheduled_failed') }
  }
}
export const voipBackups = new VoipBackups()
let backupTimer: NodeJS.Timeout | undefined, running = false
export function startVoipBackupScheduler() {
  if (backupTimer || process.env.VOIP_BACKUP_ENABLED === 'false') return
  const tick = () => {
    if (running) return
    running = true
    void voipBackups.scheduled().catch(() => logger.warn({ code: 'voip_backup_scheduled_failed' }, 'VoIP S3 backup deferred'))
      .finally(() => { running = false })
  }
  backupTimer = setInterval(tick, 60000); backupTimer.unref?.(); tick()
}
