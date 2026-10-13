import type Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { MobileDeviceError } from '../mobile_device_service'
import { BackupMode, BackupRecord, isMobileBackupKey } from '../mobile_primary/backup_manifest'

export const AUTH_SUFFIXES = ['', ':noise_pub_key', ':noise_priv_key', ':identity_pub_key', ':identity_priv_key', ':signed_prekey_pub_key', ':signed_prekey_priv_key', ':signed_prekey_signature', ':adv_secret_key']
export function validateStreamRecord(record: any, phone: string, mode: BackupMode): asserts record is BackupRecord {
  if (typeof record?.dump === 'string' && record.dump.length > 2000000) throw new MobileDeviceError(413, 'session_backup_record_too_large')
  if (!record || !['key', 'dump', 'namespace', 'expiresAt'].includes(Object.keys(record)[0]) || Object.keys(record).some(k => !['key', 'dump', 'namespace', 'expiresAt'].includes(k))
    || record.namespace !== undefined && record.namespace !== 'uno'
    || !isMobileBackupKey(record.key, phone, mode, record.namespace) || typeof record.dump !== 'string' || !record.dump.length || record.dump.length > 2000000
    || Buffer.from(record.dump, 'base64').toString('base64') !== record.dump
    || record.expiresAt !== undefined && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0)) throw new MobileDeviceError(400, 'session_backup_incompatible')
}

/** One SCAN per namespace, with a temporary Redis dedup set instead of a process-wide key array. */
export async function* sessionKeys(redis: Redis, prefix: string, phone: string, mode: BackupMode, heartbeat?: () => Promise<void>): AsyncGenerator<string> {
  let renewed = 0
  for (const base of [prefix, ...(mode === 'complete' ? ['unoapi-'] : [])]) {
    let cursor = '0'
    do {
      if (heartbeat && Date.now() - renewed >= 10000) { await heartbeat(); renewed = Date.now() }
      const page = await redis.scan(cursor, 'MATCH', base + '*' + phone + '*', 'COUNT', 200)
      cursor = page[0]
      for (const key of page[1]) if (isMobileBackupKey(key.slice(base.length), phone, mode, base === prefix ? undefined : 'uno')) yield key
    } while (cursor !== '0')
  }
}

export async function* sessionRecords(redis: Redis, prefix: string, phone: string, mode: BackupMode, renew: () => Promise<void>): AsyncGenerator<BackupRecord> {
  const seen = `session-transfer:{v1}:scan:${randomUUID()}`
  const credentials = new Set<string>()
  let renewed = 0
  try {
    for await (const key of sessionKeys(redis, prefix, phone, mode, renew)) {
      if (Date.now() - renewed >= 10000) { await renew(); await redis.expire(seen, 86400); renewed = Date.now() }
      // SCAN may return duplicates; first occurrence wins while the session is fenced.
      if (!await redis.sadd(seen, key)) continue
      await redis.expire(seen, 86400)
      const capturedAt = Date.now()
      const result = await redis.pipeline().pttl(key).callBuffer('DUMP', key).exec()
      if (!result || result.some(([error]) => error)) throw new MobileDeviceError(503, 'session_backup_read_failed')
      const ttl = Number(result[0][1]), dump = result[1][1] as Buffer | null
      if (ttl === -2 || !dump) continue // expired cache entries do not invalidate persistent credentials
      const namespace = key.startsWith(prefix) ? undefined : 'uno' as const
      const record: BackupRecord = { key: key.slice(namespace ? 'unoapi-'.length : prefix.length), dump: dump.toString('base64'), ...(namespace ? { namespace } : {}), ...(ttl >= 0 ? { expiresAt: capturedAt + ttl } : {}) }
      validateStreamRecord(record, phone, mode)
      if (!namespace && AUTH_SUFFIXES.some(suffix => record.key === `auth:${phone}${suffix}`)) credentials.add(record.key)
      yield record
    }
    if (credentials.size !== AUTH_SUFFIXES.length) throw new MobileDeviceError(400, 'session_backup_registered_linked_required')
  } finally { await redis.del(seen) }
}
