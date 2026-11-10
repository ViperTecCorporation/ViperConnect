import { randomUUID } from 'node:crypto'
import type { Config } from '../config'
import type { SqliteMaintenanceResult } from './maintenance'
import type { StorageReconciliationDependencies, StorageReconciliationResult } from './reconciliation'
import { SessionStorageError, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'
type CoordinatorConfig = Config & { sessionStorageTaskId?: string }

export interface StorageMaintenanceDependencies {
  owner: string
  redis: SessionStorageRedis
  phones(): Promise<string[]>
  loadConfig(phone: string): Promise<CoordinatorConfig>
  busy(phone: string): boolean
  hasClient(phone: string): boolean
  lease: StorageReconciliationDependencies['lease']
  maintain(phone: string, config: Config, options: { now: number; rowBudget: number }): SqliteMaintenanceResult
  reconcile(phone: string, deps: StorageReconciliationDependencies): Promise<StorageReconciliationResult>
  cleanupUploads?(phone: string, config: Config): Promise<unknown>
  cleanupStandalone?(): Promise<unknown>
  now?(): number
}

const lockKey = (phone: string) => `unoapi-session-storage:task:lock:${phone}`
const RESERVE = "if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',60000); return 1"
const OWNED = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('PEXPIRE',KEYS[1],60000)"
const RELEASE = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('DEL',KEYS[1])"
const RECEIPT = `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local c=cjson.decode(raw); local s=c.sessionStorage; local e=cjson.decode(ARGV[1])
if c.provider~='zapo' or c.server~=e.owner or not s or s.owner~=e.owner or s.storageId~=e.storageId or s.generation~=e.generation or s.backend~=e.backend or s.state~=e.state then return 0 end
redis.call('SET',KEYS[2],ARGV[2]); return 1`
const TERMINAL = new Set(['source_cleaned', 'restore_committed', 'redis_reconciled_offline', 'restore_reconciled_offline'])
const safeCode = (error: any) => {
  const code = typeof error?.code === 'string' ? error.code : error?.title
  return /^session_storage_[a-z0-9_]{1,100}$/.test(code || '') ? code : 'session_storage_maintenance_failed'
}

/** Sequential metadata-only maintenance. Reads never invoke this class. */
export class SessionStorageMaintenanceCoordinator {
  private running = false
  private stopped = false
  constructor(private readonly deps: StorageMaintenanceDependencies) {}
  stop() { this.stopped = true }

  private local(config: Config) {
    return config.provider === 'zapo' && config.server === this.deps.owner && config.sessionStorage?.owner === this.deps.owner && !config.sessionStorage.fixture
  }

  private async pendingRecovery(phone: string, config: CoordinatorConfig) {
    if (config.sessionStorageTaskId || ['migrating', 'restoring'].includes(config.sessionStorage?.state || '')) return true
    const id = await this.deps.redis.get(`unoapi-session-storage:current-task:${phone}`)
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return false
    const raw = await this.deps.redis.get(`unoapi-session-storage:journal:${phone}:${id}`)
    if (!raw) return false
    try { return !TERMINAL.has(JSON.parse(raw).phase) }
    catch { throw new SessionStorageError(503, 'session_storage_recovery_metadata_invalid') }
  }

  private async receipt(phone: string, config: Config, value: object) {
    if (!this.local(config)) return
    await this.deps.redis.eval(RECEIPT, { keys: [`unoapi-config:${phone}`, `unoapi-session-storage:coordinator:${phone}`],
      arguments: [JSON.stringify(config.sessionStorage), JSON.stringify({ at: this.deps.now?.() ?? Date.now(), storageId: config.sessionStorage!.storageId,
        owner: this.deps.owner, generation: config.sessionStorage!.generation, transportEffects: false, ...value })] })
  }

  async tick() {
    const result = { skipped: false, maintained: 0, reconciled: 0, waiting: 0, failed: 0 }
    if (this.running || this.stopped) return { ...result, skipped: true }
    this.running = true
    try {
      await this.deps.cleanupStandalone?.().catch(() => { result.failed++ })
      for (const phone of await this.deps.phones()) {
        if (this.stopped) break
        let config: CoordinatorConfig | undefined
        try {
          validateSessionPhone(phone)
          config = await this.deps.loadConfig(phone)
          if (this.stopped) break
          if (!this.local(config)) continue
          validateStorageDescriptor(config.sessionStorage)
          if (this.deps.busy(phone) || await this.deps.redis.get(lockKey(phone))) { result.waiting++; continue }
          if (await this.pendingRecovery(phone, config)) {
            if (this.stopped || this.deps.busy(phone)) { result.waiting++; continue }
            const recovery = await this.deps.reconcile(phone, { owner: this.deps.owner, redis: this.deps.redis,
              loadConfig: this.deps.loadConfig, hasClient: this.deps.hasClient, lease: this.deps.lease,
              // No evidence of source integrity: retain recovery_required, never guess.
              verifyRedisSource: async () => false, now: this.deps.now })
            config = await this.deps.loadConfig(phone)
            await this.receipt(phone, config, { reconciliation: recovery })
            result.reconciled++
            if (recovery.status !== 'not_needed') continue
          }
          if (!this.local(config)) continue
          if (config.sessionStorage?.backend !== 'sqlite' || !['active', 'offline'].includes(config.sessionStorage.state) || this.deps.busy(phone)) continue
          const token = randomUUID(), key = lockKey(phone)
          if (Number(await this.deps.redis.eval(RESERVE, { keys: [key], arguments: [token] })) !== 1) { result.waiting++; continue }
          try {
            // A new task, owner or generation may have appeared while reserving.
            const fresh = await this.deps.loadConfig(phone)
            if (!this.local(fresh) || JSON.stringify(fresh.sessionStorage) !== JSON.stringify(config.sessionStorage)
              || Number(await this.deps.redis.eval(OWNED, { keys: [key], arguments: [token] })) !== 1
              || this.stopped || this.deps.busy(phone)) { result.waiting++; continue }
            const maintenance = this.deps.maintain(phone, fresh, { now: this.deps.now?.() ?? Date.now(), rowBudget: 500 })
            await this.receipt(phone, fresh, { maintenance }); result.maintained++
          } finally { await this.deps.redis.eval(RELEASE, { keys: [key], arguments: [token] }) }
          // Separate staging namespace and its own exclusion lock; no S3 work in a GET.
          await this.deps.cleanupUploads?.(phone, config)
        } catch (error) {
          result.failed++
          if (config) await this.receipt(phone, config, { error: safeCode(error) }).catch(() => undefined)
        }
      }
      return result
    } finally { this.running = false }
  }
}

let coordinator: SessionStorageMaintenanceCoordinator | undefined
let timer: NodeJS.Timeout | undefined
export function stopStorageMaintenanceCoordinator() { if (timer) clearInterval(timer); timer = undefined; coordinator?.stop(); coordinator = undefined }
export const tickStorageMaintenanceCoordinator = () => coordinator?.tick() ?? Promise.resolve({ skipped: true })

export async function startStorageMaintenanceCoordinator(dependencies?: StorageMaintenanceDependencies) {
  if (coordinator) return { started: true }
  if (!dependencies) {
    const { isStorageWorker, storageOwner } = module.require('./routing') as typeof import('./routing')
    const { storageCapability, storageRoot } = module.require('./capability') as typeof import('./capability')
    if (!isStorageWorker() || process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY === 'true' || !storageCapability().sqliteAvailable) return { started: false }
    const { getRedis, getSessionPhones } = module.require('../redis') as typeof import('../redis')
    const { defaultConfig } = module.require('../config') as typeof import('../config')
    const { clients } = module.require('../client') as typeof import('../client')
    const { RedisLease } = module.require('../redis_lease') as typeof import('../redis_lease')
    const { hasSessionStorageActivity } = module.require('./activity') as typeof import('./activity')
    const redis = await getRedis()
    dependencies = { owner: storageOwner(), redis, phones: getSessionPhones,
      loadConfig: async phone => { const raw = await redis.get(`unoapi-config:${phone}`); if (!raw) throw new SessionStorageError(404, 'session_storage_session_not_found'); return { ...defaultConfig, useRedis: true, useS3: true, ...JSON.parse(raw), baseStore: storageRoot() } },
      hasClient: phone => clients.has(phone), busy: phone => hasSessionStorageActivity(phone) || !!(clients.get(phone) as any)?.hasPendingStorageEvents?.(),
      maintain: module.require('./maintenance').maintainSessionSqlite, reconcile: module.require('./reconciliation').reconcileInterruptedStorage,
      cleanupUploads: module.require('./backup_upload').cleanExpiredStorageUploads,
      cleanupStandalone: () => module.require('./standalone_staging').cleanExpiredStandaloneStaging(storageOwner()),
      lease: phone => { const lease = new RedisLease(`zapo-session:${phone}`, 60000); return {
        acquire: () => lease.acquire(), ownership: () => lease.ownership(), release: () => lease.release(),
        assertOwned: async () => { if (!await lease.renew()) throw new SessionStorageError(409, 'session_storage_lease_lost') },
      } },
    }
  }
  coordinator = new SessionStorageMaintenanceCoordinator(dependencies)
  timer = setInterval(() => { void coordinator?.tick().catch(() => undefined) }, 60000); timer.unref?.()
  // S3 staging cleanup must not delay socket recovery during worker startup.
  void coordinator.tick().catch(() => undefined)
  return { started: true }
}
