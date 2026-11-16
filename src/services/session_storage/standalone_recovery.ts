import { randomUUID } from 'node:crypto'
import { lstat, link, mkdir, open, rmdir, unlink } from 'node:fs/promises'
import { resolve, parse, relative, sep, isAbsolute } from 'node:path'
import { SessionSqliteBackups, type SqliteBackupManifest } from './backup'
import type { BackupObjects } from './backup_objects'
import { backupWeekday, validateWeeklyManifest } from './backup_slots'
import { migrationPaths, syncStorageDirectory } from './migration'
import { validateStandaloneState } from './standalone_validation'
import { COMMIT_STANDALONE_RESTORE_LUA, RESERVE_STANDALONE_RESTORE_LUA } from './standalone_catalog'
import { SessionStorageError, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export interface StandaloneRestoreInput { phone: string; backupId?: string; weekday?: number; confirm: true; confirmOriginOffline: true }
export interface StandaloneRestoreDependencies {
  objects: BackupObjects; redis: SessionStorageRedis; baseStore: string; owner: string; password?: string; registrationKey?: string
  lease(phone: string): { acquire(): Promise<boolean>; assertOwned(): Promise<void>; release(): Promise<unknown>; ownership(): { key: string; token: string } }
  destinationEmpty(phone: string, ownedKeys: string[]): Promise<boolean>
  now?(): number
}
export class StandaloneRestoreError extends SessionStorageError {
  constructor(code: string, readonly recovery: { operationId: string; storageId: string; backupId?: string }) { super(503, code) }
}

/** Sidecar/slot lookup does not consult or reconstruct any Redis backup index. */
export async function standaloneBackupManifest(input: StandaloneRestoreInput, objects: BackupObjects): Promise<SqliteBackupManifest> {
  validateSessionPhone(input.phone)
  if (input.confirm !== true || input.confirmOriginOffline !== true || (input.backupId === undefined) === (input.weekday === undefined)
    || input.backupId !== undefined && !UUID.test(input.backupId) || input.weekday !== undefined && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) throw new SessionStorageError(400, 'session_storage_standalone_confirmation_required')
  const prefix = `backups/session-storage/${input.phone}/`
  const record = await objects.json(input.backupId ? `${prefix}${input.backupId}.viperstorage.manifest.json` : `${prefix}slots/${input.weekday}.json`)
  if (!record) throw new SessionStorageError(404, 'session_storage_backup_not_found')
  const value: any = record.value, manifest = input.backupId ? value : value?.manifest
  validateWeeklyManifest(manifest, { kind: 'session-storage', id: input.phone })
  if (input.backupId ? manifest.id !== input.backupId : value.version !== 1 || value.day !== input.weekday || typeof value.timeZone !== 'string' || backupWeekday(manifest.createdAt, value.timeZone) !== input.weekday) throw new SessionStorageError(409, 'session_storage_backup_pointer_invalid')
  return manifest as SqliteBackupManifest
}

async function prepareDirectory(base: string, storageId: string, taskId: string) {
  const root = resolve(base), paths = migrationPaths(root, storageId, taskId), rel = relative(root, paths.directory)
  if (root === parse(root).root || isAbsolute(rel) || rel.split(sep).includes('..')) throw new SessionStorageError(409, 'session_storage_standalone_volume_invalid')
  const parent = resolve(root, 'session-storage')
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SessionStorageError(409, 'session_storage_standalone_volume_invalid')
  const oldParent = await lstat(parent).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (oldParent && (!oldParent.isDirectory() || oldParent.isSymbolicLink())) throw new SessionStorageError(409, 'session_storage_standalone_volume_invalid')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  // No recursive overwrite/reuse: this UUID directory belongs only to this invocation.
  await mkdir(paths.directory, { mode: 0o700 })
  return paths
}

/** Disaster recovery into an absent session only. Never calls connect, a queue publisher or Redis RESTORE. */
export async function restoreStandaloneSession(input: StandaloneRestoreInput, deps: StandaloneRestoreDependencies) {
  const manifest = await standaloneBackupManifest(input, deps.objects)
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(deps.owner)) throw new SessionStorageError(409, 'session_storage_standalone_configuration_invalid')
  const operationId = randomUUID(), storageId = randomUUID(), phone = input.phone
  const storage = { backend: 'sqlite' as const, storageId, owner: deps.owner, generation: manifest.generation + 1, state: 'offline' as const }
  validateStorageDescriptor(storage)
  const configKey = `unoapi-config:${phone}`, taskLock = `unoapi-session-storage:task:lock:${phone}`, receipt = `unoapi-session-storage:standalone-restore:${phone}:${operationId}`
  const rotationLock = `unoapi-backup-rotation:session-storage:${phone}`, lease = deps.lease(phone)
  if (!await lease.acquire()) throw new SessionStorageError(409, 'session_storage_waiting_disconnect')
  let paths: Awaited<ReturnType<typeof prepareDirectory>> | undefined, promoted = false, reserved = false, heartbeat: NodeJS.Timeout | undefined
  let heartbeatTail = Promise.resolve(), lost = false
  const ownership = lease.ownership()
  const info = { operationId, storageId, backupId: manifest.id }
  const journal = (phase: string) => JSON.stringify({ ...info, phone, phase, at: deps.now?.() ?? Date.now(), autoConnect: false })
  const owned = async () => {
    if (lost) throw new SessionStorageError(409, 'session_storage_lease_lost')
    await lease.assertOwned()
    if (reserved && Number(await deps.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],120000); return 1", { keys: [taskLock], arguments: [ownership.token] })) !== 1) throw new SessionStorageError(409, 'session_storage_lease_lost')
  }
  try {
    if (ownership.key !== `unoapi-lease:zapo-session:${phone}` || !UUID.test(ownership.token)) throw new SessionStorageError(409, 'session_storage_standalone_lease_invalid')
    await owned()
    if (!await deps.destinationEmpty(phone, [ownership.key])) throw new SessionStorageError(409, 'session_storage_standalone_destination_exists')
    const reservation = await deps.redis.eval(RESERVE_STANDALONE_RESTORE_LUA, { keys: [configKey, ownership.key, taskLock, rotationLock, receipt], arguments: [ownership.token, journal('downloading')] })
    if (Number(reservation) !== 1) throw new SessionStorageError(409, 'session_storage_standalone_destination_exists')
    reserved = true
    heartbeat = setInterval(() => { heartbeatTail = heartbeatTail.then(owned).catch(() => { lost = true }) }, 30000); heartbeat.unref?.()
    paths = await prepareDirectory(deps.baseStore, storageId, operationId)
    const archive = await new SessionSqliteBackups(deps.objects, { put: async () => undefined, get: async () => undefined }).restoreStandalone({ phone, manifest, password: deps.password, stagedPath: paths.staged })
    const validated = await validateStandaloneState(phone, paths.staged, manifest, archive.supplement, deps.registrationKey, deps.now?.() ?? Date.now())
    const source = validated.configuration
    if (source.sessionStorage?.fixture === true) (storage as any).fixture = true
    const configuration: Record<string, any> = { ...source, provider: 'zapo', server: deps.owner, baseStore: resolve(deps.baseStore), useRedis: true, useS3: true,
      autoConnect: false, markOnlineOnConnect: false, sendConnectionStatus: false, notifyFailedMessages: false,
      overrideWebhooks: true,
      sessionStorage: storage, webhooks: Array.isArray(source.webhooks) ? source.webhooks.map((hook: any) => ({ ...hook, enabled: false, disabled: true })) : [],
      webhookForward: { ...(source.webhookForward || {}), url: '' }, sessionWebhook: '', rejectCallsWebhook: '', messageCallsWebhook: '' }
    for (const key of ['sessionStorageTaskId', 'sessionTransferBackupId', 'sessionTransferDeleting', 'mobilePrimaryDeleting']) delete configuration[key]
    if (!validated.draft) { delete configuration.mobilePrimaryDraftId; delete configuration.mobilePrimaryImported }
    await owned()
    for (const identityPhone of validated.identityPhones) if (!await deps.destinationEmpty(identityPhone, [ownership.key, taskLock, receipt])) throw new SessionStorageError(409, 'session_storage_standalone_destination_exists')
    const file = await open(paths.staged, 'r+'); try { await file.sync() } finally { await file.close() }
    await link(paths.staged, paths.final); promoted = true; await unlink(paths.staged); await syncStorageDirectory(paths.directory)
    await owned()
    if (Number(await deps.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1", { keys: [taskLock, receipt], arguments: [ownership.token, journal('file_promoted')] })) !== 1) throw new StandaloneRestoreError('session_storage_standalone_recovery_required', info)
    const draftId = validated.draft?.id || operationId
    const committed = await deps.redis.eval(COMMIT_STANDALONE_RESTORE_LUA, {
      keys: [configKey, ownership.key, taskLock, 'unoapi-sessions:index', `unoapi-status:${phone}`, 'mobile-primary:{v1}:drafts',
        `mobile-primary:{v1}:registration:${draftId}`, `mobile-primary:{v1}:companions:${draftId}`, `mobile-primary:{v1}:companion-operation:${draftId}`, 'unoapi-config:auth-token-index', receipt,
        ...validated.identityPhones.filter(value => value !== phone).flatMap(value => [`unoapi-config:${value}`, `unoapi-status:${value}`, `unoapi-lease:zapo-session:${value}`])],
      arguments: [ownership.token, phone, JSON.stringify(configuration), validated.draft ? JSON.stringify(validated.draft) : '', validated.registrationEnvelope || '', validated.companionEnvelope || '', typeof source.authToken === 'string' ? source.authToken : '', journal('committed')],
    })
    if (Number(committed) !== 1) throw new StandaloneRestoreError('session_storage_standalone_recovery_required', info)
    return { restored: true, phone, storage, backupId: manifest.id, operationId, autoConnect: false as const, status: 'offline' as const, webhooksEnabled: false as const, connected: false as const, replayed: false as const, handsetValidated: false as const }
  } catch (error) {
    if (promoted) throw error instanceof StandaloneRestoreError ? error : new StandaloneRestoreError('session_storage_standalone_recovery_required', info)
    if (paths) {
      try { for (const suffix of ['', '-wal', '-shm']) await unlink(paths.staged + suffix).catch(error => { if (error.code !== 'ENOENT') throw error }); await rmdir(paths.directory) }
      catch { throw new StandaloneRestoreError('session_storage_standalone_staging_cleanup_incomplete', info) }
    }
    throw error instanceof SessionStorageError ? error : new SessionStorageError(503, 'session_storage_standalone_restore_failed')
  } finally {
    if (heartbeat) clearInterval(heartbeat); await heartbeatTail
    if (reserved) await deps.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [taskLock], arguments: [ownership.token] }).catch(() => {})
    await lease.release().catch(() => {})
  }
}
