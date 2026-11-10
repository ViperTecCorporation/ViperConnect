import { getRedis } from '../redis'
import { createBackupObjects } from './backup_objects'
import { storageUploadKeys } from './backup_upload'

const PREFIX = 'unoapi-session-storage:standalone-staging:'
export const stagingIndexKey = (phone: string, id: string) => PREFIX + phone + ':' + id
let cursor = 0

/** Absent destinations are not in the normal session list. Keep a bounded, durable cleanup index. */
export async function cleanExpiredStandaloneStaging(owner: string, now = Date.now()) {
  const redis = await getRedis(), objects = createBackupObjects()
  const page = await redis.scan(cursor, { MATCH: PREFIX + '*', COUNT: 100 }); cursor = Number(page.cursor)
  let deleted = 0
  for (const indexKey of page.keys.slice(0, 100)) {
    const raw = await redis.get(indexKey)
    if (!raw) continue
    let value: any
    try { value = JSON.parse(raw) } catch { continue }
    if (value.owner !== owner || !Number.isSafeInteger(value.expiresAt) || value.expiresAt > now
      || !/^[1-9]\d{7,14}$/.test(value.phone || '') || !/^[a-f0-9-]{36}$/i.test(value.uploadId || '')
      || stagingIndexKey(value.phone, value.uploadId) !== indexKey || await redis.get(`unoapi-session-storage:standalone-job:${value.phone}`)) continue
    const keys = storageUploadKeys(value.phone, value.uploadId), receipt: any = (await objects.json(keys.receipt))?.value
    if (receipt && (receipt.owner !== owner || receipt.phone !== value.phone || receipt.uploadId !== value.uploadId || receipt.expiresAt !== value.expiresAt)) continue
    await objects.remove(keys.archive); await objects.remove(keys.receipt)
    await redis.del(indexKey); deleted++
  }
  return { deleted, bounded: true }
}
