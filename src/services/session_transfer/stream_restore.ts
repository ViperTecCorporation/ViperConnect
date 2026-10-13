import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import { MobileDeviceError } from '../mobile_device_service'
import { backupRecordKey, BackupRecord, BackupMode } from '../mobile_primary/backup_manifest'
import { AUTH_SUFFIXES, validateStreamRecord } from './stream_records'

export interface StreamSessionMeta {
  kind: 'linked-session'; version: 2; zapo: '1.9.0'; redisStore: '1.3.0'
  phone: string; name: string; identityJid: string; mode: BackupMode; createdAt: string
}
/** Match only the BR mobile ninth-digit alias; keep the native JID unchanged. */
function matchesSessionIdentity(phone: string, identityJid: unknown): boolean {
  if (typeof identityJid !== 'string') return false
  const identity = /^([1-9]\d{7,14}):\d+@s\.whatsapp\.net$/.exec(identityJid)?.[1]
  if (!identity) return false
  if (identity === phone) return true
  const mobile = /^55\d{2}(?:9[6-9]\d{7}|[6-9]\d{7})$/
  if (!mobile.test(phone) || !mobile.test(identity)) return false
  const withoutNine = (number: string) => number.length === 13 ? number.slice(0, 4) + number.slice(5) : number
  return withoutNine(phone) === withoutNine(identity)
}
export function validateStreamMeta(value: any): asserts value is StreamSessionMeta {
  if (!value || Object.keys(value).sort().join(',') !== 'createdAt,identityJid,kind,mode,name,phone,redisStore,version,zapo'
    || value.kind !== 'linked-session' || value.version !== 2 || value.zapo !== '1.9.0' || value.redisStore !== '1.3.0'
    || typeof value.phone !== 'string' || !/^[1-9]\d{7,14}$/.test(value.phone) || typeof value.name !== 'string' || value.name.length > 80
    || !matchesSessionIdentity(value.phone, value.identityJid)
    || !['credentials', 'complete'].includes(value.mode) || !Number.isFinite(Date.parse(value.createdAt))) throw new MobileDeviceError(400, 'session_backup_incompatible')
}

/** Disk-free staging and a metadata journal; never send every key in one blocking Lua call. */
export async function restoreStagedStream(redis: Redis, meta: StreamSessionMeta, frames: AsyncIterable<any>, prefix: string, deps: {
  lease: string; token: string; configKey: string; indexKey: string; config: unknown
  renew(): Promise<void>; identity(stagePrefix: string): Promise<boolean>
}) {
  validateStreamMeta(meta)
  const stage = `session_transfer_stage:${randomUUID().replace(/-/g, '')}:`, journal = stage + 'journal'
  let count = 0, observed = 0, ended = false, committed = 0, finalized = false, renewed = 0, promoting = false, uncertain = false
  const auth = new Set<string>()
  const renew = async () => { if (Date.now() - renewed >= 10000) { await deps.renew(); if (!promoting) await redis.expire(journal, 86400); renewed = Date.now() } }
  const page = async (offset: number) => (await redis.lrange(journal, offset, offset + 99)).map(text => JSON.parse(text) as BackupRecord)
  try {
    for await (const frame of frames) {
      await renew()
      if (ended) throw new MobileDeviceError(400, 'session_backup_incompatible')
      if (frame.kind === 'end') { if (frame.count !== observed) throw new MobileDeviceError(400, 'session_backup_incompatible'); ended = true; continue }
      if (frame.kind !== 'records') throw new MobileDeviceError(400, 'session_backup_incompatible')
      for (const record of frame.value) {
        observed++
        validateStreamRecord(record, meta.phone, meta.mode)
        if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) continue
        const target = backupRecordKey(record, prefix), key = stage + target
        // RESTORE without REPLACE rejects duplicate records; record journal precedes
        // the write so cleanup also covers failures between these two commands.
        if (await redis.exists(key)) throw new MobileDeviceError(400, 'session_backup_duplicate_record')
        const { dump: _dump, ...entry } = record
        await redis.rpush(journal, JSON.stringify(entry)); await redis.expire(journal, 86400)
        await redis.restore(key, 86400000, Buffer.from(record.dump, 'base64'))
        if (!record.namespace && AUTH_SUFFIXES.some(suffix => record.key === `auth:${meta.phone}${suffix}`)) auth.add(record.key)
        count++
      }
    }
    if (!ended || auth.size !== AUTH_SUFFIXES.length || !await deps.identity(stage + prefix)) throw new MobileDeviceError(400, 'mobile_backup_identity_mismatch')
    // Keep diagnostic metadata durable across a process crash during promotion.
    // Successful finalization or a proven rollback removes it below.
    promoting = true
    await redis.persist(journal)
    for (let offset = 0; offset < count; offset += 100) {
      await renew()
      const records = await page(offset)
      const keys = [deps.lease, deps.configKey, ...records.flatMap(record => { const target = backupRecordKey(record, prefix); return [stage + target, target] })]
      uncertain = true
      const result = await redis.eval(`
        if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[2]) ~= 0 then return 0 end
        for i=3,#KEYS,2 do if redis.call('EXISTS',KEYS[i]) ~= 1 or redis.call('EXISTS',KEYS[i+1]) ~= 0 then return 0 end end
        local expiry=cjson.decode(ARGV[2])
        for i=3,#KEYS,2 do
          redis.call('RENAME',KEYS[i],KEYS[i+1])
          if expiry[(i-3)/2+1] > 0 then redis.call('PEXPIREAT',KEYS[i+1],expiry[(i-3)/2+1]) else redis.call('PERSIST',KEYS[i+1]) end
        end
        return 1`, keys.length, ...keys, deps.token, JSON.stringify(records.map(r => r.expiresAt || 0)))
      uncertain = false
      if (Number(result) !== 1) throw new MobileDeviceError(409, 'mobile_restore_destination_exists')
      committed += records.length
    }
    await deps.renew()
    const result = await redis.eval(`
      if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[2]) ~= 0 or redis.call('HEXISTS','mobile-primary:{v1}:drafts',ARGV[3]) == 1 then return 0 end
      local kind=redis.call('TYPE',KEYS[3]).ok; if kind ~= 'none' and kind ~= 'set' then return 0 end
      redis.call('SET',KEYS[2],ARGV[2]); redis.call('SADD',KEYS[3],ARGV[3]); redis.call('PUBLISH','unoapi-config:update',ARGV[3]); return 1`,
    3, deps.lease, deps.configKey, deps.indexKey, deps.token, JSON.stringify(deps.config), meta.phone)
    if (Number(result) !== 1) throw new MobileDeviceError(409, 'mobile_restore_destination_exists')
    finalized = true
    return { phone: meta.phone, restored: true }
  } finally {
    // If fencing or a command response is lost, retain the durable journal. Never delete data
    // now owned by another process or by a session whose config was finalized.
    let rollbackSafe = !uncertain
    for (let offset = 0; offset < count + 1; offset += 100) {
      const records = await page(offset)
      if (!records.length) break
      if (!finalized && offset < committed) {
        const targets = records.slice(0, committed - offset).map(record => backupRecordKey(record, prefix))
        const result = await redis.eval(`if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[2]) ~= 0 then return 0 end; for i=3,#KEYS do redis.call('DEL',KEYS[i]) end; return 1`,
          targets.length + 2, deps.lease, deps.configKey, ...targets, deps.token)
        if (Number(result) !== 1) rollbackSafe = false
      }
      await redis.del(...records.map(record => stage + backupRecordKey(record, prefix)))
    }
    if (rollbackSafe) await redis.del(journal)
    else throw new MobileDeviceError(409, 'session_restore_rollback_pending')
  }
}
