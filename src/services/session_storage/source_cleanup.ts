import type Redis from 'ioredis'
import { createHash } from 'node:crypto'
import type { SessionDatabase } from './database'
import type { SqliteBackupManifest } from './backup'
import { SessionStorageDescriptor, SessionStorageError, StorageProgress, validateSessionPhone, validateStorageDescriptor } from './types'
import { isRetainedSessionControlKey, isSessionCompatibilityDataKey, SESSION_COMPATIBILITY_DATA_FAMILIES } from './source_scope'

const NATIVE = ['auth', 'signal:reg', 'signal:spk', 'signal:meta', 'signal:pk', 'signal:pk:ids', 'signal:pk:avail', 'signal:sess', 'signal:ident', 'sk', 'sk:grp', 'skd', 'appstate:key', 'appstate:key:idx', 'appstate:col', 'appstate:idx', 'appstate:idx:set', 'privtoken', 'msg', 'msg:idx', 'contact', 'contact_pn', 'thread', 'panel', 'retry:out', 'retry:in', 'msgsecret', 'participants', 'devlist', 'devlistalt', 'chat_metadata']
const COMPATIBILITY = SESSION_COMPATIBILITY_DATA_FAMILIES

export function isSessionSourceCleanupKey(key: string, phone: string, prefix: string) {
  validateSessionPhone(phone)
  return NATIVE.some(domain => key === `${prefix}${domain}:${phone}` || key.startsWith(`${prefix}${domain}:${phone}:`))
    || isSessionCompatibilityDataKey(key, phone)
}

const luaArray = (values: string[]) => '{' + values.map(value => JSON.stringify(value)).join(',') + '}'

/** All checks and deletion happen in the same Redis command. No wildcard deletion. */
export const CLEAN_SOURCE_BATCH_LUA = `
if #KEYS<4 or #KEYS>103 then return {err='session_storage_cleanup_batch_invalid'} end
local raw=redis.call('GET',KEYS[1]); if not raw then return {err='session_storage_cleanup_configuration_changed'} end
local cfg=cjson.decode(raw); local s=cfg.sessionStorage
if not s or s.backend~='sqlite' or s.state~='offline' or cfg.autoConnect~=false or s.generation~=tonumber(ARGV[1]) or s.storageId~=ARGV[2] or s.owner~=ARGV[3] then return {err='session_storage_cleanup_configuration_changed'} end
if redis.call('GET',KEYS[2])~=ARGV[4] then return {err='session_storage_cleanup_lease_lost'} end
local backupRaw=redis.call('GET',KEYS[3]); if not backupRaw then return {err='session_storage_cleanup_backup_required'} end
local backup=cjson.decode(backupRaw)
if backup.status~='ready' or backup.id~=ARGV[5] or backup.phone~=ARGV[6] or backup.storageId~=s.storageId or backup.generation~=s.generation then return {err='session_storage_cleanup_backup_required'} end
local native=${luaArray(NATIVE)}; local compat=${luaArray(COMPATIBILITY)}
local function scoped(key)
 for _,domain in ipairs(native) do local base=ARGV[7]..domain..':'..ARGV[6]; if key==base or string.sub(key,1,#base+1)==base..':' then return true end end
 for _,domain in ipairs(compat) do local base='unoapi-'..domain..':'..ARGV[6]; if key==base or string.sub(key,1,#base+1)==base..':' then return true end end
 for _,domain in ipairs({'own-profile','own-privacy','own-profile-cover'}) do local base='unoapi-'..domain..':v1:'..ARGV[6]; if key==base or domain~='own-profile-cover' and key==base..':generation' then return true end end
 return false
end
local rows=cjson.decode(ARGV[8]); if #rows~=#KEYS-3 then return {err='session_storage_cleanup_batch_invalid'} end
for i,row in ipairs(rows) do
 if KEYS[i+3]~=row.key or not scoped(row.key) or type(row.sha1)~='string' or #row.sha1~=40 or not string.match(row.sha1,'^[a-f0-9]+$') or type(row.expiresAt)~='number' or row.expiresAt~=math.floor(row.expiresAt) or (row.expiresAt~=-1 and row.expiresAt<=0) then return {err='session_storage_cleanup_scope_invalid'} end
end
local tm=redis.call('TIME'); local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local deleted=0; local skipped=0; local missing=0; local before=0; local after=0; local mutated=0; local ttlChanged=0
for i,row in ipairs(rows) do
 local key=KEYS[i+3]
 local bytes=redis.call('MEMORY','USAGE',key,'SAMPLES',5) or 0; before=before+bytes
 local dump=redis.call('DUMP',key)
 if not dump then missing=missing+1
 elseif redis.sha1hex(dump)~=row.sha1 then skipped=skipped+1; mutated=mutated+1; after=after+bytes
 else
  local ttl=redis.call('PTTL',key); local safe=false
  if row.expiresAt==-1 then safe=ttl==-1
  else safe=ttl>=0 and math.abs(now+ttl-row.expiresAt)<=2000 end
  if not safe then skipped=skipped+1; ttlChanged=ttlChanged+1; after=after+bytes
  else deleted=deleted+redis.call('UNLINK',key) end
 end
end
return {deleted,skipped,missing,before,after,mutated,ttlChanged}`

export interface SourceCleanupInput {
  redis: Redis
  database: SessionDatabase
  phone: string
  storage: SessionStorageDescriptor
  prefix: string
  body: { confirm: true; backupId: string; generation: number }
  lease: { key: string; token: string; assertOwned(): Promise<void> }
  /** Must read/verify the uploaded encrypted backup, including this fingerprint table. */
  verifyBackup(manifest: SqliteBackupManifest, expectedFingerprintSha256: string): Promise<boolean>
  progress?(value: StorageProgress): Promise<void>
}

/** Compare this digest with the table from the decrypted uploaded SQLite snapshot. */
export function sourceFingerprintsDigest(database: SessionDatabase) {
  const hash = createHash('sha256'); let after = ''
  while (true) {
    const rows = database.all<{ key: string; sha1: string; expires_at: number | null }>('SELECT key,sha1,expires_at FROM uno_source_fingerprints WHERE key>? ORDER BY key LIMIT 100', [after])
    if (!rows.length) break
    for (const row of rows) { hash.update(JSON.stringify([row.key, row.sha1, row.expires_at])); hash.update('\n') }
    after = rows[rows.length - 1].key
  }
  return hash.digest('hex')
}

export async function cleanRedisSource(input: SourceCleanupInput) {
  validateSessionPhone(input.phone); validateStorageDescriptor(input.storage)
  if (!input.body || input.body.confirm !== true || Object.keys(input.body).sort().join(',') !== 'backupId,confirm,generation'
    || !/^[0-9a-f-]{36}$/i.test(input.body.backupId) || input.body.generation !== input.storage.generation) throw new SessionStorageError(400, 'session_storage_cleanup_confirmation_required')
  if (input.storage.backend !== 'sqlite' || input.storage.state !== 'offline') throw new SessionStorageError(409, 'session_storage_cleanup_requires_offline_sqlite')
  if (!/^[A-Za-z0-9_:]+$/.test(input.prefix) || input.lease.key !== `unoapi-lease:zapo-session:${input.phone}` || !input.lease.token) throw new SessionStorageError(409, 'session_storage_cleanup_lease_required')
  const identity = input.database.get<{ value: string }>('SELECT value FROM uno_storage_meta WHERE key=?', ['phone'])
  if (identity?.value !== input.phone) throw new SessionStorageError(409, 'session_storage_cleanup_identity_mismatch')
  if (!input.database.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='uno_source_fingerprints'")) throw new SessionStorageError(409, 'session_storage_cleanup_fingerprints_required')
  const raw = await input.redis.get(`unoapi-session-storage:backup:${input.body.backupId}`), manifest: SqliteBackupManifest | undefined = raw ? JSON.parse(raw) : undefined
  if (!manifest || manifest.id !== input.body.backupId || manifest.phone !== input.phone || manifest.storageId !== input.storage.storageId || manifest.generation !== input.storage.generation || manifest.status !== 'ready') throw new SessionStorageError(409, 'session_storage_cleanup_backup_required')
  await input.lease.assertOwned()
  if (!await input.verifyBackup(manifest, sourceFingerprintsDigest(input.database))) throw new SessionStorageError(409, 'session_storage_cleanup_backup_verification_failed')
  const result = { deleted: 0, skipped: 0, missing: 0, retainedControl: 0, skippedScope: 0, skippedMutated: 0, skippedTtl: 0, sourceBytesBefore: 0, sourceBytesAfter: 0, deletedKeyBytes: 0, batches: 0 }
  let after = ''
  while (true) {
    const rows = input.database.all<{ key: string; sha1: string; expires_at: number | null }>('SELECT key,sha1,expires_at FROM uno_source_fingerprints WHERE key>? ORDER BY key LIMIT 100', [after])
    if (!rows.length) break
    after = rows[rows.length - 1].key
    const safe = rows.filter(row => isSessionSourceCleanupKey(row.key, input.phone, input.prefix))
    const retained = rows.filter(row => isRetainedSessionControlKey(row.key, input.phone)).length
    result.retainedControl += retained
    result.skippedScope += rows.length - safe.length - retained; result.skipped += rows.length - safe.length - retained
    if (safe.length) {
      await input.lease.assertOwned()
      const values = await input.redis.eval(CLEAN_SOURCE_BATCH_LUA, safe.length + 3,
        `unoapi-config:${input.phone}`, input.lease.key, `unoapi-session-storage:backup:${input.body.backupId}`, ...safe.map(row => row.key),
        String(input.storage.generation), input.storage.storageId, input.storage.owner, input.lease.token, input.body.backupId, input.phone, input.prefix,
        JSON.stringify(safe.map(row => ({ key: row.key, sha1: row.sha1, expiresAt: row.expires_at ?? -1 })))) as number[]
      if (!Array.isArray(values) || values.length !== 7 || values.some(value => !Number.isFinite(Number(value)))) throw new SessionStorageError(503, 'session_storage_cleanup_response_invalid')
      result.deleted += Number(values[0]); result.skipped += Number(values[1]); result.missing += Number(values[2]); result.sourceBytesBefore += Number(values[3]); result.sourceBytesAfter += Number(values[4]); result.skippedMutated += Number(values[5]); result.skippedTtl += Number(values[6]); result.batches++
    }
    await input.progress?.({ phase: 'source_cleanup', processed: result.deleted + result.skipped + result.missing + result.retainedControl })
  }
  result.deletedKeyBytes = result.sourceBytesBefore - result.sourceBytesAfter
  return { ...result, memoryMeasurement: 'Redis MEMORY USAGE of compared keys; not process RSS or immediate allocator release', sourceCleanupExplicit: true }
}
