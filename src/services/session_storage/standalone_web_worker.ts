import { getRedis } from '../redis'
import { RedisLease } from '../redis_lease'
import { storageCapability, requireStorageVolume, storageWorkerIdentity } from './capability'
import { storageOwner, isStorageWorker } from './routing'
import { SessionStorageError, validateSessionPhone } from './types'
import { StandaloneWebTasks } from './standalone_web_tasks'
import { createBackupObjects } from './backup_objects'
import { uploadedBackupService, storageUploadKeys } from './backup_upload'
import { restoreStandaloneSession } from './standalone_recovery'
import { isSessionSourceCleanupKey } from './source_cleanup'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { sessionBackupPassword } from './backup_runtime'

/** Exact session-data scopes only. A shared Redis with the original catalogue is not an empty destination. */
export async function standaloneDestinationEmpty(phone: string, ownedKeys: string[] = []) {
  validateSessionPhone(phone)
  const redis = await getRedis(), prefix = resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX)
  let cursor = 0, inspected = 0
  do {
    const page = await redis.scan(cursor, { MATCH: `*${phone}*`, COUNT: 100 }); cursor = Number(page.cursor)
    for (const key of page.keys) {
      if (++inspected > 10000) throw new SessionStorageError(409, 'session_storage_standalone_destination_scan_limit')
      if (!ownedKeys.includes(key) && (key === `unoapi-config:${phone}` || key === `unoapi-status:${phone}` || isSessionSourceCleanupKey(key, phone, prefix))) return false
    }
  } while (cursor !== 0)
  return !await redis.hGet('mobile-primary:{v1}:drafts', phone)
}

/** Private owner operation for an absent destination; never resolves ENV defaults as a session config. */
export async function executeStandaloneWebOperation(phone: string, targetOwner: string, operation: string, args: any[]) {
  validateSessionPhone(phone)
  const identity = storageWorkerIdentity(), capability = storageCapability()
  if (!isStorageWorker() || !identity.valid || targetOwner !== identity.worker || targetOwner !== storageOwner()) throw new SessionStorageError(409, 'session_storage_wrong_owner')
  if (operation === 'standalone.capability') return { owner: targetOwner, available: capability.sqliteAvailable, reason: capability.reason }
  if (!capability.sqliteAvailable) throw new SessionStorageError(409, capability.reason || 'session_storage_sqlite_unavailable')
  if (operation === 'standalone.check') {
    if (!await standaloneDestinationEmpty(phone)) throw new SessionStorageError(409, 'session_storage_standalone_destination_exists')
    return { owner: targetOwner, available: true }
  }
  if (operation !== 'standalone.restore' || args.length !== 1 || !/^[a-f0-9-]{36}$/i.test(args[0]?.uploadId || '')) throw new SessionStorageError(400, 'session_storage_invalid_operation')
  const uploadId = args[0].uploadId, redis = await getRedis(), tasks = new StandaloneWebTasks(redis)
  return tasks.execute(phone, uploadId, targetOwner, async () => {
    const keys = storageUploadKeys(phone, uploadId), objects = createBackupObjects()
    let preserve = false
    try {
      const receipt: any = (await objects.json(keys.receipt))?.value
      if (receipt?.owner !== targetOwner || receipt.confirmOriginOffline !== true) throw new SessionStorageError(409, 'session_storage_standalone_confirmation_required')
      // Header identity is provisional. The existing restore validates every frame,
      // hash, SQLite identity, reciprocal IDs and Primary supplement before commit.
      const uploaded = await uploadedBackupService(phone, uploadId, {} as any, sessionBackupPassword())
      const overlay = { ...objects, json: async (key: string) => key === uploaded.manifest.objectKey + '.manifest.json'
        ? { value: uploaded.manifest, etag: uploadId } : undefined,
      open: async (key: string) => {
        if (key !== uploaded.manifest.objectKey) throw new SessionStorageError(403, 'session_storage_upload_invalid')
        return objects.open(keys.archive)
      } }
      return await restoreStandaloneSession({ phone, backupId: uploaded.manifest.id, confirm: true, confirmOriginOffline: true }, {
        redis, objects: overlay, baseStore: requireStorageVolume(), owner: targetOwner, password: sessionBackupPassword(), registrationKey: process.env.MOBILE_REGISTRATION_KEY,
        lease: value => {
          const lease = new RedisLease(`zapo-session:${value}`, 120000)
          return { acquire: () => lease.acquire(), ownership: () => lease.ownership(), release: () => lease.release(),
            assertOwned: async () => { if (!await lease.renew()) throw new SessionStorageError(409, 'session_storage_lease_lost') } }
        }, destinationEmpty: standaloneDestinationEmpty,
      })
    } catch (error: any) { preserve = !!error?.recovery; throw error }
    finally { if (!preserve) { await objects.remove(keys.archive).catch(() => {}); await objects.remove(keys.receipt).catch(() => {}) } }
  })
}
