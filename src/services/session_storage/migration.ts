import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionStorageCatalog } from './catalog'
import { SessionStorageDescriptor, SessionStorageError, StorageProgress, validateSessionPhone } from './types'

export interface SessionStorageMigrationRuntime {
  owner: string
  getConfig(phone: string): Promise<{ provider?: string; server?: string; autoConnect?: boolean; baseStore: string; sessionStorage?: SessionStorageDescriptor }>
  /** Must block new API/queue work, drain existing writes, then stop without logout. */
  quiesce(phone: string): Promise<void>
  acquireLease(phone: string): Promise<{ assertOwned(): Promise<void>; release(): Promise<unknown> }>
  importData(phone: string, path: string, progress: (value: StorageProgress) => Promise<void>): Promise<{ verified: boolean; nativeRecords: number; compatibilityRecords: number }>
  validate(phone: string, path: string): Promise<boolean>
  /** After durable cutover, verify an encrypted backup and remove only unchanged source keys under the same lease. */
  finalizeSource(phone: string, storage: SessionStorageDescriptor, progress: (value: StorageProgress) => Promise<void>): Promise<{ backupId: string; deleted: number; missing: number; skipped: number }>
}

/** Stable UUID-derived path; public requests cannot supply paths. */
export function migrationPaths(baseStore: string, storageId: string, taskId: string) {
  if (![storageId, taskId].every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) throw new SessionStorageError(400, 'session_storage_path_invalid')
  const root = resolve(baseStore, 'session-storage'), directory = resolve(root, storageId)
  if (!directory.startsWith(root + sep)) throw new SessionStorageError(400, 'session_storage_path_invalid')
  return { directory, staged: join(directory, `migration-${taskId}.sqlite`), final: join(directory, 'session.sqlite') }
}

/** Linux volume durability: persist the final name before the Redis descriptor may point at it. */
export async function syncStorageDirectory(directory: string) {
  if (process.platform !== 'linux') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export class SessionStorageMigration {
  constructor(readonly catalog: SessionStorageCatalog, readonly runtime: SessionStorageMigrationRuntime) {}

  async migrate(phone: string, body: unknown, taskId: string = randomUUID(), progress: (value: StorageProgress) => Promise<void> = async () => {}) {
    validateSessionPhone(phone)
    const input = body as { target?: string; confirm?: boolean }
    if (!input || input.target !== 'sqlite' || input.confirm !== true || Object.keys(input).sort().join(',') !== 'confirm,target') throw new SessionStorageError(400, 'session_storage_confirmation_required')
    const config = await this.runtime.getConfig(phone), old = await this.catalog.read(phone)
    if (config.provider !== 'zapo') throw new SessionStorageError(409, 'session_storage_zapo_required')
    if ((old?.owner || config.server) !== this.runtime.owner) throw new SessionStorageError(409, 'session_storage_wrong_owner')
    if (old?.backend === 'sqlite') throw new SessionStorageError(409, 'session_storage_already_sqlite')
    if (old && !['active', 'offline'].includes(old.state)) throw new SessionStorageError(409, 'session_storage_busy')
    const migrating: SessionStorageDescriptor = { backend: 'redis', storageId: old?.storageId || randomUUID(), owner: this.runtime.owner, generation: (old?.generation || 0) + 1, state: 'migrating', ...(old?.fixture ? { fixture: true } : {}) }
    const paths = migrationPaths(config.baseStore, migrating.storageId, taskId)
    let lease: Awaited<ReturnType<SessionStorageMigrationRuntime['acquireLease']>> | undefined
    let prepared = false
    let promoted = false
    let committed: SessionStorageDescriptor | undefined
    try {
      // The task reservation excludes reload/logout. Close local admission and
      // finish accepted work while its old configuration/socket still works.
      await progress({ phase: 'draining' }); await this.runtime.quiesce(phone)
      const current = await this.runtime.getConfig(phone), descriptor = await this.catalog.read(phone)
      if (JSON.stringify([current.provider, current.server, current.autoConnect, descriptor || null])
        !== JSON.stringify([config.provider, config.server, config.autoConnect, old || null])) throw new SessionStorageError(409, 'session_storage_configuration_changed')
      await this.catalog.compareAndSet(phone, old?.generation || 0, 'redis', migrating, { taskId, autoConnect: false })
      prepared = true
      await this.catalog.journal(phone, taskId, { phase: 'prepared', generation: migrating.generation, storageId: migrating.storageId })
      lease = await this.runtime.acquireLease(phone); await lease.assertOwned()
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      if (await stat(paths.final).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new SessionStorageError(409, 'session_storage_destination_exists')
      await this.catalog.journal(phone, taskId, { phase: 'copying', generation: migrating.generation, storageId: migrating.storageId })
      const counts = await this.runtime.importData(phone, paths.staged, async value => { await lease!.assertOwned(); await progress(value) })
      await lease.assertOwned()
      if (!counts.verified || !await this.runtime.validate(phone, paths.staged)) throw new SessionStorageError(409, 'session_storage_verification_failed')
      // Runtime must close/checkpoint staging handles before returning from importData.
      // Same-volume hard-link promotion fails on EEXIST instead of overwriting another file.
      await link(paths.staged, paths.final); promoted = true
      await unlink(paths.staged)
      await syncStorageDirectory(paths.directory)
      await this.catalog.journal(phone, taskId, { phase: 'file_promoted', generation: migrating.generation, storageId: migrating.storageId })
      await lease.assertOwned()
      const next: SessionStorageDescriptor = { ...migrating, backend: 'sqlite', state: 'offline', generation: migrating.generation + 1 }
      await this.catalog.compareAndSet(phone, migrating.generation, 'redis', next, { expectedTaskId: taskId, autoConnect: false })
      committed = next
      await this.catalog.journal(phone, taskId, { phase: 'committed', generation: next.generation, storageId: next.storageId })
      await lease.assertOwned()
      const sourceCleanup = await this.runtime.finalizeSource(phone, next, async value => { await lease!.assertOwned(); await progress(value) })
      if (sourceCleanup.skipped) throw new SessionStorageError(409, 'session_storage_source_cleanup_diverged')
      await this.catalog.journal(phone, taskId, { phase: 'source_cleaned', generation: next.generation, storageId: next.storageId })
      await progress({ phase: 'ready' })
      return { storage: next, counts, sourceCleanup, backupId: sourceCleanup.backupId, sourcePreserved: false, autoConnect: false }
    } catch (error) {
      // Never guess rollback after a file promotion/CAS response loss. Journal remains for recovery.
      if (prepared && !promoted) {
        const rollback = { ...migrating, state: 'offline' as const, generation: migrating.generation + 1 }
        await this.catalog.compareAndSet(phone, migrating.generation, 'redis', rollback, { expectedTaskId: taskId, autoConnect: false }).catch(() => {})
      }
      if (prepared) await this.catalog.journal(phone, taskId, { phase: committed ? 'source_cleanup_failed' : promoted ? 'recovery_required' : 'failed', generation: committed?.generation || migrating.generation, storageId: migrating.storageId }).catch(() => {})
      throw error instanceof SessionStorageError ? error : new SessionStorageError(503, 'session_storage_migration_failed')
    } finally { await lease?.release().catch(() => {}) }
  }
}
