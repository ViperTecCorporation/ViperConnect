import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { open, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import Redis from 'ioredis'
import { getConfigRedis } from '../config_redis'
import { configs, type Config } from '../config'
import { clients } from '../client'
import { stores } from '../store'
import { dataStores } from '../data_store'
import { getRedis, getSessionPhones } from '../redis'
import { RedisLease } from '../redis_lease'
import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { SessionStorageCatalog } from './catalog'
import { SessionStorageTasks, SessionBackupScheduler } from './tasks'
import { SessionStorageMigration } from './migration'
import { sessionBackupPassword as backupPassword, sessionBackupService as backupService, makeSessionBackup as makeBackup, pruneSessionBackups } from './backup_runtime'
import { captureBackupState, backupPrimaryIdentity } from './backup_capture'
import { backupRetention } from './backup_policy'
import { STORAGE_OPTIONS } from '../../defaults'
import { assertUploadDestination, uploadedBackupService, stageSessionBackupUpload } from './backup_upload'
import { validateLiveIdMappings } from './id_validation'
import { SessionStorageError, type StorageProgress } from './types'
import { restorePreparedSession } from './recovery'
import { requireStorageVolume, storageCapability, storageRoot } from './capability'
import { assertLocalStorageOwner, isSqliteSession, storageOwner } from './routing'
import { sessionStorageRpc } from './rpc'
import { openSessionDatabase, openPreparedSessionDatabase } from './database'
import { migrateCompatibilityRedisToSqlite, migrateNativeRedisToSqlite } from './native_migration'
import { SqliteSessionQueries } from './sqlite_queries'
import { cleanRedisSource, sourceFingerprintsDigest } from './source_cleanup'
import { publishOwnedStorageOffline, reconcileStorageSessionOffline } from './offline_status'
import { migrationResumeIntent, reconnectMigratedSession, type MigrationResumeIntent } from './migrated_connection'
import logger from '../logger'
import { assertProvisionPending, confirmedProvisionReceipt, recordProvisionReceipt } from './provisioning'

const invalidate = (phone: string) => { configs.delete(phone); stores.delete(phone); dataStores.delete(phone) }
const localConfig = (config: Config): Config => isSqliteSession(config) ? { ...config, baseStore: storageRoot() } : config
async function workerConfig(phone: string) { invalidate(phone); return localConfig(await getConfigRedis(phone)) }
const taskKey = (phone: string) => `unoapi-session-storage:current-task:${phone}`
const receiptKey = (phone: string) => `unoapi-session-storage:migration-metrics:${phone}`
let scheduler: SessionBackupScheduler | undefined
let schedulerTimer: NodeJS.Timeout | undefined

async function cleanupSource(phone: string, config: Config, body: { confirm: true; backupId: string; generation: number },
  lease: { key: string; token: string; assertOwned(): Promise<void> }, progress?: (value: StorageProgress) => Promise<void>) {
  const source = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, commandTimeout: 30000 })
  try {
    const database = openSessionDatabase(phone, config), service = await backupService(phone, config)
    return await cleanRedisSource({ redis: source, database, phone, storage: config.sessionStorage!, prefix: resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX), body,
      lease, progress, verifyBackup: async (manifest, expected) => {
        const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'viper-source-verify-'))
        try {
          const path = join(directory, 'backup.sqlite')
          await service.restore({ phone, backupId: manifest.id, password: backupPassword(), stagedPath: path })
          const restored = openPreparedSessionDatabase(path)
          try { return sourceFingerprintsDigest(restored) === expected } finally { restored.close() }
        } finally { if (directory.startsWith(parent + sep)) await rm(directory, { recursive: true, force: true }) }
      },
    })
  } finally { source.disconnect() }
}

async function startOperation(phone: string, operation: 'migration' | 'backup' | 'restore' | 'source-cleanup', run: (id: string, progress: any) => Promise<unknown>) {
  const redis = await getRedis(), tasks = new SessionStorageTasks(redis)
  const task = await tasks.start(phone, operation, run)
  await redis.set(taskKey(phone), task.id, { EX: 604800 })
  return task
}

async function migrate(phone: string, body: unknown) {
  requireStorageVolume()
  if (!(await workerConfig(phone)).useS3) throw new SessionStorageError(409, 'session_storage_backup_requires_s3')
  const redis = await getRedis(), catalog = new SessionStorageCatalog(redis), startedAt = Date.now()
  return startOperation(phone, 'migration', async (id, progress) => {
    const { snapshotStorageMetrics } = await import('./metrics.js')
    const before = await snapshotStorageMetrics(phone, await workerConfig(phone), { redis })
    let ioredis: Redis | undefined
    let resumeIntent: MigrationResumeIntent = { eligible: false, fixture: false }
    let capturedIntent = false
    let cleanupLease: { key: string; token: string; assertOwned(): Promise<void> } | undefined
    try {
      const migration = new SessionStorageMigration(catalog, {
        owner: storageOwner(),
        getConfig: async value => {
          const current = await workerConfig(value)
          if (!capturedIntent) {
            resumeIntent = migrationResumeIntent(current, await redis.get(`unoapi-status:${value}`), clients.has(value))
            capturedIntent = true
          }
          return { ...current, baseStore: storageRoot() }
        },
        quiesce: async value => {
          const { beginSessionStorageQuiesce, waitSessionStorageIdle } = await import('./activity.js')
          beginSessionStorageQuiesce(value)
          await waitSessionStorageIdle(value)
          const client = clients.get(value) as any
          if (client) {
            if (typeof client.pauseForStorageMigration !== 'function') throw new SessionStorageError(409, 'session_storage_disconnect_and_drain_required')
            await client.pauseForStorageMigration()
          }
          await waitSessionStorageIdle(value)
          invalidate(value)
        },
        acquireLease: async value => {
          const lease = new RedisLease(`zapo-session:${value}`, 120000)
          if (!await lease.acquire()) throw new SessionStorageError(409, 'session_storage_waiting_disconnect')
          try {
            const paused = await catalog.read(value)
            if (clients.has(value) || paused?.state !== 'migrating' || !await publishOwnedStorageOffline(redis, value, paused, lease.ownership(), { taskId: id })) {
              throw new SessionStorageError(409, 'session_storage_offline_unconfirmed')
            }
          } catch (error) { await lease.release().catch(() => {}); throw error }
          let lost = false
          const timer = setInterval(() => { void lease.renew().then(ok => { if (!ok) lost = true }, () => { lost = true }) }, 15000); timer.unref?.()
          cleanupLease = { ...lease.ownership(), assertOwned: async () => { if (lost || !await lease.renew()) throw new SessionStorageError(409, 'session_storage_lease_lost') } }
          return { assertOwned: cleanupLease.assertOwned, release: async () => { clearInterval(timer); return lease.release() } }
        },
        importData: async (value, path, update) => {
          const file = await open(path, 'wx', 0o600); await file.close()
          ioredis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, commandTimeout: 30000 })
          const notify = async (p: any) => update({ phase: p.phase, processed: p.records })
          const compatibility = await migrateCompatibilityRedisToSqlite(ioredis, value, path, notify)
          const native = await migrateNativeRedisToSqlite(ioredis, value, resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX), path, notify)
          const db = openPreparedSessionDatabase(path)
          try { db.run('INSERT OR REPLACE INTO uno_storage_meta(key,value) VALUES(?,?)', ['phone', value]); db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { db.close() }
          return { verified: true, nativeRecords: native.records, compatibilityRecords: compatibility.records }
        },
        validate: async (value, path) => {
          const db = openPreparedSessionDatabase(path)
          try {
            const check = db.get<any>('PRAGMA quick_check')
            if (check?.quick_check !== 'ok') return false
            const bad = db.get<any>(`SELECT COUNT(*) n FROM mailbox_messages m JOIN uno_kv k ON k.key=?||m.message_id||':message_bytes' WHERE m.session_id=? AND m.message_bytes!=k.value`, [`${resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX)}msg:${value}:`, value])
            return !bad?.n
          } finally { db.close() }
        },
        finalizeSource: async (value, storage, update) => {
          if (!cleanupLease) throw new SessionStorageError(409, 'session_storage_cleanup_lease_required')
          await cleanupLease.assertOwned()
          const current = await workerConfig(value)
          if (clients.has(value) || current.sessionStorage?.storageId !== storage.storageId || current.sessionStorage.generation !== storage.generation) throw new SessionStorageError(409, 'session_storage_configuration_changed')
          await update({ phase: 'backup' })
          const backup = await makeBackup(value, current)
          await update({ phase: 'source_cleanup' })
          const cleanup = await cleanupSource(value, current, { confirm: true, backupId: backup.id, generation: storage.generation }, cleanupLease, update)
          return { ...cleanup, backupId: backup.id }
        },
      })
      const result = await migration.migrate(phone, body, id, progress)
      invalidate(phone)
      const reconnect = await reconnectMigratedSession(phone, result.storage, resumeIntent, {
        redis, hasClient: () => clients.has(phone), dispatch: async value => {
          const { ReloadAmqp } = await import('../reload_amqp.js')
          await new ReloadAmqp(workerConfig).run(value)
        },
      })
      const after = await snapshotStorageMetrics(phone, await workerConfig(phone))
      await redis.set(receiptKey(phone), JSON.stringify({ startedAt, durationMs: Date.now() - startedAt, before, after, sourcePreserved: result.sourcePreserved, sourceCleanup: result.sourceCleanup, backupId: result.backupId }))
      return { ...result, ...reconnect }
    } finally {
      ioredis?.disconnect()
      ;(await import('./activity.js')).endSessionStorageQuiesce(phone)
    }
  })
}

async function provision(phone: string, _config: Config, args: any[]) {
  const id = args[0]?.provisionId, owner = storageOwner(), redis = await getRedis()
  if (args.length !== 1 || Object.keys(args[0] || {}).join(',') !== 'provisionId') throw new SessionStorageError(400, 'session_storage_provision_changed')
  const read = async () => { const raw = await redis.get(`unoapi-config:${phone}`); if (!raw) throw new SessionStorageError(409, 'session_storage_provision_changed'); return { raw, config: JSON.parse(raw) as Config } }
  let current = await read()
  if (!current.config.sessionStorageProvisionPending) {
    const receipt = confirmedProvisionReceipt(current.config, id, owner)
    return { backend: receipt.backend, receipt, capability: storageCapability() }
  }
  assertProvisionPending(current.config, id, owner)
  const taskKey = `unoapi-session-storage:task:lock:${phone}`, token = randomUUID()
  if (await redis.set(taskKey, token, { NX: true, PX: 120000 }) !== 'OK') throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  const lease = new RedisLease(`zapo-session:${phone}`, 120000)
  try {
    if (clients.has(phone) || !await lease.acquire()) throw new SessionStorageError(409, 'session_storage_provision_session_in_use')
    current = await read(); assertProvisionPending(current.config, id, owner)
    const capability = storageCapability(), storage = current.config.sessionStorage
    if (storage && storage.backend !== 'sqlite') throw new SessionStorageError(409, 'session_storage_provision_changed')
    if (storage) {
      assertLocalStorageOwner(current.config)
      openSessionDatabase(phone, { ...current.config, baseStore: storageRoot() })
      const receipt = await recordProvisionReceipt(phone, current.raw, { id, backend: 'sqlite', owner, generation: storage.generation, storageId: storage.storageId })
      invalidate(phone); return { backend: receipt.backend, receipt, capability }
    }
    if (capability.defaultBackend !== 'sqlite') {
      const receipt = await recordProvisionReceipt(phone, current.raw, { id, backend: 'redis', owner, generation: 0 })
      invalidate(phone); return { backend: receipt.backend, receipt, capability }
    }
    requireStorageVolume()
    // Stable per-attempt identity reuses a prepared file after a crash/lost CAS
    // response, instead of allocating an unreferenced UUID on every retry.
    const descriptor = { backend: 'sqlite' as const, storageId: id, owner, generation: 1, state: 'offline' as const }
    const prepared = { ...current.config, baseStore: storageRoot(), sessionStorage: descriptor }
    const db = openSessionDatabase(phone, prepared, { create: true }); db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    if (!await lease.renew()) throw new SessionStorageError(409, 'session_storage_lease_lost')
    await new SessionStorageCatalog(redis).compareAndSet(phone, 0, 'redis', descriptor, { provisionId: id })
    const committed = await read(), receipt = confirmedProvisionReceipt(committed.config, id, owner)
    invalidate(phone)
    return { backend: receipt.backend, receipt, capability }
  } finally {
    await lease.release().catch(() => {})
    await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('DEL',KEYS[1])", { keys: [taskKey], arguments: [token] })
  }
}

export async function executeStorageOperation(phone: string, supplied: Config, operation: string, args: any[]) {
  const config = localConfig(supplied), redis = await getRedis()
  if (operation === 'status') {
    const id = await redis.get(taskKey(phone)), task = id ? await new SessionStorageTasks(redis).status(phone, id).catch(() => undefined) : undefined
    const last = await redis.get(`unoapi-session-storage:last-backup:${phone}`)
    const capability = storageCapability(), location = STORAGE_OPTIONS((config as any).storage)
    const connectionStatus = await redis.get(`unoapi-status:${phone}`) || 'disconnected'
    const receipt = JSON.parse(await redis.get(`unoapi-session-storage:coordinator:${phone}`) || 'null')
    const coordinator = receipt?.storageId === config.sessionStorage?.storageId && receipt?.generation === config.sessionStorage?.generation && receipt?.owner === config.sessionStorage?.owner ? receipt : undefined
    return { backend: config.sessionStorage?.backend || 'redis', owner: config.sessionStorage?.owner || config.server, generation: config.sessionStorage?.generation || 0,
      autoConnect: config.autoConnect === true, connectionStatus,
      restoreUpload: { available: !!(config.useS3 && capability.sqliteAvailable && config.autoConnect === false && !clients.has(phone)
        && !config.mobilePrimaryDeleting && !config.sessionStorageUnlinked && ['offline', 'disconnected'].includes(connectionStatus)
        && config.sessionStorage?.backend === 'sqlite' && config.sessionStorage.state === 'offline' && task?.status !== 'running') },
      state: config.sessionStorage?.state || 'active', fixture: !!config.sessionStorage?.fixture, capability, currentTask: task,
      backupPolicy: { enabled: process.env.SESSION_STORAGE_BACKUP_ENABLED === 'true', intervalHours: 12, destination: 's3', protection: 'none', retention: backupRetention(),
        location: config.useS3 ? { bucket: location.bucket, prefix: `backups/session-storage/${phone}/`, ...(backupRetention().strategy === 'weekday-slots' ? { slotsPrefix: `backups/session-storage/${phone}/slots/` } : {}) } : undefined,
        schedule: await new SessionStorageCatalog(redis).backupScheduleStatus(phone) },
      maintenance: coordinator?.maintenance, recovery: coordinator?.reconciliation,
      lastBackup: last ? (({ id, createdAt, bytes, objectKey, protection }: any) => ({ id, createdAt, bytes, objectKey,
        protection: protection === 'none' ? 'none' : 'aes-256-gcm', status: 'ready' }))(JSON.parse(last)) : undefined }
  }
  if (operation === 'metrics') return { ...await (await import('./metrics.js')).getStorageMetrics(phone, config, { redis }), migration: JSON.parse(await redis.get(receiptKey(phone)) || 'null') }
  if (operation === 'explore') {
    await (await import('./write_fence.js')).assertFreshSqliteWriteSelection(phone, config)
    return (await import('./explorer.js')).exploreSessionDatabase(phone, config, args[0])
  }
  if (operation === 'mutate') return (await import('./explorer_mutations.js')).executeExplorerMutation(phone, config, args[0])
  if (operation === 'reconcile-status') {
    assertLocalStorageOwner(config)
    if (!isSqliteSession(config)) throw new SessionStorageError(409, 'session_storage_sqlite_required')
    if (args.length !== 1 || args[0]?.confirm !== true || Object.keys(args[0]).join(',') !== 'confirm') throw new SessionStorageError(400, 'session_storage_confirmation_required')
    const changed = await reconcileStorageSessionOffline(phone, config, { redis, hasClient: () => clients.has(phone), lease: () => new RedisLease(`zapo-session:${phone}`, 15000) })
    return { changed, status: await redis.get(`unoapi-status:${phone}`) || 'disconnected' }
  }
  if (operation === 'provision') return provision(phone, config, args)
  if (operation === 'migrate') return migrate(phone, args[0])
  if (operation === 'task') return new SessionStorageTasks(redis).status(phone, args[0])
  if (operation === 'backup') return startOperation(phone, 'backup', () => makeBackup(phone, config))
  if (operation === 'source-cleanup') {
    assertLocalStorageOwner(config); requireStorageVolume()
    if (!isSqliteSession(config) || clients.has(phone)) throw new SessionStorageError(409, 'session_storage_cleanup_requires_offline')
    return startOperation(phone, 'source-cleanup', async (_task, progress) => {
      const lease = new RedisLease(`zapo-session:${phone}`, 120000)
      if (!await lease.acquire()) throw new SessionStorageError(409, 'session_storage_waiting_disconnect')
      const own = lease.ownership()
      try {
        return await cleanupSource(phone, config, args[0], { ...own, assertOwned: async () => { if (!await lease.renew()) throw new SessionStorageError(409, 'session_storage_lease_lost') } }, progress)
      } finally { await lease.release() }
    })
  }
  if (operation === 'restore-upload-check') {
    assertLocalStorageOwner(config); requireStorageVolume(); assertUploadDestination(config, clients.has(phone))
    return { allowed: true }
  }
  if (operation === 'restore' || operation === 'restore-upload') {
    requireStorageVolume()
    if (clients.has(phone)) throw new SessionStorageError(409, 'session_storage_restore_requires_offline')
    if (operation === 'restore-upload') {
      assertLocalStorageOwner(config); assertUploadDestination(config, clients.has(phone))
      if (args.length !== 1 || Object.keys(args[0] || {}).join(',') !== 'uploadId') throw new SessionStorageError(400, 'session_storage_upload_invalid')
    }
    return startOperation(phone, 'restore', async (taskId, progress) => {
      const uploaded = operation === 'restore-upload' ? await uploadedBackupService(phone, args[0].uploadId, config, backupPassword()) : undefined
      const result = await restorePreparedSession(new SessionStorageCatalog(redis), {
      owner: storageOwner(), getConfig: async () => ({ ...await workerConfig(phone), baseStore: storageRoot() }),
      isOffline: async () => !clients.has(phone), sourceIsEmpty: async () => false,
      acquireLease: async () => {
        const lease = new RedisLease(`zapo-session:${phone}`, 120000)
        if (!await lease.acquire()) throw new SessionStorageError(409, 'session_storage_waiting_disconnect')
        let lost = false
        const timer = setInterval(() => { void lease.renew().then(ok => { if (!ok) lost = true }, () => { lost = true }) }, 15000); timer.unref?.()
        return { assertOwned: async () => { if (lost || !await lease.renew()) throw new SessionStorageError(409, 'session_storage_lease_lost') }, release: async () => { clearInterval(timer); return lease.release() } }
      },
      restoreArchive: async (_phone, backupId, stagedPath) => (uploaded?.service || await backupService(phone, config)).restore({ phone, backupId, password: backupPassword(), stagedPath }),
      validate: async (_phone, path, archive) => {
        const db = openPreparedSessionDatabase(path)
        try {
          const identity = db.get<any>('SELECT value FROM uno_storage_meta WHERE key=?', ['phone'])?.value === phone
          if (config.mobilePrimaryDraftId) {
            const primary = await captureBackupState(phone, await workerConfig(phone), redis, process.env.MOBILE_REGISTRATION_KEY || '')
            if (!isDeepStrictEqual(backupPrimaryIdentity(primary.primary), backupPrimaryIdentity(archive.supplement))) throw new SessionStorageError(409, 'session_storage_primary_state_changed')
          }
          const ids = validateLiveIdMappings(db, phone)
          const check = db.get<any>('PRAGMA quick_check'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
          return { identity, ids: ids && check?.quick_check === 'ok' }
        } finally { db.close() }
      },
      }, phone, uploaded ? { backupId: uploaded.manifest.id, confirm: true, mode: 'offline' } : args[0], taskId, progress)
      invalidate(phone)
      await uploaded?.remove().catch(() => logger.warn({ code: 'session_storage_upload_cleanup_deferred' }, 'Expired upload cleanup will retry'))
      return result
    })
  }
  if (operation.startsWith('query.')) {
    assertLocalStorageOwner(config)
    const queries = new SqliteSessionQueries(phone, config)
    if (operation === 'query.conversations') return queries.conversations(args[0])
    if (operation === 'query.messages') return queries.messages(args[0], args[1])
    if (operation === 'query.contacts') return queries.contacts(args[0])
    if (operation === 'query.contact') return (await import('./contacts_gateway.js')).queryLocalSessionContact(phone, config, args[0])
    if (operation === 'query.contact-sync') return (await import('./contact_sync_query.js')).queryLocalContactSyncPage(phone, config, args[0])
    if (operation === 'query.statuses') return (await import('./status_projection.js')).applySqliteStatuses(phone, config, args[0])
    if (operation === 'query.events') return (await import('./status_projection.js')).applySqliteMessageEvent(phone, config, args[0], args[1])
    if (operation === 'query.record') return queries.record(args[0])
    if (operation === 'query.media') return (await import('./owner_sqlite_media.js')).prepareSqliteSessionMedia(phone, config, args[0])
  }
  if (operation.startsWith('compat.')) return (await import('./compat_redirect.js')).executeCompatibilityValue(phone, config, operation.slice(7), args[0], args[1], args[2])
  if (operation === 'state.commands') return (await import('./state_commands.js')).executeSessionStateCommands(phone, config, args[0])
  if (operation === 'primary.auth.unlink') return (await import('./primary_unlink.js')).unlinkSqlitePrimary(phone, config, args[0], args[1])
  if (operation === 'primary.auth.load' || operation === 'primary.auth.save') {
    const { executePrimaryAuth } = await import('./primary_auth_rpc.js')
    return executePrimaryAuth(phone, config, operation, args)
  }
  throw new SessionStorageError(400, 'session_storage_invalid_operation')
}

export const sessionStorageGateway = Object.fromEntries(['status', 'metrics', 'explore', 'mutate', 'migrate', 'task', 'backup', 'restore', 'sourceCleanup'].map(method => [method,
  async (phone: string, ...args: unknown[]) => {
    // Task receipts are shared control-plane records, not worker-local data.
    // Polling must survive the migration's own generation change or owner downtime.
    if (method === 'task') return new SessionStorageTasks(await getRedis()).status(phone, args[0] as string)
    invalidate(phone)
    const config = await getConfigRedis(phone)
    try { return await sessionStorageRpc(phone, config, method === 'sourceCleanup' ? 'source-cleanup' : method, args) }
    catch (error) { throw new SessionStorageError((error as any).code || 503, (error as any).title || 'session_storage_unavailable') }
  },
])) as any
sessionStorageGateway.restoreUpload = async (...args: Parameters<typeof stageSessionBackupUpload>) => {
  try { return await stageSessionBackupUpload(...args) }
  catch (error: any) {
    if (error instanceof SessionStorageError) throw error
    throw new SessionStorageError(typeof error?.code === 'number' ? error.code : 503, /^session_storage_[a-z0-9_]+$/.test(error?.title || '') ? error.title : 'session_storage_upload_unavailable')
  }
}

export async function startStorageBackupScheduler() {
  if (schedulerTimer || process.env.SESSION_STORAGE_BACKUP_ENABLED !== 'true') return
  requireStorageVolume()
  scheduler = new SessionBackupScheduler(new SessionStorageCatalog(await getRedis()), {
    sessions: async () => { const phones = await getSessionPhones(); const selected: string[] = []; for (const phone of phones) { const c = await workerConfig(phone); if (isSqliteSession(c) && c.sessionStorage?.owner === storageOwner() && !c.sessionStorage.fixture) selected.push(phone) }; return selected },
    backup: async phone => { await makeBackup(phone, await workerConfig(phone)) },
  })
  let running = false
  const tick = () => { if (running) return; running = true; void scheduler!.tick().then(async result => {
    if (result.failed) logger.warn({ code: 'session_storage_scheduled_backup_failed', failed: result.failed }, 'Session S3 backup failed; retry remains available in the current window')
    for (const phone of await getSessionPhones()) {
      const config = await workerConfig(phone)
      if (isSqliteSession(config) && config.sessionStorage?.owner === storageOwner() && !config.sessionStorage.fixture) {
        await pruneSessionBackups(phone, config).catch(error => logger.warn({ code: error instanceof SessionStorageError ? error.code : 'session_storage_backup_rotation_failed' }, 'Session backup retention deferred'))
      }
    }
  }).catch(() => logger.error({ code: 'session_storage_backup_scheduler_failed' }, 'Session S3 backup scheduler failed')).finally(() => { running = false }) }
  schedulerTimer = setInterval(tick, 60000); schedulerTimer.unref?.()
  tick()
}
