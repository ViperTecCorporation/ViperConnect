import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MobileDeviceError } from '../mobile_device_service'

// The serialized Redis layout is supplied by this exact store package, not by
// the WhatsApp client version. Both client releases use store-redis 1.3.0.
export type BackupZapoVersion = '1.9.0' | '1.11.0'
export const isBackupZapoVersion = (value: unknown): value is BackupZapoVersion => value === '1.9.0' || value === '1.11.0'

export function validateBackupRuntime(zapo: unknown, redisStore: unknown, code: string): BackupZapoVersion {
  if (zapo !== '1.11.0' || redisStore !== '1.3.0') throw new MobileDeviceError(400, code)
  return zapo
}

export function installedBackupVersion(code: string): BackupZapoVersion {
  return validateBackupRuntime(JSON.parse(readFileSync(require.resolve('zapo-js/package.json'), 'utf8')).version,
    JSON.parse(readFileSync(join(dirname(require.resolve('@zapo-js/store-redis')), '../package.json'), 'utf8')).version, code)
}

/** The legacy Redis-DUMP format must never read stale Redis copies of a SQLite session. */
export function assertRedisManualBackup(config: any, code: string): void {
  if (config?.sessionStorage?.backend === 'sqlite') throw new MobileDeviceError(409, code)
  if (config?.sessionStorage && ['migrating', 'restoring'].includes(config.sessionStorage.state)) throw new MobileDeviceError(409, 'session_storage_operation_in_progress')
}
