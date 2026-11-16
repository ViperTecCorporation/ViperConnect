import type { Config } from '../config'
import { SessionStorageDescriptor, SessionStorageError, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'

export const STORAGE_OFFLINE_STATUS_LUA = `
if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local cfg=cjson.decode(raw); local s=cfg.sessionStorage
if cfg.provider~='zapo' or cfg.server~=ARGV[2] or cfg.autoConnect~=false or cfg.sessionStorageUnlinked==true or cfg.mobilePrimaryDeleting==true or not s then return 0 end
if s.owner~=ARGV[2] or s.storageId~=ARGV[3] or s.generation~=tonumber(ARGV[4]) or s.backend~=ARGV[5] or s.state~=ARGV[6] then return 0 end
if ARGV[7]~='' and cfg.sessionStorageTaskId~=ARGV[7] then return 0 end
if ARGV[9]=='1' then
 local status=redis.call('GET',KEYS[2])
 if status~='online' and status~='connecting' and status~='standby' and status~='restart_required' then return 0 end
end
redis.call('SET',KEYS[2],'offline')
redis.call('PUBLISH','unoapi-status:update',ARGV[8])
return 1`

type Ownership = { key: string; token: string }
type OfflineConfig = Pick<Config, 'provider' | 'server' | 'autoConnect' | 'sessionStorage'> & { sessionStorageUnlinked?: boolean; mobilePrimaryDeleting?: boolean }
export interface OfflineStatusLease {
  acquire(): Promise<boolean>
  ownership(): Ownership
  release(): Promise<unknown>
}

/** Confirm local transport absence under the same lease/config fence as migration.
 * This updates the canonical UI cache, not WhatsApp credentials or a remote
 * logout/connection webhook. The status invalidation channel is the existing one. */
export async function publishOwnedStorageOffline(redis: SessionStorageRedis, phone: string, storage: SessionStorageDescriptor, ownership: Ownership,
  options: { taskId?: string; staleOnly?: boolean } = {}): Promise<boolean> {
  validateSessionPhone(phone); validateStorageDescriptor(storage)
  if (!['migrating', 'offline'].includes(storage.state) || storage.state === 'offline' && storage.backend !== 'sqlite'
    || ownership.key !== `unoapi-lease:zapo-session:${phone}` || !/^[a-f\d-]{36}$/i.test(ownership.token)
    || options.taskId !== undefined && !/^[a-f\d-]{36}$/i.test(options.taskId)) throw new SessionStorageError(409, 'session_storage_offline_confirmation_invalid')
  return Number(await redis.eval(STORAGE_OFFLINE_STATUS_LUA, {
    keys: [`unoapi-config:${phone}`, `unoapi-status:${phone}`, ownership.key],
    arguments: [ownership.token, storage.owner, storage.storageId, String(storage.generation), storage.backend, storage.state, options.taskId || '', phone, options.staleOnly ? '1' : '0'],
  })) === 1
}

/** Reconcile a stale UI status only after a committed offline SQLite migration.
 * Worker unavailability or a current lease never becomes a fabricated offline.
 * Reconnect/unlink/config changes are rechecked atomically before publication. */
export async function reconcileStorageSessionOffline(phone: string, config: OfflineConfig,
  deps: { redis: SessionStorageRedis; hasClient(): boolean; lease(): OfflineStatusLease }): Promise<boolean> {
  validateSessionPhone(phone)
  if (config.provider !== 'zapo' || config.sessionStorage?.backend !== 'sqlite' || config.sessionStorage.state !== 'offline'
    || config.autoConnect !== false || config.server !== config.sessionStorage.owner || config.sessionStorageUnlinked || config.mobilePrimaryDeleting || deps.hasClient()) return false
  const previous = await deps.redis.get(`unoapi-status:${phone}`)
  if (!previous || !['online', 'connecting', 'standby', 'restart_required'].includes(previous)) return false
  const lease = deps.lease()
  if (!await lease.acquire()) return false
  try {
    if (deps.hasClient()) return false
    return await publishOwnedStorageOffline(deps.redis, phone, config.sessionStorage, lease.ownership(), { staleOnly: true })
  } finally { await lease.release() }
}
