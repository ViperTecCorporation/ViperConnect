import { isDeepStrictEqual } from 'node:util'
import type { BackupObjects } from './backup_objects'
import { WeeklyBackupSlots, validateWeeklyManifest, type WeeklyManifest } from './backup_slots'
import { SessionStorageError, type SessionStorageRedis } from './types'

export type BackupScope = { kind: 'session-storage' | 'redis' | 'voip'; id: string }
interface IndexRedis extends SessionStorageRedis {
  scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number; keys: string[] }>
}
const indexPrefix = (scope: BackupScope) => scope.kind === 'session-storage' ? 'unoapi-session-storage:backup:' : scope.kind === 'voip' ? 'unoapi-infrastructure:voip-backup:manifest:' : 'unoapi-infrastructure:redis-backup:manifest:'

export function backupRetention(environment: NodeJS.ProcessEnv = process.env) {
  return environment.SESSION_STORAGE_BACKUP_ROTATION === 'weekly'
    ? { strategy: 'weekday-slots' as const, slots: 7, timeZone: environment.SESSION_STORAGE_BACKUP_TIMEZONE || 'UTC', replacement: 'latest-verified' as const }
    : { strategy: 'retain-all' as const }
}

/** Legacy index is bounded and scoped; unknown/corrupt records abort deletion, not backups. */
export async function indexedBackupManifests(scope: BackupScope, redis: IndexRedis): Promise<WeeklyManifest[]> {
  const result: WeeklyManifest[] = []; let cursor = 0, pages = 0
  do {
    if (++pages > 1000) throw new SessionStorageError(409, 'session_storage_backup_rotation_scan_limit')
    const page = await redis.scan(cursor, { MATCH: indexPrefix(scope) + '*', COUNT: 100 }); cursor = page.cursor
    for (const key of page.keys) {
      const raw = await redis.get(key); if (!raw) continue
      const value = JSON.parse(raw)
      if (scope.kind === 'session-storage' ? value.phone !== scope.id : value.instanceId !== scope.id) continue
      validateWeeklyManifest(value, scope); result.push(value)
      if (result.length > 2000) throw new SessionStorageError(409, 'session_storage_backup_rotation_scan_limit')
    }
  } while (cursor)
  return result
}

export function weeklyBackupSlots(scope: BackupScope, objects: BackupObjects, redis: IndexRedis, environment: NodeJS.ProcessEnv = process.env) {
  const policy = backupRetention(environment)
  if (policy.strategy !== 'weekday-slots') return undefined
  return new WeeklyBackupSlots(scope, objects, redis, { timeZone: policy.timeZone,
    legacy: () => indexedBackupManifests(scope, redis),
    busy: async () => scope.kind === 'session-storage' && !!await redis.get(`unoapi-session-storage:task:lock:${scope.id}`),
    forget: async manifest => {
      await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end return 1", { keys: [indexPrefix(scope) + manifest.id], arguments: [JSON.stringify(manifest)] })
    },
  })
}

/** Immutable non-secret sidecar survives Redis loss, even when rotation is not enabled. */
export async function publishBackupManifest(scope: BackupScope, manifest: WeeklyManifest, objects: BackupObjects, redis: IndexRedis, environment: NodeJS.ProcessEnv = process.env) {
  validateWeeklyManifest(manifest, scope)
  const slots = weeklyBackupSlots(scope, objects, redis, environment)
  if (slots) return slots.publish(manifest)
  const key = manifest.objectKey + '.manifest.json', previous = await objects.json(key)
  if (previous && !isDeepStrictEqual(previous.value, manifest)) throw new SessionStorageError(409, 'session_storage_backup_manifest_invalid')
  if (!previous && !await objects.putJson(key, manifest, null)) throw new SessionStorageError(409, 'session_storage_backup_rotation_changed')
  if (!isDeepStrictEqual((await objects.json(key))?.value, manifest)) throw new SessionStorageError(409, 'session_storage_backup_pointer_verification_failed')
  return { published: true }
}

/** Delayed pruning is independent of backup success; task lock protects restore and source verification. */
export async function pruneBackupSlots(scope: BackupScope, objects: BackupObjects, redis: IndexRedis, environment: NodeJS.ProcessEnv = process.env) {
  return (await weeklyBackupSlots(scope, objects, redis, environment)?.prune()) || { deleted: 0, deferred: true }
}
