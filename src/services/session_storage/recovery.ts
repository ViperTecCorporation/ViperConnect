import { randomUUID } from 'node:crypto'
import { link, mkdir, unlink } from 'node:fs/promises'
import type { SqliteBackupManifest } from './backup'
import { SessionStorageCatalog } from './catalog'
import { migrationPaths, syncStorageDirectory } from './migration'
import { SessionStorageDescriptor, SessionStorageError, StorageProgress, validateSessionPhone } from './types'

interface RecoveryConfig {
  provider?: string; server?: string; baseStore: string; autoConnect?: boolean
  sessionStorage?: SessionStorageDescriptor
}
export interface SessionRecoveryHooks {
  owner: string
  getConfig(phone: string): Promise<RecoveryConfig>
  isOffline(phone: string): Promise<boolean>
  /** An existing Redis destination must contain no per-session data; never silently merge. */
  sourceIsEmpty(phone: string): Promise<boolean>
  acquireLease(phone: string): Promise<{ assertOwned(): Promise<void>; release(): Promise<unknown> }>
  restoreArchive(phone: string, backupId: string, stagedPath: string): Promise<{ manifest: SqliteBackupManifest; supplement: Record<string, unknown> }>
  /** Verify SDK identity and both Uno/provider ID directions; close/checkpoint all staging handles. */
  validate(phone: string, stagedPath: string, archive: { manifest: SqliteBackupManifest; supplement: Record<string, unknown> }): Promise<{ identity: boolean; ids: boolean }>
}

/** Restores into a new UUID directory; the previous database and source Redis are never deleted. */
export async function restorePreparedSession(catalog: SessionStorageCatalog, hooks: SessionRecoveryHooks, phone: string, body: unknown,
  taskId: string = randomUUID(), progress: (value: StorageProgress) => Promise<void> = async () => {}) {
  validateSessionPhone(phone)
  const input = body as { backupId?: string; confirm?: boolean; mode?: string }
  if (!input || input.confirm !== true || input.mode !== 'offline' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.backupId || '')
    || Object.keys(input).sort().join(',') !== 'backupId,confirm,mode') throw new SessionStorageError(400, 'session_storage_restore_confirmation_required')
  const config = await hooks.getConfig(phone), old = await catalog.read(phone)
  if (config.provider !== 'zapo') throw new SessionStorageError(409, 'session_storage_zapo_required')
  if ((old?.owner || config.server) !== hooks.owner) throw new SessionStorageError(409, 'session_storage_wrong_owner')
  if (config.autoConnect !== false || old && old.state !== 'offline' || !await hooks.isOffline(phone)) throw new SessionStorageError(409, 'session_storage_restore_requires_offline')
  const backend = old?.backend || 'redis'
  if (backend === 'redis' && !await hooks.sourceIsEmpty(phone)) throw new SessionStorageError(409, 'session_storage_restore_destination_exists')
  const storageId = randomUUID(), paths = migrationPaths(config.baseStore, storageId, taskId)
  const preparing: SessionStorageDescriptor = { backend, storageId: old?.storageId || storageId, owner: hooks.owner,
    generation: (old?.generation || 0) + 1, state: 'restoring', ...(old?.fixture ? { fixture: true } : {}) }
  await catalog.compareAndSet(phone, old?.generation || 0, backend, preparing, { taskId, autoConnect: false })
  let lease: Awaited<ReturnType<SessionRecoveryHooks['acquireLease']>> | undefined, promoted = false
  try {
    await catalog.journal(phone, taskId, { phase: 'restore_prepared', generation: preparing.generation, storageId })
    lease = await hooks.acquireLease(phone); await lease.assertOwned()
    if (!await hooks.isOffline(phone) || backend === 'redis' && !await hooks.sourceIsEmpty(phone)) throw new SessionStorageError(409, 'session_storage_restore_destination_exists')
    await mkdir(paths.directory, { recursive: true, mode: 0o700 }); await progress({ phase: 'restoring' })
    const archive = await hooks.restoreArchive(phone, input.backupId!, paths.staged)
    if (archive.manifest.phone !== phone || archive.manifest.id !== input.backupId || archive.manifest.status !== 'ready') throw new SessionStorageError(409, 'session_storage_backup_identity_mismatch')
    await lease.assertOwned(); await progress({ phase: 'validating' })
    const verified = await hooks.validate(phone, paths.staged, archive)
    if (!verified.identity || !verified.ids) throw new SessionStorageError(409, 'session_storage_restore_verification_failed')
    await lease.assertOwned()
    await link(paths.staged, paths.final); promoted = true; await unlink(paths.staged)
    await syncStorageDirectory(paths.directory)
    await catalog.journal(phone, taskId, { phase: 'restore_file_promoted', generation: preparing.generation, storageId })
    await lease.assertOwned()
    const storage: SessionStorageDescriptor = { ...preparing, backend: 'sqlite', storageId, generation: preparing.generation + 1, state: 'offline' }
    await catalog.compareAndSet(phone, preparing.generation, backend, storage, { expectedTaskId: taskId, autoConnect: false })
    await catalog.journal(phone, taskId, { phase: 'restore_committed', generation: storage.generation, storageId })
    return { restored: true, storage, autoConnect: false, previousStoragePreserved: true, backupId: input.backupId }
  } catch (error) {
    if (!promoted) await catalog.compareAndSet(phone, preparing.generation, backend, { ...preparing, generation: preparing.generation + 1, state: 'offline' }, { expectedTaskId: taskId, autoConnect: false }).catch(() => {})
    await catalog.journal(phone, taskId, { phase: promoted ? 'restore_recovery_required' : 'restore_failed', generation: preparing.generation, storageId }).catch(() => {})
    throw error instanceof SessionStorageError ? error : new SessionStorageError(503, 'session_storage_restore_failed')
  } finally { await lease?.release().catch(() => {}) }
}
