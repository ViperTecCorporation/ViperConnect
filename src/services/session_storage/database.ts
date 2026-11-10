import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Config } from '../config'
import { assertSqliteWalSafeVersion } from './sqlite_safety'
import { SESSION_COMPATIBILITY_DATA_FAMILIES } from './source_scope'

export type SessionStorageSelection = {
  backend: 'redis' | 'sqlite'; storageId: string; owner: string; generation: number
  state: 'active' | 'migrating' | 'restoring' | 'offline'; fixture?: boolean
}
export type SqliteSessionConfig = Pick<Config, 'baseStore'> & { sessionStorage?: SessionStorageSelection }
type Statement = { run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...params: any[]): any; all(...params: any[]): any[] }
type NativeDatabase = { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
type NativeSqlite = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NativeDatabase; backup(db: NativeDatabase, path: string): Promise<number> }
const sqlite = (): NativeSqlite => module.require('node:sqlite')
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const connections = new Map<string, SessionDatabase>()
const MAX_CONNECTIONS = 128

export function getSessionSqlitePath(phone: string, config: SqliteSessionConfig): string {
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('session_storage_invalid_phone')
  const selection = config.sessionStorage
  if (!selection || selection.backend !== 'sqlite' || !UUID.test(selection.storageId)) throw new Error('session_storage_invalid_selection')
  if (!config.baseStore || !selection.owner || !Number.isSafeInteger(selection.generation) || selection.generation < 1) throw new Error('session_storage_invalid_selection')
  return resolve(config.baseStore, 'session-storage', selection.storageId, 'session.sqlite')
}

function assertLocalPath(path: string, base: string, create: boolean) {
  const root = resolve(base), target = resolve(path)
  const rel = relative(root, target)
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('session_storage_path_escape')
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error('session_storage_volume_unavailable')
  // Never follow an existing symlink out of the configured worker volume.
  const realRoot = realpathSync(root)
  let current = root
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment)
    if (!existsSync(current)) continue
    if (lstatSync(current).isSymbolicLink()) throw new Error('session_storage_symlink_not_allowed')
    const realRel = relative(realRoot, realpathSync(current))
    if (isAbsolute(realRel) || realRel.split(sep).includes('..')) throw new Error('session_storage_path_escape')
  }
  if (!existsSync(target) && !create) throw new Error('session_storage_database_missing')
  if (create) mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
}

export type SqliteValue = { key: string; value: Buffer; encoding: string; expiresAt: number | null }
export type PutValueOptions = { expiresAt?: number | null; encoding?: string; nx?: boolean; keepEarlierExpiry?: boolean }

/** A small, synchronous connection owned by the worker; no remote filesystem access. */
export class SessionDatabase {
  private readonly native: NativeDatabase
  private closed = false
  private transactionDepth = 0
  constructor(readonly path: string) {
    this.native = new (sqlite().DatabaseSync)(path)
    try { assertSqliteWalSafeVersion(this.native.prepare('SELECT sqlite_version() AS version').get()?.version) }
    catch (error) { this.native.close(); throw error }
    this.native.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON;')
    this.native.exec(`
      CREATE TABLE IF NOT EXISTS uno_storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uno_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, encoding TEXT NOT NULL DEFAULT 'raw', expires_at INTEGER);
      CREATE INDEX IF NOT EXISTS uno_kv_expiry ON uno_kv(expires_at) WHERE expires_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS uno_hash (key TEXT NOT NULL, field TEXT NOT NULL, value BLOB NOT NULL, expires_at INTEGER, PRIMARY KEY(key,field));
      CREATE TABLE IF NOT EXISTS uno_set (key TEXT NOT NULL, member BLOB NOT NULL, expires_at INTEGER, PRIMARY KEY(key,member));
      CREATE TABLE IF NOT EXISTS uno_zset (key TEXT NOT NULL, member TEXT NOT NULL, score REAL NOT NULL, expires_at INTEGER, PRIMARY KEY(key,member));
      CREATE INDEX IF NOT EXISTS uno_zset_order ON uno_zset(key,score,member);
      CREATE TABLE IF NOT EXISTS uno_list (key TEXT NOT NULL, position INTEGER NOT NULL, value BLOB NOT NULL, expires_at INTEGER, PRIMARY KEY(key,position));
      CREATE TABLE IF NOT EXISTS uno_native_expiry (domain TEXT NOT NULL, record_id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(domain,record_id));
      CREATE INDEX IF NOT EXISTS uno_hash_expiry ON uno_hash(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS uno_set_expiry ON uno_set(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS uno_zset_expiry ON uno_zset(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS uno_list_expiry ON uno_list(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS uno_native_expiry_deadline ON uno_native_expiry(domain,expires_at,record_id);
    `)
  }
  private ensureOpen() { if (this.closed) throw new Error('session_storage_connection_closed') }
  exec(sql: string): void { this.ensureOpen(); this.native.exec(sql) }
  run(sql: string, params: readonly unknown[] = []) { this.ensureOpen(); const result = this.native.prepare(sql).run(...params); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid } }
  get<T extends Record<string, any> = Record<string, any>>(sql: string, params: readonly unknown[] = []): T | undefined { this.ensureOpen(); return this.native.prepare(sql).get(...params) as T | undefined }
  all<T extends Record<string, any> = Record<string, any>>(sql: string, params: readonly unknown[] = []): T[] { this.ensureOpen(); return this.native.prepare(sql).all(...params) as T[] }
  transaction<T>(work: () => T): T {
    this.ensureOpen()
    if (this.transactionDepth) return work()
    this.exec('BEGIN IMMEDIATE'); this.transactionDepth++
    try { const result = work(); if (result && typeof (result as any).then === 'function') throw new Error('session_storage_async_transaction_forbidden'); this.exec('COMMIT'); return result }
    catch (error) { this.exec('ROLLBACK'); throw error }
    finally { this.transactionDepth-- }
  }
  getValue(key: string, now = Date.now()): Buffer | undefined {
    const row = this.get<{ value: Uint8Array }>('SELECT value FROM uno_kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)', [key, now])
    return row ? Buffer.from(row.value) : undefined
  }
  putValue(key: string, value: Buffer | string, options: PutValueOptions = {}): boolean {
    return this.transaction(() => {
      const now = Date.now(); let old = this.get<{ expires_at: number | null }>('SELECT expires_at FROM uno_kv WHERE key=?', [key])
      if (old?.expires_at !== null && old?.expires_at !== undefined && old.expires_at <= now) { this.deleteValue(key); old = undefined }
      if (options.nx && old && (old.expires_at === null || old.expires_at > now)) return false
      let deadline = options.expiresAt ?? null
      if (options.keepEarlierExpiry && old?.expires_at !== null && old?.expires_at !== undefined) deadline = deadline === null ? old.expires_at : Math.min(deadline, old.expires_at)
      if (deadline !== null && (!Number.isSafeInteger(deadline) || deadline <= now)) { this.deleteValue(key); return false }
      this.run('INSERT INTO uno_kv(key,value,encoding,expires_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,encoding=excluded.encoding,expires_at=excluded.expires_at', [key, Buffer.isBuffer(value) ? value : Buffer.from(value), options.encoding || 'raw', deadline])
      return true
    })
  }
  compareAndSet(key: string, expected: Buffer | undefined, value: Buffer, options: PutValueOptions = {}): boolean {
    return this.transaction(() => { const old = this.getValue(key); if (expected ? !old?.equals(expected) : old !== undefined) return false; return this.putValue(key, value, options) })
  }
  deleteValue(key: string): boolean { return this.run('DELETE FROM uno_kv WHERE key=?', [key]).changes > 0 }
  valuesPage(after = '', limit = 200): SqliteValue[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('session_storage_page_limit_invalid')
    return this.all('SELECT key,value,encoding,expires_at FROM uno_kv WHERE key>? ORDER BY key LIMIT ?', [after, limit]).map(row => ({ key: row.key, value: Buffer.from(row.value), encoding: row.encoding, expiresAt: row.expires_at }))
  }
  pruneExpired(now = Date.now(), limit = 500, phone?: string): number {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('session_storage_prune_limit_invalid')
    if (phone !== undefined && !/^[1-9]\d{7,14}$/.test(phone)) throw new Error('session_storage_invalid_phone')
    // Runtime maintenance supplies a phone: only Uno's data/cache namespaces,
    // never native credentials/Signal/auth or shared coordination records.
    const prefixes = phone ? SESSION_COMPATIBILITY_DATA_FAMILIES.map(domain => `unoapi-${domain}:${phone}`) : []
    const privateKeys = phone ? ['own-profile', 'own-privacy', 'own-profile-cover'].flatMap(domain => [`unoapi-${domain}:v1:${phone}`, ...(domain === 'own-profile-cover' ? [] : [`unoapi-${domain}:v1:${phone}:generation`])]) : []
    const scope = phone ? ` AND (${[...prefixes.map(() => '(key=? OR substr(key,1,?)=?)'), ...privateKeys.map(() => 'key=?')].join(' OR ')})` : ''
    const args = [...prefixes.flatMap(prefix => [prefix, prefix.length + 1, prefix + ':']), ...privateKeys]
    return this.transaction(() => {
      let removed = 0
      for (const table of ['uno_kv', 'uno_hash', 'uno_set', 'uno_zset', 'uno_list']) {
        if (removed >= limit) break
        removed += this.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at<=?${scope} ORDER BY expires_at,rowid LIMIT ?)`, [now, ...args, limit - removed]).changes
      }
      return removed
    })
  }
  async backup(destination: string): Promise<void> { this.ensureOpen(); if (resolve(destination) === resolve(this.path) || existsSync(destination)) throw new Error('session_storage_backup_target_exists'); await sqlite().backup(this.native, destination) }
  close() { if (!this.closed) { this.native.close(); this.closed = true } }
}

export function openSessionDatabase(phone: string, config: SqliteSessionConfig, options: { create?: boolean } = {}): SessionDatabase {
  const path = getSessionSqlitePath(phone, config)
  assertLocalPath(path, config.baseStore, options.create === true)
  let db = connections.get(path)
  if (!db) {
    if (connections.size >= MAX_CONNECTIONS) { const oldest = connections.keys().next().value; if (oldest) closeSessionDatabase(oldest) }
    db = new SessionDatabase(path)
    const meta = db.get<{ value: string }>('SELECT value FROM uno_storage_meta WHERE key=?', ['phone'])
    if (meta && meta.value !== phone) { db.close(); throw new Error('session_storage_identity_mismatch') }
    db.run('INSERT OR IGNORE INTO uno_storage_meta(key,value) VALUES(?,?)', ['phone', phone])
    connections.set(path, db)
  } else {
    if (db.get<{ value: string }>('SELECT value FROM uno_storage_meta WHERE key=?', ['phone'])?.value !== phone) throw new Error('session_storage_identity_mismatch')
    connections.delete(path); connections.set(path, db)
  }
  return db
}

/** Importers receive an already prepared path; never create an absent volume. */
export function openPreparedSessionDatabase(path: string): SessionDatabase {
  if (!isAbsolute(path) || !existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('session_storage_database_missing')
  closeSessionDatabase(path)
  return new SessionDatabase(resolve(path))
}
export function closeSessionDatabase(path: string): void { const key = resolve(path), db = connections.get(key); db?.close(); connections.delete(key) }
export function closeAllSessionDatabases(): void { for (const db of connections.values()) db.close(); connections.clear() }
export function sessionDatabaseConnectionCount(): number { return connections.size }

/** Inspector reads never create a file, migrate schema or change a live connection. */
export function readSessionDatabase<T>(phone: string, config: SqliteSessionConfig, read: (db: NativeDatabase) => T): T {
  const path = getSessionSqlitePath(phone, config)
  assertLocalPath(path, config.baseStore, false)
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; PRAGMA cache_size=-256; PRAGMA mmap_size=0;')
    assertSqliteWalSafeVersion(db.prepare('SELECT sqlite_version() AS version').get()?.version)
    if (db.prepare('SELECT value FROM uno_storage_meta WHERE key=?').get('phone')?.value !== phone) throw new Error('session_storage_identity_mismatch')
    return read(db)
  } finally { db.close() }
}
