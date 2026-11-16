import { randomUUID } from 'node:crypto'
import type { MigrationResumeIntent } from './migrated_connection'
import { SessionStorageDescriptor, SessionStorageError, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'

export const migrationCompletionKey = (phone: string) => `unoapi-session-storage:migration-completion:${phone}`
export const migrationCompletionLock = (phone: string) => `unoapi-session-storage:completion-lock:${phone}`
export interface MigrationCompletion {
  phone: string; taskId: string; storage: SessionStorageDescriptor; backupId: string; digest: string
  resume: 'pending' | 'enabled' | 'requested' | 'skipped' | 'failed'; reason?: string
  cleanup: 'pending' | 'running' | 'ready' | 'diverged' | 'failed'
  cleanupResult?: { deleted: number; skipped: number; missing: number }; error?: string
  autoConnect?: boolean
}
const UUID = /^[a-f0-9-]{36}$/i
const stable = (s: SessionStorageDescriptor) => s.backend === 'sqlite' && ['offline', 'active'].includes(s.state)
export function validateMigrationCompletion(p: MigrationCompletion) {
  validateSessionPhone(p?.phone); validateStorageDescriptor(p?.storage)
  if (!UUID.test(p.taskId) || !UUID.test(p.backupId) || !/^[a-f0-9]{64}$/.test(p.digest) || !stable(p.storage)
    || !['pending', 'enabled', 'requested', 'skipped', 'failed'].includes(p.resume)
    || !['pending', 'running', 'ready', 'diverged', 'failed'].includes(p.cleanup)) throw new SessionStorageError(409, 'session_storage_completion_invalid')
}

export const PREPARE_MIGRATION_COMPLETION_LUA = `
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local cfg=cjson.decode(raw); local s=cfg.sessionStorage; local p=cjson.decode(ARGV[1]); local b=redis.call('GET',KEYS[3])
if cfg.provider~='zapo' or cfg.server~=p.storage.owner or cfg.autoConnect~=false or cfg.sessionStorageTaskId~=nil or not s or s.backend~='sqlite' or s.state~='offline' or s.storageId~=p.storage.storageId or s.generation~=p.storage.generation or s.owner~=p.storage.owner or redis.call('GET',KEYS[2])~=p.taskId or not b then return 0 end
b=cjson.decode(b); if b.id~=p.backupId or b.status~='ready' or b.phone~=p.phone or b.storageId~=s.storageId or b.generation~=s.generation then return 0 end
redis.call('SET',KEYS[4],ARGV[1]); return 1`

/** Backup readback (including the fingerprint table) must finish before this call. */
export async function prepareMigrationCompletion(redis: SessionStorageRedis, p: Omit<MigrationCompletion, 'resume' | 'cleanup'>, intent: MigrationResumeIntent) {
  const plan: MigrationCompletion = { ...p, resume: intent.eligible && !intent.fixture && !p.storage.fixture ? 'pending' : 'skipped', cleanup: 'pending' }
  if (plan.resume === 'skipped') plan.reason = intent.fixture || p.storage.fixture ? 'fixture' : 'previously_offline'
  validateMigrationCompletion(plan)
  if (Number(await redis.eval(PREPARE_MIGRATION_COMPLETION_LUA, {
    keys: [`unoapi-config:${p.phone}`, `unoapi-session-storage:task:lock:${p.phone}`, `unoapi-session-storage:backup:${p.backupId}`, migrationCompletionKey(p.phone)],
    arguments: [JSON.stringify(plan)],
  })) !== 1) throw new SessionStorageError(409, 'session_storage_configuration_changed')
  return plan
}

/** Restore intent AND mark it consumed in the same transaction. A later manual
 * disconnect must never be undone when the worker resumes a pending cleanup. */
export const RESUME_COMPLETED_MIGRATION_LUA = `
if redis.call('GET',KEYS[3])~=ARGV[1] or redis.call('EXISTS',KEYS[4])==1 then return '' end
local raw=redis.call('GET',KEYS[1]); local plan=redis.call('GET',KEYS[2]); if not raw or not plan then return '' end
local cfg=cjson.decode(raw); local p=cjson.decode(plan); local s=cfg.sessionStorage; local e=cjson.decode(ARGV[2])
if p.phone~=e.phone or p.taskId~=e.taskId or p.storage.storageId~=e.storage.storageId or p.storage.owner~=e.storage.owner or p.storage.generation~=e.storage.generation or cfg.provider~='zapo' or cfg.server~=e.storage.owner or cfg.sessionStorageTaskId~=nil or cfg.mobilePrimaryDeleting==true or cfg.sessionStorageUnlinked==true or not s or s.backend~='sqlite' or (s.state~='offline' and s.state~='active') or s.storageId~=e.storage.storageId or s.owner~=e.storage.owner or s.generation~=e.storage.generation then return '' end
if p.resume=='pending' then
 if s.fixture==true or ARGV[4]~='1' then p.resume='skipped'; p.reason='external_effects_blocked'
 elseif ARGV[3]=='1' or cfg.autoConnect~=false then p.resume='skipped'; p.reason='client_or_intent_already_changed'
 elseif redis.call('EXISTS',KEYS[5])==1 then return ''
 else cfg.autoConnect=true; p.resume='enabled'; redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('PUBLISH','unoapi-config:update',p.phone) end
elseif p.resume=='enabled' then
 if cfg.autoConnect~=true or s.fixture==true or ARGV[4]~='1' then p.resume='skipped'; p.reason='intent_changed'
 elseif ARGV[3]=='1' then p.resume='requested'
 elseif redis.call('EXISTS',KEYS[5])==1 then return '' end
end
p.autoConnect=cfg.autoConnect==true
redis.call('SET',KEYS[2],cjson.encode(p)); return cjson.encode(p)`

const UPDATE = `if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end; redis.call('SET',KEYS[2],ARGV[3]); return 1`
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0"
const RENEW = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('PEXPIRE',KEYS[1],120000)"

export interface MigrationCompletionDependencies {
  redis: SessionStorageRedis; owner: string; hasClient(phone: string): boolean; effectsAllowed(): boolean
  dispatch(phone: string): Promise<unknown>
  cleanup(plan: MigrationCompletion, lease: { key: string; token: string; assertOwned(): Promise<void> }): Promise<NonNullable<MigrationCompletion['cleanupResult']>>
}

/** Independent renewable lock; never holds the session/lifecycle lease while
 * deleting source data. Each Redis deletion batch fences config/task/backup. */
export async function completeMigration(phone: string, deps: MigrationCompletionDependencies) {
  validateSessionPhone(phone)
  const key = migrationCompletionKey(phone), raw = await deps.redis.get(key)
  if (!raw) return
  let plan: MigrationCompletion = JSON.parse(raw); validateMigrationCompletion(plan)
  if (plan.phone !== phone) throw new SessionStorageError(409, 'session_storage_completion_invalid')
  if (plan.storage.owner !== deps.owner || ['ready', 'diverged', 'failed'].includes(plan.cleanup)) return
  const lock = migrationCompletionLock(phone), token = randomUUID()
  if (Number(await deps.redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',120000); return 1", { keys: [lock], arguments: [token] })) !== 1) return
  let lost = false
  const assertOwned = async () => { if (lost || Number(await deps.redis.eval(RENEW, { keys: [lock], arguments: [token] })) !== 1) { lost = true; throw new SessionStorageError(409, 'session_storage_cleanup_lease_lost') } }
  const timer = setInterval(() => { void assertOwned().catch(() => { lost = true }) }, 30000); timer.unref?.()
  let currentRaw = raw
  const save = async () => {
    await assertOwned()
    const next = JSON.stringify(plan)
    if (Number(await deps.redis.eval(UPDATE, { keys: [lock, key], arguments: [token, currentRaw, next] })) !== 1) throw new SessionStorageError(409, 'session_storage_configuration_changed')
    currentRaw = next
  }
  try {
    const resumed = await deps.redis.eval(RESUME_COMPLETED_MIGRATION_LUA, {
      keys: [`unoapi-config:${phone}`, key, lock, `unoapi-session-storage:task:lock:${phone}`, `unoapi-lease:zapo-session:${phone}`],
      arguments: [token, raw, deps.hasClient(phone) ? '1' : '0', deps.effectsAllowed() ? '1' : '0'],
    })
    if (typeof resumed !== 'string' || !resumed) return
    currentRaw = resumed; plan = JSON.parse(resumed); validateMigrationCompletion(plan)
    if (plan.resume === 'enabled') {
      try { await deps.dispatch(phone); plan.resume = 'requested' }
      catch { plan.resume = 'failed'; plan.reason = 'dispatch_failed' }
      await save()
    }
    if (await deps.redis.get(`unoapi-session-storage:task:lock:${phone}`)) return
    plan.cleanup = 'running'; await save()
    try {
      plan.cleanupResult = await deps.cleanup(plan, { key: lock, token, assertOwned })
      plan.cleanup = plan.cleanupResult.skipped ? 'diverged' : 'ready'; delete plan.error
    } catch (error) {
      // Concurrent lifecycle work simply pauses cleanup; changed values stay intact.
      const code = error instanceof SessionStorageError ? error.code : (error as any)?.message
      if (/session_storage_cleanup_(?:configuration_changed|operation_in_progress)/.test(code || '')) plan.cleanup = 'pending'
      else { plan.cleanup = 'failed'; plan.error = /^session_storage_[a-z0-9_]+$/.test(code || '') ? code : 'session_storage_source_cleanup_failed' }
    }
    await save()
  } finally { clearInterval(timer); await deps.redis.eval(RELEASE, { keys: [lock], arguments: [token] }) }
}

/** Public receipt only. No tokens, fingerprints, paths or credentials. */
export function migrationCompletionResult(plan: MigrationCompletion, taskId: string, original: unknown) {
  validateMigrationCompletion(plan)
  if (plan.taskId !== taskId) return original
  return { ...(original as object), ...(typeof plan.autoConnect === 'boolean' ? { autoConnect: plan.autoConnect } : {}), sourcePreserved: plan.cleanup !== 'ready',
    sourceCleanup: { ...plan.cleanupResult, backupId: plan.backupId, status: plan.cleanup, ...(plan.error ? { error: plan.error } : {}) },
    reconnect: { status: plan.resume === 'enabled' ? 'pending' : plan.resume, ...(plan.reason ? { reason: plan.reason } : {}) } }
}

/** A verified, explicitly requested offline cleanup may resolve a failed
 * background run. It must never revive the old captured connection intent. */
export async function recordManualSourceCleanup(redis: SessionStorageRedis, phone: string, storage: SessionStorageDescriptor, taskId: string,
  result: NonNullable<MigrationCompletion['cleanupResult']>) {
  validateSessionPhone(phone); validateStorageDescriptor(storage)
  const key = migrationCompletionKey(phone), raw = await redis.get(key)
  if (!raw) return false
  const plan: MigrationCompletion = JSON.parse(raw); validateMigrationCompletion(plan)
  if (plan.phone !== phone || plan.storage.storageId !== storage.storageId || plan.storage.generation !== storage.generation || plan.storage.owner !== storage.owner) return false
  plan.cleanupResult = result; plan.cleanup = result.skipped ? 'diverged' : 'ready'; delete plan.error
  if (['pending', 'enabled'].includes(plan.resume)) { plan.resume = 'skipped'; plan.reason = 'manual_source_cleanup'; plan.autoConnect = false }
  const script = `if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
local cfgRaw=redis.call('GET',KEYS[3]); if not cfgRaw then return 0 end
local cfg=cjson.decode(cfgRaw); local s=cfg.sessionStorage; local p=cjson.decode(ARGV[3])
if cfg.provider~='zapo' or cfg.server~=p.storage.owner or cfg.autoConnect~=false or not s or s.backend~='sqlite' or s.state~='offline' or s.storageId~=p.storage.storageId or s.owner~=p.storage.owner or s.generation~=p.storage.generation then return 0 end
redis.call('SET',KEYS[1],ARGV[3]); return 1`
  return Number(await redis.eval(script, { keys: [key, `unoapi-session-storage:task:lock:${phone}`, `unoapi-config:${phone}`], arguments: [raw, taskId, JSON.stringify(plan)] })) === 1
}
