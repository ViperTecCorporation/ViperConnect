import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { Transform } from 'node:stream'
import type { Config } from '../config'
import { getConfigRedis } from '../config_redis'
import { getRedis } from '../redis'
import { decodeBackupStream } from './backup_stream'
import { SessionSqliteBackups, type SqliteBackupManifest } from './backup'
import { createBackupObjects, type BackupObjects } from './backup_objects'
import { validateWeeklyManifest } from './backup_slots'
import { sessionStorageRpc } from './rpc'
import { SessionStorageError, validateSessionPhone } from './types'

export const SESSION_BACKUP_UPLOAD_BYTES = 256 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export function storageUploadKeys(phone: string, id: string) {
  validateSessionPhone(phone)
  if (!UUID.test(id)) throw new SessionStorageError(400, 'session_storage_upload_invalid')
  const prefix = `backups/session-storage/${phone}/uploads/${id}`
  return { archive: prefix + '.viperstorage', receipt: prefix + '.upload.json' }
}

export function assertUploadDestination(config: Config, hasClient: boolean) {
  if (config.provider !== 'zapo' || config.sessionStorage?.backend !== 'sqlite' || config.sessionStorage.state !== 'offline'
    || config.autoConnect !== false || hasClient || config.mobilePrimaryDeleting || config.sessionStorageUnlinked) throw new SessionStorageError(409, 'session_storage_restore_requires_offline')
}

/** Stream to a private S3 staging key. Never buffer an uploaded archive or accept a worker-local path. */
export async function stageSessionBackupUpload(phone: string, source: Readable, bytes: number) {
  validateSessionPhone(phone)
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > SESSION_BACKUP_UPLOAD_BYTES) throw new SessionStorageError(413, 'session_storage_upload_size_invalid')
  const config = await getConfigRedis(phone)
  if (!config.useS3) throw new SessionStorageError(409, 'session_storage_backup_requires_s3')
  await sessionStorageRpc(phone, config, 'restore-upload-check', [])
  const objects = createBackupObjects((config as any).storage), uploadId = randomUUID(), keys = storageUploadKeys(phone, uploadId)
  // Even an ambiguous RPC or interrupted HTTP request has a bounded, discoverable staging lifetime.
  if (!await objects.putJson(keys.receipt, { version: 1, phone, uploadId, bytes, createdAt: Date.now(), expiresAt: Date.now() + 86400000 }, null)) throw new SessionStorageError(409, 'session_storage_upload_conflict')
  let received = 0
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length
    callback(received > bytes || received > SESSION_BACKUP_UPLOAD_BYTES ? new SessionStorageError(413, 'session_storage_upload_size_invalid') : null, chunk)
  }, flush(callback) { callback(received !== bytes ? new SessionStorageError(400, 'session_storage_upload_incomplete') : null) } })
  const failed = (error: Error) => bounded.destroy(error)
  source.on('error', failed); source.pipe(bounded)
  try {
    await objects.save(keys.archive, bounded)
    // The owner rechecks offline state and acquires its task/socket lease before decrypt/restore.
    return await sessionStorageRpc(phone, config, 'restore-upload', [{ uploadId }])
  } finally { source.unpipe(bounded); source.removeListener('error', failed); bounded.destroy() }
}

/** First frame discovers identity only. Success still requires full format/integrity verification. */
export async function uploadedBackupService(phone: string, uploadId: string, config: Config, password?: string) {
  const objects = createBackupObjects((config as any).storage), keys = storageUploadKeys(phone, uploadId)
  const receipt: any = (await objects.json(keys.receipt))?.value
  if (!receipt || receipt.phone !== phone || receipt.uploadId !== uploadId || receipt.expiresAt <= Date.now()
    || receipt.bytes < 1 || receipt.bytes > SESSION_BACKUP_UPLOAD_BYTES) throw new SessionStorageError(410, 'session_storage_upload_expired')
  const source = await objects.open(keys.archive), frames = decodeBackupStream(source, password)
  let manifest: SqliteBackupManifest
  try {
    const frame = await frames.next(), value = frame.value?.value
    if (frame.done || frame.value?.kind !== 'meta' || value?.kind !== 'sqlite-session' || value.version !== 1) throw new SessionStorageError(400, 'session_storage_upload_invalid')
    validateWeeklyManifest(value.manifest, { kind: 'session-storage', id: phone }); manifest = value.manifest
  } finally { source.destroy(); await frames.return(undefined) }
  const service = new SessionSqliteBackups({ save: async () => { throw new SessionStorageError(403, 'session_storage_upload_readonly') }, open: async key => {
    if (key !== manifest.objectKey) throw new SessionStorageError(403, 'session_storage_upload_invalid')
    return objects.open(keys.archive)
  } }, { put: async () => undefined, get: async id => id === manifest.id ? manifest : undefined })
  return { service, manifest, remove: async () => { await objects.remove(keys.archive); await objects.remove(keys.receipt) } }
}

/** Only expired application-upload staging objects, never session archives, pointers or media. */
export async function cleanExpiredStorageUploads(phone: string, config: Config, objects: BackupObjects = createBackupObjects((config as any).storage)) {
  validateSessionPhone(phone)
  if (!config.useS3) return { deleted: 0 }
  const redis = await getRedis(), lock = `unoapi-session-storage:task:lock:${phone}`, token = randomUUID()
  if (Number(await redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',120000); return 1", { keys: [lock], arguments: [token] })) !== 1) return { deleted: 0 }
  let scanned = 0, deleted = 0
  try {
    for await (const key of objects.keys(`backups/session-storage/${phone}/`)) {
      if (++scanned > 2000) break
      if (!key.includes('/uploads/') || !key.endsWith('.upload.json')) continue
      const receipt: any = (await objects.json(key))?.value
      if (!receipt || receipt.phone !== phone || !UUID.test(receipt.uploadId || '') || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt > Date.now()) continue
      const keys = storageUploadKeys(phone, receipt.uploadId)
      if (keys.receipt !== key) continue
      if (Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],120000); return 1", { keys: [lock], arguments: [token] })) !== 1) throw new SessionStorageError(409, 'session_storage_lease_lost')
      await objects.remove(keys.archive); await objects.remove(keys.receipt); deleted++
    }
    return { deleted }
  } finally { await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end return 1", { keys: [lock], arguments: [token] }).catch(() => {}) }
}
