import { readFileSync } from 'node:fs'
import type { Config } from '../config'
import { getRedis } from '../redis'
import { SessionSqliteBackups, type SqliteBackupManifest } from './backup'
import { createBackupObjects } from './backup_objects'
import { captureBackupState } from './backup_capture'
import { publishBackupManifest, pruneBackupSlots } from './backup_policy'
import { assertLocalStorageOwner, isSqliteSession } from './routing'
import { requireStorageVolume } from './capability'
import { getSessionSqlitePath } from './database'
import { SessionStorageError } from './types'

let backupTail: Promise<unknown> = Promise.resolve()
/** Optional legacy key only. New plain archives never require or read it. */
export function sessionBackupPassword(): string | undefined {
  const file = process.env.SESSION_STORAGE_BACKUP_KEY_FILE
  if (!file) return undefined
  try {
    const password = readFileSync(file, 'utf8').trim()
    return password.length >= 24 && password.length <= 128 ? password : undefined
  } catch { return undefined }
}

export async function sessionBackupService(phone: string, config: Config) {
  if (!config.useS3) throw new SessionStorageError(409, 'session_storage_backup_requires_s3')
  const redis = await getRedis(), objects = createBackupObjects((config as any).storage), scope = { kind: 'session-storage' as const, id: phone }
  return new SessionSqliteBackups(objects, {
    put: async manifest => {
      await publishBackupManifest(scope, manifest, objects, redis)
      await redis.eval(`redis.call('SET',KEYS[1],ARGV[1]); local old=redis.call('GET',KEYS[2]); if not old or cjson.decode(old).createdAt<=ARGV[2] then redis.call('SET',KEYS[2],ARGV[1]) end return 1`, {
        keys: [`unoapi-session-storage:backup:${manifest.id}`, `unoapi-session-storage:last-backup:${phone}`], arguments: [JSON.stringify(manifest), manifest.createdAt] })
    },
    get: async id => {
      const raw = await redis.get(`unoapi-session-storage:backup:${id}`)
      if (raw) return JSON.parse(raw)
      return (await objects.json(`backups/session-storage/${phone}/${id}.viperstorage.manifest.json`))?.value as SqliteBackupManifest | undefined
    },
  })
}

export async function makeSessionBackup(phone: string, config: Config) {
  assertLocalStorageOwner(config); requireStorageVolume()
  if (!isSqliteSession(config)) throw new SessionStorageError(409, 'session_storage_backup_requires_sqlite')
  const run = async () => {
    const redis = await getRedis()
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await captureBackupState(phone, config, redis, process.env.MOBILE_REGISTRATION_KEY || '')
      try {
        return await (await sessionBackupService(phone, config)).backup({ phone, path: getSessionSqlitePath(phone, config), storage: config.sessionStorage!,
          kind: config.mobilePrimaryDraftId ? 'mobile-primary' : 'linked-session', supplement: { ...state.primary, configuration: state.configuration }, validateSnapshot: state.unchanged })
      } catch (error) { if (!(error instanceof SessionStorageError) || error.code !== 'session_storage_backup_shared_state_changed' || attempt === 2) throw error }
    }
    throw new SessionStorageError(409, 'session_storage_backup_shared_state_changed')
  }
  const next = backupTail.then(run, run); backupTail = next.catch(() => undefined); return next
}

export async function pruneSessionBackups(phone: string, config: Config) {
  if (!config.useS3) return { deleted: 0, deferred: true }
  return pruneBackupSlots({ kind: 'session-storage', id: phone }, createBackupObjects((config as any).storage), await getRedis())
}
