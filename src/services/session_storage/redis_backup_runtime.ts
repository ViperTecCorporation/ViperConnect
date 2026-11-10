import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { RedisGlobalBackups, RedisGlobalBackupScheduler, redisBackupCapability, type RedisBackupIndex, type RedisBackupManifest } from './redis_backup'
import { SessionStorageError, type SessionStorageRedis } from './types'

const PREFIX = 'unoapi-infrastructure:redis-backup:'
const STATUS_KEY = PREFIX + 'status'
const LOCK_KEY = PREFIX + 'running'
const LOCK_MS = 120000

export const RESERVE_REDIS_BACKUP_WINDOW_LUA = `
if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end
redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]); return 1`
export const FINISH_REDIS_BACKUP_WINDOW_LUA = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if ARGV[2]=='true' then redis.call('SET',KEYS[2],ARGV[4],'EX',259200) end
redis.call('SET',KEYS[3],ARGV[3],'EX',2592000)
redis.call('DEL',KEYS[1]); return 1`

type BackupInput = Parameters<RedisGlobalBackups['backup']>[0]
export interface RedisGlobalRoutineDependencies {
  environment: NodeJS.ProcessEnv
  redis(): Promise<SessionStorageRedis>
  capability(path: string | undefined): Promise<{ available: boolean; reason?: string }>
  readKey(path: string): Promise<string>
  backup(input: BackupInput, index: RedisBackupIndex): Promise<RedisBackupManifest>
  prune?(): Promise<void>
  log(level: 'info' | 'warn' | 'error', entry: { event: string; phase: string; code?: string }): void
}
export interface RedisGlobalRoutineStatus {
  enabled: boolean; routineActive: boolean; allDatabases: boolean; cliAvailable: boolean
  protection: 'none'
  phase: 'disabled' | 'unavailable' | 'waiting' | 'running' | 'ready' | 'failed' | 'interrupted'
  instanceId: string; updatedAt: number; error?: string
  lastBackup?: { id: string; createdAt: string; bytes: number; uploadVerified: true; protection: 'none' | 'aes-256-gcm' }
}

const defaultDependencies: RedisGlobalRoutineDependencies = {
  environment: process.env,
  redis: () => module.require('../redis').getRedis(),
  capability: redisBackupCapability,
  readKey: async path => (await readFile(path, 'utf8')).trim(),
  backup: async (input, index) => {
    const { createBackupObjects } = module.require('./backup_objects')
    const { publishBackupManifest } = module.require('./backup_policy')
    const redis = await defaultDependencies.redis(), objects = createBackupObjects()
    return new RedisGlobalBackups(objects, {
      get: index.get,
      put: async manifest => {
        await publishBackupManifest({ kind: 'redis', id: input.instanceId }, manifest, objects, redis)
        await index.put(manifest)
      },
    }).backup(input)
  },
  prune: async () => {
    const { createBackupObjects } = module.require('./backup_objects')
    const { pruneBackupSlots } = module.require('./backup_policy')
    const id = process.env.SESSION_STORAGE_REDIS_BACKUP_INSTANCE_ID || process.env.UNOAPI_SERVER_NAME || 'server_1'
    await pruneBackupSlots({ kind: 'redis', id }, createBackupObjects(), await defaultDependencies.redis())
  },
  log: (level, entry) => module.require('../logger').default[level](entry, 'Redis global backup routine'),
}

function initialStatus(env: NodeJS.ProcessEnv): RedisGlobalRoutineStatus {
  const proposed = env.SESSION_STORAGE_REDIS_BACKUP_INSTANCE_ID || env.UNOAPI_SERVER_NAME || 'server_1'
  return { enabled: env.SESSION_STORAGE_REDIS_BACKUP_ENABLED === 'true', routineActive: false,
    protection: 'none',
    allDatabases: env.SESSION_STORAGE_REDIS_BACKUP_ALL_DATABASES === 'true', cliAvailable: false,
    phase: env.SESSION_STORAGE_REDIS_BACKUP_ENABLED === 'true' ? 'waiting' : 'disabled',
    instanceId: /^[A-Za-z0-9_.-]{1,100}$/.test(proposed) ? proposed : 'invalid-instance', updatedAt: Date.now() }
}

/** One global Redis backup claim per half-day, shared across all server/worker names. */
export class RedisGlobalBackupRoutine {
  private timer: NodeJS.Timeout | undefined
  private scheduler: RedisGlobalBackupScheduler | undefined
  private state: RedisGlobalRoutineStatus
  private token: string | undefined
  private window: number | undefined
  constructor(readonly deps: RedisGlobalRoutineDependencies = defaultDependencies) { this.state = initialStatus(deps.environment) }

  private async persistStatus(requireLease: boolean) {
    const redis = await this.deps.redis()
    const result = await redis.eval(requireLease
      ? "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'EX',2592000); return 1"
      : "redis.call('SET',KEYS[1],ARGV[1],'EX',2592000); return 1", requireLease
      ? { keys: [LOCK_KEY, STATUS_KEY], arguments: [this.token || '', JSON.stringify(this.state)] }
      : { keys: [PREFIX + 'capability:' + this.state.instanceId], arguments: [JSON.stringify(this.state)] })
    if (requireLease && Number(result) !== 1) throw new SessionStorageError(409, 'redis_backup_lease_lost')
  }

  private async unavailable(code: string) {
    this.state = { ...this.state, phase: 'unavailable', error: code, routineActive: false, updatedAt: Date.now() }
    this.deps.log('warn', { event: 'REDIS_GLOBAL_BACKUP', phase: 'unavailable', code })
    await this.persistStatus(false).catch(() => this.deps.log('error', { event: 'REDIS_GLOBAL_BACKUP', phase: 'unavailable', code: 'redis_backup_status_persistence_failed' }))
    return this.status()
  }

  async start() {
    if (this.timer) return this.status()
    if (!this.state.enabled) return this.status()
    const env = this.deps.environment
    if (env.UNOAPI_STORAGE_SYNTHETIC_ONLY === 'true') return this.unavailable('redis_backup_synthetic_runtime_disabled')
    if (!this.state.allDatabases) return this.unavailable('redis_backup_all_databases_confirmation_required')
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(env.SESSION_STORAGE_REDIS_BACKUP_INSTANCE_ID || env.UNOAPI_SERVER_NAME || 'server_1')) return this.unavailable('redis_backup_instance_invalid')
    const capability = await this.deps.capability(env.SESSION_STORAGE_REDIS_CLI_PATH)
    this.state.cliAvailable = capability.available
    if (!capability.available) return this.unavailable(capability.reason || 'redis_backup_cli_unavailable')
    if (!env.REDIS_URL || !env.STORAGE_ENDPOINT || !env.STORAGE_BUCKET_NAME) return this.unavailable('redis_backup_source_or_s3_configuration_required')
    this.scheduler = new RedisGlobalBackupScheduler({
      enabled: () => this.state.routineActive,
      claimWindow: async window => {
        const token = randomUUID(), redis = await this.deps.redis()
        const accepted = await redis.eval(RESERVE_REDIS_BACKUP_WINDOW_LUA, {
          keys: [LOCK_KEY, PREFIX + 'window:' + window], arguments: [token, String(LOCK_MS)] })
        if (Number(accepted) === 1) { this.token = token; this.window = window }
        return Number(accepted) === 1
      },
      finishWindow: (window, success) => this.finishWindow(window, success),
      backup: () => this.perform(),
    })
    this.state = { ...this.state, routineActive: true, phase: 'waiting', error: undefined, updatedAt: Date.now() }
    this.timer = setInterval(() => { void this.tick().catch(() => this.deps.log('error', { event: 'REDIS_GLOBAL_BACKUP', phase: 'failed', code: 'redis_backup_routine_failed' })) }, 60000)
    this.timer.unref?.()
    // Startup does not block the application on snapshot/upload/readback.
    void this.tick().catch(() => this.deps.log('error', { event: 'REDIS_GLOBAL_BACKUP', phase: 'failed', code: 'redis_backup_routine_failed' }))
    return this.status()
  }

  private async perform() {
    const token = this.token, env = this.deps.environment, redis = await this.deps.redis()
    if (!token) throw new SessionStorageError(409, 'redis_backup_lease_lost')
    let leaseLost = false, heartbeatTail = Promise.resolve()
    const renew = async () => {
      if (Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 1", { keys: [LOCK_KEY], arguments: [token, String(LOCK_MS)] })) !== 1) throw new SessionStorageError(409, 'redis_backup_lease_lost')
    }
    const heartbeat = setInterval(() => { heartbeatTail = heartbeatTail.then(async () => { await renew(); this.state.updatedAt = Date.now(); await this.persistStatus(true) }).catch(() => { leaseLost = true }) }, 30000)
    heartbeat.unref?.()
    this.state = { ...this.state, phase: 'running', error: undefined, updatedAt: Date.now() }
    try {
      // Preserve the last successful receipt across restarts and later failures.
      const previousRaw = await redis.get(STATUS_KEY)
      if (!this.state.lastBackup && previousRaw) {
        const last = JSON.parse(previousRaw).lastBackup
        if (last && /^[a-f0-9-]{36}$/i.test(last.id) && Number.isSafeInteger(last.bytes) && last.bytes >= 0 && Number.isFinite(Date.parse(last.createdAt)) && last.uploadVerified === true) this.state.lastBackup = { id: last.id, bytes: last.bytes, createdAt: last.createdAt, uploadVerified: true, protection: last.protection === 'none' ? 'none' : 'aes-256-gcm' }
      }
      await this.persistStatus(true)
      const index: RedisBackupIndex = {
        put: async manifest => {
          if (leaseLost) throw new SessionStorageError(409, 'redis_backup_lease_lost')
          await renew()
          if (Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2]); return 1", { keys: [LOCK_KEY, PREFIX + 'manifest:' + manifest.id], arguments: [token, JSON.stringify(manifest)] })) !== 1) throw new SessionStorageError(409, 'redis_backup_lease_lost')
        },
        get: async id => { const raw = await redis.get(PREFIX + 'manifest:' + id); return raw ? JSON.parse(raw) : undefined },
      }
      const manifest = await this.deps.backup({ enabled: true, confirmAllDatabases: true, cliPath: env.SESSION_STORAGE_REDIS_CLI_PATH!, redisUrl: env.REDIS_URL!, instanceId: this.state.instanceId,
        ...(env.SESSION_STORAGE_REDIS_BACKUP_TLS_CA_FILE ? { tlsCaFile: env.SESSION_STORAGE_REDIS_BACKUP_TLS_CA_FILE } : {}) }, index)
      if (leaseLost) throw new SessionStorageError(409, 'redis_backup_lease_lost')
      this.state = { ...this.state, updatedAt: Date.now(), lastBackup: { id: manifest.id, bytes: manifest.bytes, createdAt: manifest.createdAt, uploadVerified: true, protection: manifest.protection === 'none' ? 'none' : 'aes-256-gcm' } }
    } catch (error) {
      const code = error instanceof SessionStorageError ? error.code : 'redis_backup_failed'
      this.state = { ...this.state, phase: 'failed', error: code, updatedAt: Date.now() }
      await this.persistStatus(true).catch(() => this.deps.log('error', { event: 'REDIS_GLOBAL_BACKUP', phase: 'failed', code: 'redis_backup_status_persistence_failed' }))
      this.deps.log('error', { event: 'REDIS_GLOBAL_BACKUP', phase: 'failed', code })
      throw new SessionStorageError(503, code)
    } finally {
      clearInterval(heartbeat)
      await heartbeatTail
    }
  }

  /** A successful readback, receipt and window marker commit under the same ownership fence. */
  private async finishWindow(window: number, success: boolean) {
    const token = this.token
    if (!token || this.window !== window) {
      if (success) throw new SessionStorageError(409, 'redis_backup_lease_lost')
      return
    }
    const state = { ...this.state, phase: success ? 'ready' as const : 'failed' as const, updatedAt: Date.now() }
    try {
      const result = await (await this.deps.redis()).eval(FINISH_REDIS_BACKUP_WINDOW_LUA, {
        keys: [LOCK_KEY, PREFIX + 'window:' + window, STATUS_KEY], arguments: [token, String(success), JSON.stringify(state), String(state.updatedAt)],
      })
      if (Number(result) !== 1) throw new SessionStorageError(409, 'redis_backup_lease_lost')
      this.state = state
      if (success) this.deps.log('info', { event: 'REDIS_GLOBAL_BACKUP', phase: 'ready' })
    } finally { if (this.token === token) { this.token = undefined; this.window = undefined } }
  }

  async tick(now = Date.now()) {
    if (!this.scheduler) return { status: 'skipped' as const }
    const result = await this.scheduler.tick(now)
    if (result.status === 'failed' && this.state.phase !== 'failed') {
      this.state = { ...this.state, phase: 'failed', error: result.code, updatedAt: Date.now() }
      this.deps.log('error', { event: 'REDIS_GLOBAL_BACKUP', phase: 'failed', code: result.code })
    }
    if (result.status !== 'failed') await this.deps.prune?.().catch(() => this.deps.log('warn', { event: 'REDIS_GLOBAL_BACKUP', phase: 'ready', code: 'redis_backup_retention_deferred' }))
    return result
  }

  async status() {
    let shared: RedisGlobalRoutineStatus | undefined
    if (this.state.enabled) {
      try {
        const raw = await (await this.deps.redis()).get(STATUS_KEY)
        if (raw) { shared = JSON.parse(raw); if (shared?.phase === 'running' && Date.now() - shared.updatedAt > 180000) shared = { ...shared, phase: 'interrupted', error: 'redis_backup_interrupted' } }
      } catch { /* Local capability and log remain available when Redis is down. */ }
    }
    return { ...this.state, shared }
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.state.routineActive = false }
}

let routine: RedisGlobalBackupRoutine | undefined
export async function startRedisGlobalBackupRoutine() {
  if (!routine) routine = new RedisGlobalBackupRoutine()
  return routine.start()
}
export async function getRedisGlobalBackupStatus() { return (routine || new RedisGlobalBackupRoutine()).status() }
export function stopRedisGlobalBackupRoutine() { routine?.stop(); routine = undefined }
