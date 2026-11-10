import { randomUUID } from 'node:crypto'
import type { Config } from '../config'
import { RedisLease } from '../redis_lease'
import { clients } from '../client'
import { getRedis } from '../redis'
import { SessionStorageError } from './types'
import { openSessionDatabase, type SessionDatabase } from './database'
import { assertFreshSqliteWriteSelection } from './write_fence'
import { explorerColumns, explorerRecord } from './explorer'
import { explorerEtag } from './explorer_values'
import { isSessionCompatibilityDataKey } from './source_scope'
import { validateLiveIdMappings } from './id_validation'
import { makeSessionBackup } from './backup_runtime'
import logger from '../logger'
import { beginSessionStorageQuiesce, endSessionStorageQuiesce, waitSessionStorageIdle } from './activity'

export type ExplorerMutation = { action: 'create' | 'update' | 'delete'; table: string; generation: number; confirm: true; rowId?: string; etag?: string; values?: Record<string, any> }
const fail = (status: number, code: string): never => { throw new SessionStorageError(status, `session_storage_explorer_${code}`) }
export function validateExplorerMutation(input: any): ExplorerMutation {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['action', 'table', 'generation', 'confirm', 'rowId', 'etag', 'values'].includes(k))
    || input.confirm !== true || !['create', 'update', 'delete'].includes(input.action) || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(input.table || '')
    || !Number.isSafeInteger(input.generation) || input.generation < 1 || Buffer.byteLength(JSON.stringify(input)) > 131072) fail(400, 'invalid_mutation')
  if (input.action !== 'create' && (!/^[1-9]\d{0,17}$/.test(input.rowId || '') || !/^[a-f0-9]{64}$/.test(input.etag || ''))) fail(400, 'invalid_mutation')
  if (input.action === 'delete' ? input.values !== undefined : !input.values || typeof input.values !== 'object' || Array.isArray(input.values) || !Object.keys(input.values).length) fail(400, 'invalid_mutation')
  return input
}

const sqlValue = (value: any): string | number | null | Buffer => {
  if (value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && Object.keys(value).length === 1) {
    if (typeof value.utf8 === 'string') return Buffer.from(value.utf8)
    if (typeof value.base64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) return Buffer.from(value.base64, 'base64')
  }
  return fail(400, 'invalid_value')
}
function keyScope(phone: string, row: Record<string, any>) {
  if (row.session_id !== undefined && row.session_id !== phone) fail(409, 'foreign_session')
  if (row.key !== undefined && !isSessionCompatibilityDataKey(String(row.key), phone) && !String(row.key).startsWith(`unoapi:zapo:panel:${phone}:`)) fail(403, 'protected_key')
}
function mapping(phone: string, row: Record<string, any> | undefined) {
  if (!row) return undefined
  for (const [source, target] of [[`unoapi-id:${phone}:`, `unoapi-id_rev:${phone}:`], [`unoapi-id_rev:${phone}:`, `unoapi-id:${phone}:`]]) {
    if (String(row.key).startsWith(source)) {
      if (typeof row.value !== 'string' && !(row.value instanceof Uint8Array)) fail(400, 'invalid_mapping')
      const id = Buffer.from(row.value).toString(), own = String(row.key).slice(source.length)
      if (!id || id.length > 256 || !own || own.length > 256) fail(400, 'invalid_mapping')
      return { key: target + id, value: own, expires: row.expires_at ?? null }
    }
  }
}

/** Transactional record CRUD; ID forward/reverse pairs are changed together or rolled back. */
export function mutateExplorerRecord(db: SessionDatabase, phone: string, body: ExplorerMutation) {
  const columns = explorerColumns({ prepare: (sql: string) => ({ all: (...p: any[]) => db.all(sql, p) }) }, body.table)
  const native = { prepare: (sql: string) => ({ all: (...p: any[]) => db.all(sql, p), get: (...p: any[]) => db.get(sql, p) }) }
  return db.transaction(() => {
    const old = body.action === 'create' ? undefined : explorerRecord(native, body.table, body.rowId!)
    if (old && explorerEtag(body.table, old) !== body.etag) fail(409, 'record_changed')
    if (old) keyScope(phone, old)
    const values = Object.fromEntries(Object.entries(body.values || {}).map(([key, value]) => {
      if (!columns.some((c: any) => c.name === key)) fail(400, 'invalid_column')
      return [key, sqlValue(value)]
    }))
    if (values.session_id !== undefined && values.session_id !== phone) fail(409, 'foreign_session')
    if (columns.some((c: any) => c.name === 'session_id')) values.session_id = phone
    const next = { ...old, ...values }; keyScope(phone, next)
    const before = body.table === 'uno_kv' ? mapping(phone, old) : undefined
    if (before) {
      const counterpart = db.get('SELECT value FROM uno_kv WHERE key=?', [before.key])
      if (!counterpart || Buffer.from(counterpart.value).toString() !== before.value) fail(409, 'mapping_inconsistent')
      db.run('DELETE FROM uno_kv WHERE key=?', [before.key])
    }
    let rowId = body.rowId
    if (body.action === 'delete') db.run(`DELETE FROM "${body.table}" WHERE rowid=?`, [BigInt(rowId!)])
    else {
      const names = Object.keys(values)
      if (body.action === 'create') {
        const result = db.run(`INSERT INTO "${body.table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`, Object.values(values))
        rowId = String(result.lastInsertRowid)
      } else db.run(`UPDATE "${body.table}" SET ${names.map(n => `"${n}"=?`).join(',')} WHERE rowid=?`, [...Object.values(values), BigInt(rowId!)])
      const after = body.table === 'uno_kv' ? mapping(phone, next) : undefined
      if (after) {
        const existing = db.get('SELECT value FROM uno_kv WHERE key=?', [after.key])
        if (existing && Buffer.from(existing.value).toString() !== after.value) fail(409, 'mapping_conflict')
        db.run("INSERT INTO uno_kv(key,value,encoding,expires_at) VALUES(?,?,'utf8',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at", [after.key, Buffer.from(after.value), after.expires])
      }
    }
    if (body.table === 'uno_kv' && !validateLiveIdMappings(db, phone)) fail(409, 'mapping_inconsistent')
    return { action: body.action, table: body.table, rowId, changed: true }
  })
}

/** No live edits: acquire the storage mutex and WhatsApp lease, verify an S3 backup, then CAS the row. */
export async function executeExplorerMutation(phone: string, config: Config, input: unknown, deps: any = {}) {
  const body = validateExplorerMutation(input)
  if (!config.useS3) fail(409, 'requires_s3_backup')
  if (body.generation !== config.sessionStorage?.generation) fail(409, 'generation_changed')
  const redis = deps.redis || await getRedis(), token = randomUUID(), lock = `unoapi-session-storage:task:lock:${phone}`
  const offline = async () => {
    await (deps.assertFresh || assertFreshSqliteWriteSelection)(phone, config)
    const current = JSON.parse(await redis.get(`unoapi-config:${phone}`) || 'null'), status = await redis.get(`unoapi-status:${phone}`)
    if (!current || current.autoConnect !== false || current.sessionStorage?.state !== 'offline' || !['offline', 'disconnected'].includes(status)
      || (deps.hasClient || ((p: string) => clients.has(p)))(phone)) fail(409, 'requires_offline')
  }
  await offline()
  if (await redis.set(lock, token, { NX: true, PX: 120000 }) !== 'OK') fail(409, 'busy')
  const lease = deps.lease || new RedisLease(`zapo-session:${phone}`, 120000)
  let acquired = false, lost = false
  const heartbeat = setInterval(() => { void Promise.all([lease.renew(), redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('PEXPIRE',KEYS[1],120000)", { keys: [lock], arguments: [token] })]).then(results => { if (results.some(x => !x)) lost = true }, () => { lost = true }) }, 15000)
  heartbeat.unref?.()
  try {
    acquired = await lease.acquire(); if (!acquired) fail(409, 'requires_offline')
    beginSessionStorageQuiesce(phone); await waitSessionStorageIdle(phone)
    await offline()
    const backup = await (deps.backup || makeSessionBackup)(phone, config)
    if (!backup?.id || backup.status !== 'ready' || backup.phone !== phone || backup.storageId !== config.sessionStorage?.storageId || backup.generation !== body.generation) fail(503, 'backup_unconfirmed')
    await offline()
    if (lost || !await lease.renew() || await redis.get(lock) !== token) fail(409, 'lease_lost')
    let result: ReturnType<typeof mutateExplorerRecord>
    try { result = mutateExplorerRecord((deps.database || openSessionDatabase)(phone, config), phone, body) }
    catch (error: any) {
      if (String(error?.code || '').includes('CONSTRAINT') || [19,1555,2067,1299,787].includes(error?.errcode)) fail(409, 'record_conflict')
      throw error
    }
    logger.info({ phone, table: body.table, action: body.action, rowId: result.rowId, backupId: backup.id }, 'SESSION_STORAGE_EXPLORER_MUTATION')
    return { ...result, backupId: backup.id }
  } finally {
    clearInterval(heartbeat)
    if (acquired) endSessionStorageQuiesce(phone)
    if (acquired) await lease.release().catch(() => {})
    await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('DEL',KEYS[1])", { keys: [lock], arguments: [token] })
  }
}
