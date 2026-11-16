import { randomUUID } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { getRedis, getConfig, getSessionPhones } from '../redis'
import { sessionStorageRpc } from './rpc'
import { SessionStorageError, validateSessionPhone } from './types'
import { createBackupObjects, type BackupObjects } from './backup_objects'
import { SESSION_BACKUP_UPLOAD_BYTES, storageUploadKeys } from './backup_upload'
import { StandaloneWebTasks } from './standalone_web_tasks'
import { validateWeeklyManifest, WeeklyBackupSlots } from './backup_slots'
import type { SqliteBackupManifest } from './backup'
import { stagingIndexKey } from './standalone_staging'

const OWNER = /^[A-Za-z0-9_-]{1,80}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export async function configuredRestoreOwners() {
  const owners = new Set<string>([process.env.UNOAPI_SERVER_NAME || 'server_1'])
  for (const owner of (process.env.SESSION_STORAGE_RESTORE_WORKERS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    if (!OWNER.test(owner)) throw new SessionStorageError(409, 'session_storage_standalone_configuration_invalid')
    owners.add(owner)
  }
  const phones = await getSessionPhones()
  if (phones.length > 10000) throw new SessionStorageError(409, 'session_storage_worker_directory_limit')
  for (const phone of phones) { const config = await getConfig(phone); if (config?.provider === 'zapo' && OWNER.test(config.server || '')) owners.add(config.server!) }
  return [...owners].filter(value => OWNER.test(value)).sort()
}
async function assertRestoreOwner(owner: string) {
  if (!OWNER.test(owner) || !(await configuredRestoreOwners()).includes(owner)) throw new SessionStorageError(409, 'session_storage_wrong_owner')
}
async function workerRpc<T>(phone: string, owner: string, operation: string, args: any[] = []): Promise<T> {
  try { return await sessionStorageRpc<T>(phone, { server: owner } as any, operation, args) }
  catch (error: any) { throw new SessionStorageError(typeof error?.code === 'number' ? error.code : 503, /^session_storage_[a-z0-9_]+$/.test(error?.title || '') ? error.title : 'session_storage_worker_unavailable') }
}

export async function restoreWorkerDirectory() {
  const workers = await Promise.all((await configuredRestoreOwners()).map(async owner => {
    try { return await workerRpc('999999999999', owner, 'standalone.capability') }
    catch { return { owner, available: false, reason: 'session_storage_worker_unavailable' } }
  }))
  return { workers }
}

/** Raw upload, not an import into the web process. The worker must still validate the complete archive. */
export async function uploadStandaloneBackup(phone: string, owner: string, source: Readable, bytes: number) {
  validateSessionPhone(phone); await assertRestoreOwner(owner)
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > SESSION_BACKUP_UPLOAD_BYTES) throw new SessionStorageError(413, 'session_storage_upload_size_invalid')
  if (!process.env.STORAGE_ENDPOINT || !process.env.STORAGE_BUCKET_NAME) throw new SessionStorageError(409, 'session_storage_backup_requires_s3')
  await workerRpc(phone, owner, 'standalone.check')
  const redis = await getRedis(), tasks = new StandaloneWebTasks(redis), id = randomUUID(), task = await tasks.reserve(phone, id, owner), objects = createBackupObjects(), keys = storageUploadKeys(phone, id)
  let received = 0, dispatched = false, lost = false, tail = Promise.resolve()
  const timer = setInterval(() => { tail = tail.then(() => tasks.save(task)).catch(() => { lost = true }) }, 30000); timer.unref?.()
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length
    callback(lost || received > bytes || received > SESSION_BACKUP_UPLOAD_BYTES ? new SessionStorageError(413, 'session_storage_upload_size_invalid') : null, chunk)
  }, flush(callback) { callback(received === bytes ? null : new SessionStorageError(400, 'session_storage_upload_incomplete')) } })
  const failed = (error: Error) => bounded.destroy(error)
  try {
    const createdAt = Date.now(), expiresAt = createdAt + 86400000
    await redis.set(stagingIndexKey(phone, id), JSON.stringify({ phone, owner, uploadId: id, expiresAt }), { EX: 604800 })
    if (!await objects.putJson(keys.receipt, { version: 1, phone, owner, uploadId: id, bytes, confirmOriginOffline: true, createdAt, expiresAt }, null)) throw new SessionStorageError(409, 'session_storage_upload_conflict')
    source.on('error', failed); source.pipe(bounded); await objects.save(keys.archive, bounded)
    clearInterval(timer); await tail
    if (lost) throw new SessionStorageError(409, 'session_storage_task_lost')
    task.progress = { phase: 'queued' }; await tasks.save(task)
    dispatched = true
    // A timeout can mean execution already started. Always return the same durable
    // task ID for inspection; never publish another restore or drop its staging.
    try { await workerRpc(phone, owner, 'standalone.restore', [{ uploadId: id }]) } catch { /* Poll the durable receipt. */ }
    return await tasks.status(phone, id)
  } catch (error: any) {
    if (!dispatched) {
      task.status = 'failed'; task.error = error instanceof SessionStorageError ? error.code : 'session_storage_upload_unavailable'
      await tasks.save(task).catch(() => {}); await tasks.release(task).catch(() => {})
      await objects.remove(keys.archive).catch(() => {}); await objects.remove(keys.receipt).catch(() => {})
    }
    throw error
  } finally { clearInterval(timer); await tail; source.unpipe(bounded); source.removeListener('error', failed); bounded.destroy() }
}

const publicBackup = (manifest: SqliteBackupManifest) => ({ id: manifest.id, createdAt: manifest.createdAt, bytes: manifest.bytes, kind: manifest.kind, protection: manifest.protection || 'aes-256-gcm' })
async function backupObjectsFor(phone: string) { validateSessionPhone(phone); return createBackupObjects((await getConfig(phone) as any)?.storage) }
async function backupManifest(phone: string, id: string, objects: BackupObjects) {
  if (!UUID.test(id)) throw new SessionStorageError(400, 'session_storage_backup_id_invalid')
  const value: any = (await objects.json(`backups/session-storage/${phone}/${id}.viperstorage.manifest.json`))?.value
  if (!value) throw new SessionStorageError(404, 'session_storage_backup_not_found')
  validateWeeklyManifest(value, { kind: 'session-storage', id: phone }); return value as SqliteBackupManifest
}
export async function sessionBackupLibrary(phone: string) {
  const objects = await backupObjectsFor(phone), redis = await getRedis(), slots = new WeeklyBackupSlots({ kind: 'session-storage', id: phone }, objects, redis, { timeZone: 'UTC' })
  const pointers = await Promise.all(Array.from({ length: 7 }, (_, day) => slots.slot(day)))
  const raw = await redis.get(`unoapi-session-storage:last-backup:${phone}`)
  let latest: SqliteBackupManifest | undefined
  if (raw) {
    const candidate = JSON.parse(raw); validateWeeklyManifest(candidate, { kind: 'session-storage', id: phone })
    try { latest = await backupManifest(phone, candidate.id, objects) } catch (error) { if (!(error instanceof SessionStorageError) || error.status !== 404) throw error }
  }
  const available = pointers.filter((value): value is NonNullable<typeof value> => !!value)
  for (const pointer of available) if (!latest || Date.parse(pointer.manifest.createdAt) > Date.parse(latest.createdAt)) latest = pointer.manifest as SqliteBackupManifest
  return { ...(latest ? { latest: publicBackup(latest) } : {}), slots: available.map(pointer => ({ day: pointer.day, ...publicBackup(pointer.manifest as SqliteBackupManifest) })) }
}
export async function downloadSessionBackup(phone: string, id: string) {
  const objects = await backupObjectsFor(phone)
  if (id === 'latest') { const library = await sessionBackupLibrary(phone); if (!library.latest) throw new SessionStorageError(404, 'session_storage_backup_not_found'); id = library.latest.id }
  const manifest = await backupManifest(phone, id, objects)
  return { stream: await objects.open(manifest.objectKey), fileName: `sessao-${phone}-${manifest.id}.viperstorage` }
}
