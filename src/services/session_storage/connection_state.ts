import { SessionStorageDescriptor, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor, SessionStorageError } from './types'

/** Connection events, not a queued reload or UI poll, update the descriptor.
 * The active socket's lease + immutable storage identity fence stale callbacks. */
export const OWNED_SQLITE_CONNECTION_STATE_LUA = `
if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local cfg=cjson.decode(raw); local s=cfg.sessionStorage
if cfg.provider~='zapo' or cfg.server~=ARGV[2] or not s or s.backend~='sqlite' or s.owner~=ARGV[2] or s.storageId~=ARGV[3] or s.generation~=tonumber(ARGV[4]) or (s.state~='offline' and s.state~='active') then return 0 end
if (ARGV[5]=='online' or ARGV[5]=='connecting') and (cfg.autoConnect~=true or cfg.sessionStorageUnlinked==true or cfg.mobilePrimaryDeleting==true) then return 0 end
if ARGV[5]=='online' then s.state='active'
elseif ARGV[5]=='offline' or ARGV[5]=='disconnected' then s.state='offline' end
redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('SET',KEYS[2],ARGV[5])
redis.call('PUBLISH','unoapi-status:update',ARGV[6]); return 1`

export async function publishOwnedSqliteConnectionState(redis: SessionStorageRedis, phone: string, storage: SessionStorageDescriptor,
  ownership: { key: string; token: string }, status: string) {
  validateSessionPhone(phone); validateStorageDescriptor(storage)
  if (storage.backend !== 'sqlite' || ownership.key !== `unoapi-lease:zapo-session:${phone}` || !ownership.token
    || !['online', 'offline', 'disconnected', 'connecting'].includes(status)) throw new SessionStorageError(409, 'session_storage_connection_state_invalid')
  return Number(await redis.eval(OWNED_SQLITE_CONNECTION_STATE_LUA, { keys: [`unoapi-config:${phone}`, `unoapi-status:${phone}`, ownership.key],
    arguments: [ownership.token, storage.owner, storage.storageId, String(storage.generation), status, phone] })) === 1
}
