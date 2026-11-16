import type Redis from 'ioredis'
import { createHash } from 'node:crypto'
import { openSync, closeSync, fsyncSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createRedisStore } from '@zapo-js/store-redis'
import { createSqliteStore, ensureSqliteMigrations, type WaSqliteConnection } from '@zapo-js/store-sqlite'
import { openPreparedSessionDatabase, type SessionDatabase } from './database'
import { createNativeSnapshotReader } from './snapshot_reader'
import { isSessionCompatibilityDataKey } from './source_scope'

export type StorageMigrationResult = { counts: Record<string, number>; records: number; bytes: number; sha256: string }
export type StorageMigrationProgress = (progress: { phase: string; records: number }) => Promise<void> | void
const safeScope = (phone: string, prefix = '') => { if (!/^[1-9]\d{7,14}$/.test(phone) || !/^[A-Za-z\d_:]*$/.test(prefix)) throw new Error('session_storage_migration_invalid_scope') }
const table = (type: string) => ({ string: 'uno_kv', hash: 'uno_hash', set: 'uno_set', zset: 'uno_zset', list: 'uno_list' }[type])
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const MAX_PRELOAD_BYTES = 8 * 1024 * 1024

/** NORMAL is allowed only for an unpublished, UUID-scoped migration artifact. */
function beginStagingImport(db: SessionDatabase, path: string) {
  if (new RegExp(`^migration-${UUID}\\.sqlite$`, 'i').test(basename(path)) && new RegExp(`^${UUID}$`, 'i').test(basename(dirname(path))) && basename(dirname(dirname(path))) === 'session-storage') {
    db.exec('PRAGMA synchronous=NORMAL')
  }
}

function finishStagingImport(db: SessionDatabase, path: string) {
  db.exec('PRAGMA synchronous=FULL')
  const checkpoint = db.get('PRAGMA wal_checkpoint(TRUNCATE)')
  if (!checkpoint || Number(checkpoint.busy) !== 0 || Number(checkpoint.log) !== Number(checkpoint.checkpointed)) throw new Error('session_storage_checkpoint_incomplete')
  const descriptor = openSync(path, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  // fsync(directory) is unsupported by native Windows, but required on Linux
  // before the parent promotes the already durable staging file.
  if (process.platform !== 'win32') { const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } }
}

type CapturedString = { key: string; value: Buffer; expires: number | null; before: number; sha1: string }
const fingerprint = (db: SessionDatabase, captured: Omit<CapturedString, 'value'>) => db.run('INSERT INTO uno_source_fingerprints(key,sha1,expires_at,captured_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET sha1=excluded.sha1,expires_at=excluded.expires_at,captured_at=excluded.captured_at', [captured.key, captured.sha1, captured.expires, captured.before])

export function sqliteSdkConnection(database: SessionDatabase | (() => SessionDatabase)): WaSqliteConnection {
  const db = () => typeof database === 'function' ? database() : database
  // The SDK only uses the driver tag for diagnostics when a connection is supplied.
  return { driver: 'better-sqlite3', exec: sql => db().exec(sql), run: (sql, args) => { db().run(sql, args) }, get: <T extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) => db().get<T>(sql, args) || null, all: <T extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) => db().all<T>(sql, args), runInTransaction: async work => db().transaction(work), close: () => undefined }
}

async function copyKey(redis: Redis, db: SessionDatabase, key: string, deferString?: (captured: CapturedString) => void, flush?: () => void) {
  const before = Date.now(), remaining = await redis.pttl(key)
  if (remaining === -2 || remaining === 0) return
  const dump = await redis.dumpBuffer(key)
  if (!dump) return
  const expires = remaining >= 0 ? before + remaining : null
  const type = await redis.type(key)
  let value: Buffer | null = null
  if (type === 'string') value = await redis.getBuffer(key)
  else { flush?.(); await copyKeyValue(redis, db, key, expires) }
  const current = await redis.dumpBuffer(key), finalTtl = await redis.pttl(key)
  if (!current || !dump.equals(current) || (expires === null ? finalTtl !== -1 : finalTtl < 0 || Math.abs(Date.now() + finalTtl - expires) > 2000)) throw new Error('session_storage_source_changed_during_copy')
  const captured = { key, expires, before, sha1: createHash('sha1').update(dump).digest('hex') }
  if (type === 'string') {
    if (value === null) throw new Error('session_storage_source_changed_during_copy')
    if (deferString) deferString({ ...captured, value })
    else db.transaction(() => { db.run('INSERT OR REPLACE INTO uno_redis_types(key,type,expires_at) VALUES(?,?,?)', [key, type, expires]); db.putValue(key, value!, { expiresAt: expires }); fingerprint(db, captured) })
  } else fingerprint(db, captured)
}

async function copyKeyValue(redis: Redis, db: SessionDatabase, key: string, expires: number | null) {
  const type = await redis.type(key), target = table(type)
  if (!target) throw new Error(`session_storage_unsupported_redis_type:${type}`)
  db.run('INSERT INTO uno_redis_types(key,type,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET type=excluded.type,expires_at=excluded.expires_at', [key, type, expires])
  if (type === 'string') { const value = await redis.getBuffer(key); if (value) db.putValue(key, value, { expiresAt: expires }); return }
  db.run(`DELETE FROM ${target} WHERE key=?`, [key])
  if (type === 'hash') {
    let cursor = '0'
    do { const page = await redis.hscanBuffer(key, cursor, 'COUNT', 200); cursor = page[0].toString(); const fields = page[1]; db.transaction(() => { for (let i = 0; i < fields.length; i += 2) db.run('INSERT OR REPLACE INTO uno_hash(key,field,value,expires_at) VALUES(?,?,?,?)', [key, fields[i].toString(), fields[i + 1], expires]) }) } while (cursor !== '0')
  } else if (type === 'set') {
    let cursor = '0'
    do { const page = await redis.sscanBuffer(key, cursor, 'COUNT', 200); cursor = page[0].toString(); db.transaction(() => { for (const member of page[1]) db.run('INSERT OR REPLACE INTO uno_set(key,member,expires_at) VALUES(?,?,?)', [key, member, expires]) }) } while (cursor !== '0')
  } else if (type === 'zset') {
    let cursor = '0'
    do { const page = await redis.zscan(key, cursor, 'COUNT', 200); cursor = page[0]; db.transaction(() => { for (let i = 0; i < page[1].length; i += 2) db.run('INSERT OR REPLACE INTO uno_zset(key,member,score,expires_at) VALUES(?,?,?,?)', [key, page[1][i], Number(page[1][i + 1]), expires]) }) } while (cursor !== '0')
  } else {
    for (let offset = 0; ; offset += 200) { const values = await redis.lrangeBuffer(key, offset, offset + 199); db.transaction(() => { values.forEach((value, i) => db.run('INSERT INTO uno_list(key,position,value,expires_at) VALUES(?,?,?,?)', [key, offset + i, value, expires])) }); if (values.length < 200) break }
  }
}

export function summarizeSqliteMigration(db: SessionDatabase, prefix?: string): StorageMigrationResult {
  const hash = createHash('sha256'), counts: Record<string, number> = {}; let records = 0, bytes = 0, after = ''
  while (true) {
    const keys = db.all('SELECT key,type,expires_at FROM uno_redis_types WHERE key>? ORDER BY key LIMIT 200', [after])
    if (!keys.length) break
    for (const row of keys) {
      after = row.key; if (prefix && !row.key.startsWith(prefix)) continue
      records++; counts[row.type] = (counts[row.type] || 0) + 1
      hash.update(JSON.stringify([row.key, row.type, row.expires_at]))
      if (row.type === 'string') { const value = db.get('SELECT value FROM uno_kv WHERE key=?', [row.key])?.value; if (value) { const b = Buffer.from(value); bytes += b.length; hash.update(b) } }
      else {
        const target = table(row.type)!, ordering = row.type === 'hash' ? 'field' : row.type === 'list' ? 'position' : 'member'
        let offset = 0
        while (true) { const values = db.all(`SELECT * FROM ${target} WHERE key=? ORDER BY ${ordering} LIMIT 200 OFFSET ?`, [row.key, offset]); if (!values.length) break; for (const value of values) { for (const field of Object.keys(value).sort()) { const b = value[field] instanceof Uint8Array ? Buffer.from(value[field]) : Buffer.from(JSON.stringify(value[field])); hash.update(field); hash.update(b); bytes += b.length } } offset += values.length }
      }
    }
  }
  return { counts, records, bytes, sha256: hash.digest('hex') }
}

async function snapshot(redis: Redis, db: SessionDatabase, pattern: string, select: (key: string) => boolean, progress?: StorageMigrationProgress) {
  db.exec('CREATE TABLE IF NOT EXISTS uno_redis_types(key TEXT PRIMARY KEY,type TEXT NOT NULL,expires_at INTEGER)')
  db.exec('CREATE TABLE IF NOT EXISTS uno_source_fingerprints(key TEXT PRIMARY KEY,sha1 TEXT NOT NULL,expires_at INTEGER,captured_at INTEGER NOT NULL)')
  let cursor = '0', records = 0, pending: CapturedString[] = [], pendingBytes = 0, lastProgress = Date.now()
  const flush = () => {
    if (!pending.length) return
    const batch = pending; pending = []; pendingBytes = 0
    // All Redis reads and fingerprint checks have completed before BEGIN.
    // Nested putValue() calls reuse this transaction; there is one commit per batch.
    db.transaction(() => { for (const captured of batch) {
      if (captured.expires !== null && captured.expires <= Date.now()) continue
      db.run('INSERT OR REPLACE INTO uno_redis_types(key,type,expires_at) VALUES(?,?,?)', [captured.key, 'string', captured.expires])
      db.putValue(captured.key, captured.value, { expiresAt: captured.expires }); fingerprint(db, captured)
    } })
  }
  const enqueue = (captured: CapturedString) => {
    const size = captured.value.byteLength + captured.key.length * 2 + 128
    if (pending.length >= 200 || pendingBytes + size > MAX_PRELOAD_BYTES) flush()
    pending.push(captured); pendingBytes += size
    if (pendingBytes >= MAX_PRELOAD_BYTES) flush()
  }
  do {
    const page = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200); cursor = page[0]
    for (const key of page[1]) if (select(key)) {
      await copyKey(redis, db, key, enqueue, flush); records++
      if (records % 200 === 0 || Date.now() - lastProgress >= 5000) { flush(); await progress?.({ phase: 'copy', records }); lastProgress = Date.now(); await new Promise<void>(resolve => setImmediate(resolve)) }
    }
    flush()
    await new Promise<void>(resolve => setImmediate(resolve))
  } while (cursor !== '0')
  flush()
  await progress?.({ phase: 'copy', records })
}

/** Copies compatibility state without reading other sessions or touching source TTLs. */
export async function migrateCompatibilityRedisToSqlite(redis: Redis, phone: string, path: string, progress?: StorageMigrationProgress): Promise<StorageMigrationResult> {
  safeScope(phone); const db = openPreparedSessionDatabase(path)
  try {
    beginStagingImport(db, path)
    await snapshot(redis, db, `unoapi-*:${phone}*`, key => isSessionCompatibilityDataKey(key, phone), progress)
    const result = summarizeSqliteMigration(db, 'unoapi-'); finishStagingImport(db, path); return result
  } finally { db.close() }
}

function required<T>(value: T | null | undefined, domain: string): T { if (value === null || value === undefined) throw new Error(`session_storage_native_record_incomplete:${domain}`); return value }
function requiredAuth(value: any) {
  const auth = required(value, 'auth')
  const binaries = [auth.noiseKeyPair?.pubKey, auth.noiseKeyPair?.privKey, auth.registrationInfo?.identityKeyPair?.pubKey, auth.registrationInfo?.identityKeyPair?.privKey,
    auth.signedPreKey?.keyPair?.pubKey, auth.signedPreKey?.keyPair?.privKey, auth.signedPreKey?.signature, auth.advSecretKey]
  if (binaries.some(value => !(value instanceof Uint8Array) || value.byteLength === 0) || !Number.isSafeInteger(auth.registrationInfo?.registrationId) || !Number.isSafeInteger(auth.signedPreKey?.keyId)) throw new Error('session_storage_native_record_incomplete:auth')
  return auth
}
function address(suffix: string) { const parts = suffix.split(':'); if (parts.length !== 3 || !/^\d+$/.test(parts[2])) throw new Error('session_storage_signal_address_invalid'); return { user: parts[0], server: parts[1], device: Number(parts[2]) } }

/** Native conversion uses the official Redis readers and SQLite writers, not a live WaClient. */
export async function migrateNativeRedisToSqlite(redis: Redis, phone: string, prefix: string, path: string, progress?: StorageMigrationProgress): Promise<StorageMigrationResult> {
  safeScope(phone, prefix); const db = openPreparedSessionDatabase(path)
  try {
    beginStagingImport(db, path)
    const select = (key: string) => key.slice(prefix.length).split(':').find(part => /^\d{8,16}$/.test(part)) === phone
    await snapshot(redis, db, `${prefix}*`, select, progress)
    return await projectNativeSnapshotToSqlite(db, phone, prefix, path, progress)
  } finally { db.close() }
}

/** Decodes a completed immutable snapshot with the official SDK. No Redis input.
 * Expired captured records remain in raw/fingerprint tables for integrity/cleanup,
 * but are not resurrected in native stores. Unknown or incomplete live data fails. */
export async function projectNativeSnapshotToSqlite(db: SessionDatabase, phone: string, prefix: string, path: string, progress?: StorageMigrationProgress): Promise<StorageMigrationResult> {
  safeScope(phone, prefix)
  const projectionAt = Date.now(), connection = sqliteSdkConnection(db)
  const source = createRedisStore({ redis: createNativeSnapshotReader(db, phone, prefix, projectionAt), keyPrefix: prefix }), destination = createSqliteStore({ connection })
  const from = Object.fromEntries(Object.entries(source.stores).map(([name, factory]) => [name, factory(phone)])) as any
  const to = Object.fromEntries(Object.entries(destination.stores).map(([name, factory]) => [name, factory(phone)])) as any
  const fromCache = Object.fromEntries(Object.entries(source.caches).map(([name, factory]) => [name, factory(phone)])) as any
  const toCache = Object.fromEntries(Object.entries(destination.caches).map(([name, factory]) => [name, factory(phone)])) as any
    beginStagingImport(db, path)
    await ensureSqliteMigrations(connection, ['auth', 'signal', 'senderKey', 'appState', 'retry', 'participants', 'deviceList', 'mailbox', 'privacyToken', 'messageSecret', 'chatMetadata'])
    const select = (key: string) => key.slice(prefix.length).split(':').find(part => /^\d{8,16}$/.test(part)) === phone
    // Small singleton crypto domains must be imported before any mailbox reads.
    const authKey = `${prefix}auth:${phone}`
    const active = (key: string) => db.get('SELECT 1 AS found FROM uno_redis_types WHERE key=? AND (expires_at IS NULL OR expires_at>?)', [key, projectionAt])
    if (active(authKey)) await to.auth.save(requiredAuth(await from.auth.load()))
    if (active(`${prefix}signal:reg:${phone}`)) await to.signal.setRegistrationInfo(required(await from.signal.getRegistrationInfo(), 'signal_registration'))
    if (active(`${prefix}signal:spk:${phone}`)) await to.signal.setSignedPreKey(required(await from.signal.getSignedPreKey(), 'signal_signed_prekey'))
    let after = '', projected = 0
    while (true) {
      const rows = db.all('SELECT key,type,expires_at FROM uno_redis_types WHERE key>? ORDER BY key LIMIT 100', [after]); if (!rows.length) break
      for (const row of rows) {
        after = row.key; if (!row.key.startsWith(prefix) || !select(row.key)) continue
        const relative = row.key.slice(prefix.length), hash = () => Object.fromEntries(db.all('SELECT field,value FROM uno_hash WHERE key=?', [row.key]).map(field => [field.field, Buffer.from(field.value).toString()])) as Record<string, string>
        const suffix = (domain: string) => relative.slice(`${domain}:${phone}:`.length)
        const recordId = suffix(relative.split(`:${phone}`)[0])
        if (row.expires_at !== null) db.run('INSERT OR REPLACE INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', [relative.split(`:${phone}`)[0], recordId, row.expires_at])
        if (row.expires_at !== null && row.expires_at <= projectionAt) { projected++; if (projected % 100 === 0) await progress?.({ phase: 'native', records: projected }); continue }
        if (relative.startsWith(`signal:meta:${phone}`) && row.type === 'hash') {
          const h = hash(); await to.preKey.setServerHasPreKeys(h.server_has_prekeys === '1'); await to.signal.setSignedPreKeyRotationTs(h.signed_prekey_rotation_ts ? Number(h.signed_prekey_rotation_ts) : null)
          db.run('UPDATE signal_meta SET next_prekey_id=? WHERE session_id=?', [Number(h.next_prekey_id || 1), phone])
        } else if (relative.startsWith(`signal:pk:${phone}:`) && row.type === 'hash') await to.preKey.putPreKey(required(await from.preKey.getPreKeyById(Number(suffix('signal:pk'))), 'prekey'))
        else if (relative.startsWith(`signal:sess:${phone}:`)) { const a = address(suffix('signal:sess')); await to.session.setSession(a, required(await from.session.getSession(a), 'session')) }
        else if (relative.startsWith(`signal:ident:${phone}:`)) { const a = address(suffix('signal:ident')); await to.identity.setRemoteIdentity(a, required(await from.identity.getRemoteIdentity(a), 'identity')) }
        else if (relative.startsWith(`msg:${phone}:`) && row.type === 'hash') await to.messages.upsert(required(await from.messages.getById(suffix('msg')), 'message'))
        else if (relative.startsWith(`contact:${phone}:`) && row.type === 'hash') await to.contacts.upsert(required(await from.contacts.getByJid(suffix('contact')), 'contact'))
        else if (relative.startsWith(`thread:${phone}:`) && row.type === 'hash') await to.threads.upsert(required(await from.threads.getByJid(suffix('thread')), 'thread'))
        else if (relative.startsWith(`privtoken:${phone}:`) && row.type === 'hash') await to.privacyToken.upsert(required(await from.privacyToken.getByJid(suffix('privtoken')), 'privacy_token'))
        else if (relative.startsWith(`sk:${phone}:`) && row.type === 'string') {
          const parts = suffix('sk').split(':'), sender = address(parts.slice(-3).join(':')), group = parts.slice(0, -3).join(':'); await to.senderKey.upsertSenderKey(required(await from.senderKey.getDeviceSenderKey(group, sender), 'sender_key'))
        } else if (relative.startsWith(`skd:${phone}:`) && row.type === 'hash') {
          for (const field of db.all('SELECT field,value FROM uno_hash WHERE key=?', [row.key])) { const sender = address(field.field), value = Buffer.from(field.value).toString().split(':'); await to.senderKey.upsertSenderKeyDistribution({ groupId: suffix('skd'), sender, keyId: Number(value[0]), timestampMs: Number(value[1]) }) }
        } else if (relative.startsWith(`appstate:key:${phone}:`) && row.type === 'hash') {
          const id = suffix('appstate:key'); const records = await from.appState.getSyncKeysBatch([Buffer.from(id, 'hex')]); await to.appState.upsertSyncKeys([required(records[0], 'appstate_key')])
        } else if (relative.startsWith(`appstate:col:${phone}:`) && row.type === 'hash') {
          const h = hash(), bytes = required(db.getValue(`${row.key}:hash`, projectionAt), 'appstate_collection_hash')
          db.run('INSERT OR REPLACE INTO appstate_collection_versions(session_id,collection,version,hash) VALUES(?,?,?,?)', [phone, suffix('appstate:col'), Number(h.version), bytes])
        } else if (relative.startsWith(`appstate:idx:${phone}:`) && row.type === 'string') {
          const parts = suffix('appstate:idx').split(':'); if (parts.length !== 2) throw new Error('session_storage_appstate_index_invalid')
          db.run('INSERT OR REPLACE INTO appstate_collection_index_values(session_id,collection,index_mac_hex,value_mac) VALUES(?,?,?,?)', [phone, parts[0], parts[1], required(db.getValue(row.key, projectionAt), 'appstate_index')])
        } else if (relative.startsWith(`msgsecret:${phone}:`) && row.type === 'hash') {
          const id = suffix('msgsecret'); await toCache.messageSecret.set(id, required(await fromCache.messageSecret.get(id), 'message_secret')); db.run('UPDATE message_secrets_cache SET expires_at_ms=? WHERE session_id=? AND message_id=?', [row.expires_at ?? Number.MAX_SAFE_INTEGER, phone, id])
        } else if (relative.startsWith(`participants:${phone}:`) && row.type === 'hash') {
          const id = suffix('participants'); await toCache.groupMetadata.upsertGroupMetadata(required(await fromCache.groupMetadata.getGroupMetadata(id), 'group_metadata')); db.run('UPDATE group_participants_cache SET expires_at_ms=? WHERE session_id=? AND group_jid=?', [row.expires_at ?? Number.MAX_SAFE_INTEGER, phone, id])
        } else if (relative.startsWith(`chat_metadata:${phone}:`) && row.type === 'hash') {
          const id = suffix('chat_metadata'); await toCache.chatMetadata.upsertChatMetadata(required(await fromCache.chatMetadata.getChatMetadata(id), 'chat_metadata')); db.run('UPDATE chat_metadata_cache SET expires_at_ms=? WHERE session_id=? AND chat_jid=?', [row.expires_at ?? Number.MAX_SAFE_INTEGER, phone, id])
        } else if (relative.startsWith(`devlist:${phone}:`) && row.type === 'hash') {
          const id = suffix('devlist'); await toCache.deviceList.upsertUserDevicesBatch([required((await fromCache.deviceList.getUserDevicesBatch([id]))[0], 'device_list')]); db.run('UPDATE device_list_cache SET expires_at_ms=? WHERE session_id=? AND user_jid=?', [row.expires_at ?? Number.MAX_SAFE_INTEGER, phone, id])
        } else if (relative.startsWith(`retry:out:${phone}:`) && row.type === 'hash') {
          const id = suffix('retry:out'); await toCache.retry.upsertOutboundMessage(required(await fromCache.retry.getOutboundMessage(id), 'retry_outbound'))
        } else if (relative.startsWith(`retry:in:${phone}:`) && row.type === 'hash') {
          const rest = suffix('retry:in'), split = rest.indexOf(':'), h = hash(); if (split < 1) throw new Error('session_storage_retry_address_invalid')
          db.run('INSERT OR REPLACE INTO retry_inbound_counters(session_id,message_id,requester_jid,retry_count,expires_at_ms) VALUES(?,?,?,?,?)', [phone, rest.slice(0, split), rest.slice(split + 1), Number(h.retry_count), row.expires_at ?? Number.MAX_SAFE_INTEGER])
        } else if (!/^(?:auth:|signal:(?:reg:|spk:|pk:(?:ids:|avail:))|msg:|contact_pn:|sk:grp:|appstate:(?:key:idx:|idx:set:)|devlistalt:|panel:|privtoken:|retry:out:)/.test(relative)
          && !/^(?:appstate:key:|appstate:col:)/.test(relative)) throw new Error(`session_storage_native_domain_unsupported:${relative.split(':')[0]}`)
        projected++; if (projected % 100 === 0) await progress?.({ phase: 'native', records: projected })
      }
    }
    const result = summarizeSqliteMigration(db, prefix); finishStagingImport(db, path); return result
}
