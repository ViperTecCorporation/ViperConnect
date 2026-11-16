import { lstat } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { requireSafeSqliteEngine } from './sqlite_engine'
import { SessionStorageDescriptor, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STALE_MS = 600000
export interface ReconciliationConfig {
  provider?: string; server?: string; autoConnect?: boolean; baseStore: string
  sessionStorage?: SessionStorageDescriptor; sessionStorageTaskId?: string
  sessionStorageUnlinked?: boolean; mobilePrimaryDeleting?: boolean
}
export interface StorageReconciliationDependencies {
  owner: string; redis: SessionStorageRedis
  loadConfig(phone: string): Promise<ReconciliationConfig>
  hasClient(phone: string): boolean
  lease(phone: string): { acquire(): Promise<boolean>; assertOwned(): Promise<void>; release(): Promise<unknown>; ownership(): { key: string; token: string } }
  /** Required before returning a pre-cutover Redis descriptor to offline. Never mutate the source. */
  verifyRedisSource?(phone: string, config: ReconciliationConfig): Promise<boolean>
  now?(): number
}
export interface StorageReconciliationResult {
  status: 'not_needed' | 'waiting' | 'repaired' | 'recovery_required'
  reason: string; action?: 'retry_later' | 'retry_migration' | 'retry_restore' | 'verified_source_cleanup' | 'inspect_journal_and_files'
  generation?: number; backend?: 'redis' | 'sqlite'; transportEffects: false
}

/** Metadata-only repair. Every safety condition is rechecked in the same Redis operation. */
export const RECONCILE_INTERRUPTED_STORAGE_LUA = `
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local cfg=cjson.decode(raw); local s=cfg.sessionStorage; local old=cjson.decode(ARGV[1])
if cfg.provider~='zapo' or cfg.server~=old.owner or cfg.autoConnect~=false or cfg.mobilePrimaryDeleting==true or cfg.sessionStorageUnlinked==true or cfg.sessionStorageTaskId~=ARGV[2] or not s then return 0 end
if s.backend~=old.backend or s.storageId~=old.storageId or s.owner~=old.owner or s.generation~=old.generation or s.state~=old.state or s.fixture~=old.fixture then return 0 end
if redis.call('GET',KEYS[2])~=ARGV[3] or redis.call('EXISTS',KEYS[3])==1 or redis.call('GET',KEYS[4])~=ARGV[4] or redis.call('GET',KEYS[5])~=ARGV[5] then return 0 end
cfg.sessionStorage=cjson.decode(ARGV[6]); cfg.autoConnect=false; cfg.sessionStorageTaskId=nil
local task=cjson.decode(ARGV[4]); task.status='interrupted'; task.error='session_storage_reconciled_offline'; task.updatedAt=tonumber(ARGV[8]); task.progress={phase='reconciled_offline'}; task.result=nil
redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('SET',KEYS[4],cjson.encode(task),'EX',604800); redis.call('SET',KEYS[5],ARGV[7]); redis.call('PUBLISH','unoapi-config:update',ARGV[9]); return 1`

async function inspectFile(base: string, storageId: string, phone: string): Promise<'absent' | 'valid' | 'invalid'> {
  if (!UUID.test(storageId)) return 'invalid'
  const root = resolve(base), target = resolve(root, 'session-storage', storageId, 'session.sqlite'), rel = relative(root, target)
  if (root === parse(root).root || !rel || isAbsolute(rel) || rel.split(sep).includes('..')) return 'invalid'
  try {
    const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 'invalid'
    let current = root
    for (const segment of rel.split(sep)) {
      current = resolve(current, segment)
      const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!info) return 'absent'
      if (info.isSymbolicLink() || current === target && !info.isFile()) return 'invalid'
    }
    const sqlite = requireSafeSqliteEngine(), db = new sqlite.DatabaseSync(target, { readOnly: true, timeout: 5000 })
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('SELECT value FROM uno_storage_meta WHERE key=?').get('phone')?.value !== phone) return 'invalid'
      const prefix = `unoapi-id:${phone}:`, reverse = `unoapi-id_rev:${phone}:`
      const now = Date.now()
      const invalid = db.prepare('SELECT COUNT(*) AS n FROM uno_kv f LEFT JOIN uno_kv r ON r.key=?||CAST(f.value AS TEXT) WHERE substr(f.key,1,?)=? AND (f.expires_at IS NULL OR f.expires_at>?) AND (r.value IS NULL OR (r.expires_at IS NOT NULL AND r.expires_at<=?) OR CAST(r.value AS TEXT)!=substr(f.key,?))').get(reverse, prefix.length, prefix, now, now, prefix.length + 1)?.n
      return Number(invalid) === 0 ? 'valid' : 'invalid'
    } finally { db.close() }
  } catch { return 'invalid' }
}

/** Startup/manual coordinator hook. Never promotes a file, reconnects, replays or deletes data. */
export async function reconcileInterruptedStorage(phone: string, deps: StorageReconciliationDependencies): Promise<StorageReconciliationResult> {
  validateSessionPhone(phone)
  const result = (status: StorageReconciliationResult['status'], reason: string, action?: StorageReconciliationResult['action']): StorageReconciliationResult => ({ status, reason, ...(action ? { action } : {}), transportEffects: false })
  let config: ReconciliationConfig
  try { config = await deps.loadConfig(phone) } catch { return result('recovery_required', 'session_storage_recovery_unavailable', 'inspect_journal_and_files') }
  const storage = config.sessionStorage
  if (!storage || config.provider !== 'zapo') return result('not_needed', 'no_storage_transition')
  try { validateStorageDescriptor(storage) } catch { return result('recovery_required', 'session_storage_recovery_metadata_invalid', 'inspect_journal_and_files') }
  if (storage.owner !== deps.owner || config.server !== deps.owner) return result('waiting', 'session_storage_wrong_owner', 'retry_later')
  const transition = ['migrating', 'restoring'].includes(storage.state)
  if (config.autoConnect !== false || config.mobilePrimaryDeleting || config.sessionStorageUnlinked || deps.hasClient(phone)) return result('waiting', 'session_storage_transport_not_suspended', 'retry_later')
  const id = config.sessionStorageTaskId || await deps.redis.get(`unoapi-session-storage:current-task:${phone}`)
  if (!id || !UUID.test(id)) return result(transition ? 'recovery_required' : 'not_needed', transition ? 'session_storage_recovery_task_missing' : 'no_storage_transition', transition ? 'inspect_journal_and_files' : undefined)
  const taskKey = `unoapi-session-storage:task:${phone}:${id}`, journalKey = `unoapi-session-storage:journal:${phone}:${id}`, taskLock = `unoapi-session-storage:task:lock:${phone}`
  const taskRaw = await deps.redis.get(taskKey), journalRaw = await deps.redis.get(journalKey)
  let task: any, journal: any
  try { task = taskRaw && JSON.parse(taskRaw); journal = journalRaw && JSON.parse(journalRaw) } catch { return result('recovery_required', 'session_storage_recovery_metadata_invalid', 'inspect_journal_and_files') }
  if (!task || task.id !== id || task.phone !== phone || !['running', 'ready', 'failed', 'interrupted'].includes(task.status) || !['migration', 'restore'].includes(task.operation) || !journal || journal.taskId !== id || journal.phone !== phone || !UUID.test(journal.storageId || '')) return result(transition ? 'recovery_required' : 'not_needed', transition ? 'session_storage_recovery_metadata_invalid' : 'no_storage_transition', transition ? 'inspect_journal_and_files' : undefined)
  const now = deps.now?.() ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(task.updatedAt) || task.updatedAt < 0 || task.updatedAt > now || now - task.updatedAt < STALE_MS && task.status === 'running' || await deps.redis.get(taskLock)) return result('waiting', 'session_storage_task_still_active', 'retry_later')
  if (!transition && storage.backend === 'sqlite' && ['committed', 'source_cleanup_failed'].includes(journal.phase)) return result('recovery_required', 'session_storage_source_cleanup_required', 'verified_source_cleanup')
  if (!transition) return result('not_needed', 'no_storage_transition')
  if (task.status === 'ready' || journal.generation !== storage.generation || config.sessionStorageTaskId !== id) return result('recovery_required', 'session_storage_recovery_generation_ambiguous', 'inspect_journal_and_files')
  const lease = deps.lease(phone)
  if (!await lease.acquire()) return result('waiting', 'session_storage_waiting_disconnect', 'retry_later')
  try {
    await lease.assertOwned()
    const fresh = await deps.loadConfig(phone)
    if (JSON.stringify(fresh.sessionStorage) !== JSON.stringify(storage) || fresh.autoConnect !== false || fresh.sessionStorageTaskId !== id || deps.hasClient(phone)) return result('waiting', 'session_storage_configuration_changed', 'retry_later')
    let action: StorageReconciliationResult['action'], phase: string
    if (task.operation === 'migration' && storage.backend === 'redis' && storage.state === 'migrating' && ['prepared', 'copying', 'failed'].includes(journal.phase) && journal.storageId === storage.storageId) {
      const file = await inspectFile(config.baseStore, storage.storageId, phone)
      if (file !== 'absent') return result('recovery_required', file === 'invalid' ? 'session_storage_recovery_file_invalid' : 'session_storage_file_promotion_requires_review', 'inspect_journal_and_files')
      if (!deps.verifyRedisSource || !await deps.verifyRedisSource(phone, fresh)) return result('recovery_required', 'session_storage_redis_source_unverified', 'inspect_journal_and_files')
      action = 'retry_migration'; phase = 'redis_reconciled_offline'
    } else if (task.operation === 'restore' && storage.backend === 'sqlite' && storage.state === 'restoring' && ['restore_prepared', 'restore_failed'].includes(journal.phase) && journal.storageId !== storage.storageId) {
      const [old, candidate] = await Promise.all([inspectFile(config.baseStore, storage.storageId, phone), inspectFile(config.baseStore, journal.storageId, phone)])
      if (old !== 'valid' || candidate !== 'absent') return result('recovery_required', 'session_storage_restore_files_require_review', 'inspect_journal_and_files')
      action = 'retry_restore'; phase = 'restore_reconciled_offline'
    } else return result('recovery_required', 'session_storage_recovery_phase_requires_review', 'inspect_journal_and_files')
    await lease.assertOwned()
    const ownership = lease.ownership()
    if (ownership.key !== `unoapi-lease:zapo-session:${phone}` || !UUID.test(ownership.token)) return result('recovery_required', 'session_storage_recovery_lease_invalid', 'inspect_journal_and_files')
    const next = { ...storage, state: 'offline' as const, generation: storage.generation + 1 }
    const journalValue = JSON.stringify({ phase, generation: next.generation, storageId: storage.storageId, phone, taskId: id, updatedAt: now })
    const changed = await deps.redis.eval(RECONCILE_INTERRUPTED_STORAGE_LUA, { keys: [`unoapi-config:${phone}`, ownership.key, taskLock, taskKey, journalKey], arguments: [JSON.stringify(storage), id, ownership.token, taskRaw!, journalRaw!, JSON.stringify(next), journalValue, String(now), phone] })
    return Number(changed) === 1 ? { ...result('repaired', 'session_storage_reconciled_offline', action), generation: next.generation, backend: next.backend } : result('waiting', 'session_storage_configuration_changed', 'retry_later')
  } catch { return result('recovery_required', 'session_storage_recovery_unavailable', 'inspect_journal_and_files') }
  finally { await lease.release().catch(() => {}) }
}
