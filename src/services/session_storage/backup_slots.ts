import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { BackupObjects } from './backup_objects'
import type { SqliteBackupManifest } from './backup'
import type { RedisBackupManifest } from './redis_backup'
import { SessionStorageError, type SessionStorageRedis, validateSessionPhone } from './types'

export interface VoipBackupManifest {
  id: string; version: 1; status: 'ready'; instanceId: string; kind: 'voip'; createdAt: string; objectKey: string; bytes: number; sha256: string;
  protection: 'none'; uploadVerified: true; recordingsIncluded: false
}
export type WeeklyManifest = SqliteBackupManifest | RedisBackupManifest | VoipBackupManifest
type Scope = { kind: 'session-storage' | 'redis' | 'voip'; id: string }
type Pointer = { version: 1; day: number; timeZone: string; manifest: WeeklyManifest }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const GRACE_MS = 15 * 60000

export function backupWeekday(at: number | string, timeZone: string): number {
  try {
    const stamp = typeof at === 'number' ? at : Date.parse(at)
    if (!Number.isFinite(stamp)) throw 0
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(new Date(stamp))
    const result = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day)
    if (result < 0) throw 0
    return result
  } catch { throw new SessionStorageError(409, 'session_storage_backup_timezone_invalid') }
}

export function validateWeeklyManifest(value: any, scope: Scope): asserts value is WeeklyManifest {
  if (scope.kind === 'session-storage') validateSessionPhone(scope.id)
  else if (!/^[A-Za-z0-9_.-]{1,100}$/.test(scope.id)) throw new SessionStorageError(400, 'redis_backup_instance_invalid')
  const extension = scope.kind === 'session-storage' ? 'viperstorage' : scope.kind === 'voip' ? 'vipervoip' : 'rdb.viperbackup'
  if (!value || !uuid.test(value.id) || value.version !== 1 || value.status !== 'ready' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !Number.isFinite(Date.parse(value.createdAt))
    || value.objectKey !== `backups/${scope.kind}/${scope.id}/${value.id}.${extension}` || value.protection !== undefined && !['none', 'aes-256-gcm'].includes(value.protection)
    || (scope.kind === 'session-storage' ? value.phone !== scope.id || !uuid.test(value.storageId || '') || !Number.isSafeInteger(value.generation) || value.generation < 1 || !['linked-session', 'mobile-primary'].includes(value.kind) : value.instanceId !== scope.id || value.uploadVerified !== true)) {
    throw new SessionStorageError(409, 'session_storage_backup_manifest_invalid')
  }
  if (scope.kind === 'voip' && (value.kind !== 'voip' || value.protection !== 'none' || value.recordingsIncluded !== false)) throw new SessionStorageError(409, 'session_storage_backup_manifest_invalid')
}

/** Seven verified S3 pointers. Immutable archives are replaced only after the new copy is readable. */
export class WeeklyBackupSlots {
  readonly prefix: string
  private readonly lock: string
  constructor(readonly scope: Scope, readonly objects: BackupObjects, readonly redis: SessionStorageRedis, readonly options: {
    timeZone: string; legacy?(): Promise<WeeklyManifest[]>; forget?(manifest: WeeklyManifest): Promise<void>; busy?(): Promise<boolean>; now?(): number
  }) {
    backupWeekday(Date.now(), options.timeZone)
    if (scope.kind === 'session-storage') validateSessionPhone(scope.id)
    else if (!/^[A-Za-z0-9_.-]{1,100}$/.test(scope.id)) throw new SessionStorageError(400, 'redis_backup_instance_invalid')
    this.prefix = `backups/${scope.kind}/${scope.id}/`
    this.lock = `unoapi-backup-rotation:${scope.kind}:${scope.id}`
  }
  private async exclusive<T>(run: (owned: () => Promise<void>) => Promise<T>, protectOperations = false): Promise<T> {
    const token = randomUUID(), keys = [this.lock, ...(protectOperations && this.scope.kind === 'session-storage' ? [`unoapi-session-storage:task:lock:${this.scope.id}`] : [])]
    if (Number(await this.redis.eval("for _,key in ipairs(KEYS) do if redis.call('EXISTS',key)==1 then return 0 end end for _,key in ipairs(KEYS) do redis.call('SET',key,ARGV[1],'PX',120000) end return 1", { keys, arguments: [token] })) !== 1) throw new SessionStorageError(409, 'session_storage_backup_rotation_busy')
    let lost = false
    const owned = async () => {
      if (lost || Number(await this.redis.eval("for _,key in ipairs(KEYS) do if redis.call('GET',key)~=ARGV[1] then return 0 end end for _,key in ipairs(KEYS) do redis.call('PEXPIRE',key,120000) end return 1", { keys, arguments: [token] })) !== 1) throw new SessionStorageError(409, 'session_storage_backup_rotation_lease_lost')
    }
    const heartbeat = setInterval(() => { void owned().catch(() => { lost = true }) }, 30000); heartbeat.unref?.()
    try { return await run(owned) } finally { clearInterval(heartbeat); await this.redis.eval("local n=0; for _,key in ipairs(KEYS) do if redis.call('GET',key)==ARGV[1] then n=n+redis.call('DEL',key) end end return n", { keys, arguments: [token] }).catch(() => {}) }
  }
  async slot(day: number): Promise<Pointer | undefined> {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new SessionStorageError(400, 'session_storage_backup_slot_invalid')
    const result = await this.objects.json(`${this.prefix}slots/${day}.json`)
    if (!result) return undefined
    const value = result.value as Pointer
    validateWeeklyManifest(value?.manifest, this.scope)
    if (value.version !== 1 || value.day !== day || backupWeekday(value.manifest.createdAt, value.timeZone) !== day) throw new SessionStorageError(409, 'session_storage_backup_pointer_invalid')
    return value
  }
  async publish(manifest: WeeklyManifest) {
    validateWeeklyManifest(manifest, this.scope)
    return this.exclusive(async owned => {
      const sidecar = manifest.objectKey + '.manifest.json', oldSidecar = await this.objects.json(sidecar)
      if (oldSidecar && !isDeepStrictEqual(oldSidecar.value, manifest)) throw new SessionStorageError(409, 'session_storage_backup_manifest_invalid')
      await owned()
      if (!oldSidecar && !await this.objects.putJson(sidecar, manifest, null)) throw new SessionStorageError(409, 'session_storage_backup_rotation_changed')
      const verifiedSidecar = await this.objects.json(sidecar)
      if (!verifiedSidecar || !isDeepStrictEqual(verifiedSidecar.value, manifest)) throw new SessionStorageError(409, 'session_storage_backup_pointer_verification_failed')
      const day = backupWeekday(manifest.createdAt, this.options.timeZone), key = `${this.prefix}slots/${day}.json`
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = await this.objects.json(key)
        if (previous) {
          const pointer = previous.value as Pointer; validateWeeklyManifest(pointer?.manifest, this.scope)
          if (Date.parse(pointer.manifest.createdAt) > Date.parse(manifest.createdAt)) return { published: false, day }
        }
        await owned()
        const pointer: Pointer = { version: 1, day, timeZone: this.options.timeZone, manifest }
        if (!await this.objects.putJson(key, pointer, previous?.etag || null)) continue
        const verified = await this.objects.json(key)
        if (!verified || !isDeepStrictEqual(verified.value, pointer)) throw new SessionStorageError(409, 'session_storage_backup_pointer_verification_failed')
        await owned()
        return { published: true, day }
      }
      throw new SessionStorageError(409, 'session_storage_backup_rotation_changed')
    })
  }
  async prune() {
    if (await this.options.busy?.()) return { deleted: 0, deferred: true }
    return this.exclusive(async owned => {
      const keep = new Set<string>(), days = new Map<number, WeeklyManifest>(), candidates = new Map<string, { manifest: WeeklyManifest; modifiedAt: number }>()
      for (let day = 0; day < 7; day++) { const pointer = await this.slot(day); if (pointer) { keep.add(pointer.manifest.id); days.set(day, pointer.manifest) } }
      // No canonical pointer means no authorization to retire existing backups.
      if (!keep.size) return { deleted: 0, deferred: true }
      let scanned = 0
      for await (const key of this.objects.keys(this.prefix)) {
        if (++scanned > 2000) throw new SessionStorageError(409, 'session_storage_backup_rotation_scan_limit')
        if (!key.endsWith('.manifest.json')) continue
        const record = await this.objects.json(key); if (!record) continue
        validateWeeklyManifest(record.value, this.scope)
        candidates.set(record.value.id, { manifest: record.value, modifiedAt: record.modifiedAt ?? Date.parse(record.value.createdAt) })
      }
      for (const manifest of await this.options.legacy?.() || []) {
        validateWeeklyManifest(manifest, this.scope)
        if (!candidates.has(manifest.id)) candidates.set(manifest.id, { manifest, modifiedAt: Date.parse(manifest.createdAt) })
      }
      let deleted = 0
      for (const { manifest, modifiedAt } of candidates.values()) {
        // Existing encrypted archives (including pre-protection manifests) are
        // grandfathered: switching formats never authorizes deleting them.
        if (manifest.protection !== 'none') continue
        if (keep.has(manifest.id) || (this.options.now?.() ?? Date.now()) - modifiedAt < GRACE_MS) continue
        // During adoption, preserve legacy days that do not yet have a verified
        // replacement. A first Sunday backup cannot authorize erasing Monday.
        const replacement = days.get(backupWeekday(manifest.createdAt, this.options.timeZone))
        if (!replacement || Date.parse(replacement.createdAt) < Date.parse(manifest.createdAt)) continue
        await owned()
        await this.objects.remove(manifest.objectKey)
        await this.objects.remove(manifest.objectKey + '.manifest.json')
        await this.options.forget?.(manifest)
        deleted++
      }
      return { deleted, deferred: false }
    }, true)
  }
}
