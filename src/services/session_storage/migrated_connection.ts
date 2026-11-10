import type { Config } from '../config'
import { assertSessionEffectsAllowed } from './routing'
import { SessionStorageDescriptor, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'

export type MigrationResumeIntent = { eligible: boolean; fixture: boolean }
export type MigrationReconnect = { status: 'requested' | 'skipped' | 'failed'; reason?: string }

/** Capture before the migration disables autoConnect or stops the old client.
 * A cached online flag without a local client is not proof of a live session. */
export function migrationResumeIntent(config: Pick<Config, 'autoConnect' | 'sessionStorage'>, status: string | null | undefined, hasClient: boolean): MigrationResumeIntent {
  return { eligible: config.autoConnect === true && hasClient && (status === 'online' || status === 'connecting'), fixture: !!config.sessionStorage?.fixture }
}

export const RESTORE_MIGRATION_INTENT_LUA = `
if redis.call('EXISTS',KEYS[2])~=0 then return 0 end
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local cfg=cjson.decode(raw); local s=cfg.sessionStorage
if cfg.provider~='zapo' or cfg.server~=ARGV[1] or cfg.autoConnect~=false or cfg.sessionStorageTaskId~=nil or cfg.sessionStorageUnlinked==true or cfg.mobilePrimaryDeleting==true or not s then return 0 end
if s.backend~='sqlite' or s.state~='offline' or s.fixture==true or s.owner~=ARGV[1] or s.storageId~=ARGV[2] or s.generation~=tonumber(ARGV[3]) then return 0 end
cfg.autoConnect=true
redis.call('SET',KEYS[1],cjson.encode(cfg))
redis.call('PUBLISH','unoapi-config:update',ARGV[4])
return 1`

/** Called only after committed migration's finally released socket ownership.
 * Connection failure cannot roll back a database that has already committed.
 * Dispatch acceptance is never reported as a confirmed WhatsApp connection. */
export async function reconnectMigratedSession(phone: string, storage: SessionStorageDescriptor, intent: MigrationResumeIntent,
  deps: { redis: SessionStorageRedis; hasClient(): boolean; dispatch(phone: string): Promise<unknown>; effectsAllowed?(): void }): Promise<{ autoConnect: boolean; reconnect: MigrationReconnect }> {
  validateSessionPhone(phone); validateStorageDescriptor(storage)
  const skipped = (reason: string) => ({ autoConnect: false, reconnect: { status: 'skipped' as const, reason } })
  if (!intent.eligible) return skipped('previously_offline')
  if (intent.fixture || storage.fixture) return skipped('fixture')
  if (storage.backend !== 'sqlite' || storage.state !== 'offline') return skipped('storage_not_committed_offline')
  try { (deps.effectsAllowed || (() => assertSessionEffectsAllowed({ sessionStorage: storage })))() }
  catch { return skipped('external_effects_blocked') }
  if (deps.hasClient()) return skipped('client_already_present')
  try {
    if (Number(await deps.redis.eval(RESTORE_MIGRATION_INTENT_LUA, {
      keys: [`unoapi-config:${phone}`, `unoapi-lease:zapo-session:${phone}`],
      arguments: [storage.owner, storage.storageId, String(storage.generation), phone],
    })) !== 1) return skipped('configuration_or_ownership_changed')
  } catch { return { autoConnect: false, reconnect: { status: 'failed', reason: 'intent_restore_failed' } } }
  try {
    await deps.dispatch(phone)
    return { autoConnect: true, reconnect: { status: 'requested' } }
  } catch {
    return { autoConnect: true, reconnect: { status: 'failed', reason: 'dispatch_failed' } }
  }
}
