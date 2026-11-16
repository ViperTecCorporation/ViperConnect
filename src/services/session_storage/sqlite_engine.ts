import { assertSqliteWalSafeVersion } from './sqlite_safety'
import { SessionStorageError } from './types'

interface NativeStatement { get(...parameters: unknown[]): Record<string, any> | undefined }
export interface SafeSqliteDatabase {
  prepare(sql: string): NativeStatement
  exec(sql: string): void
  close(): void
}
export interface SafeSqliteEngine {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SafeSqliteDatabase
  backup(source: SafeSqliteDatabase, destination: string, options?: { rate?: number }): Promise<number>
}
export interface SqliteEngineCapability { available: boolean; version?: string; reason?: string }
type Loader = () => SafeSqliteEngine
const nativeLoader: Loader = () => module.require('node:sqlite')
const probes = new WeakMap<Loader, { capability: SqliteEngineCapability; engine?: SafeSqliteEngine }>()

/** Probe an in-memory database before opening a live WAL file. Result is process-local and immutable. */
function probe(loader: Loader): { capability: SqliteEngineCapability; engine?: SafeSqliteEngine } {
  const old = probes.get(loader); if (old) return old
  let database: SafeSqliteDatabase | undefined, version: string | undefined
  try {
    const engine = loader()
    if (typeof engine.DatabaseSync !== 'function' || typeof engine.backup !== 'function') throw new Error('native_api_unavailable')
    database = new engine.DatabaseSync(':memory:')
    const value = database.prepare('SELECT sqlite_version() AS version').get()?.version
    version = typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) && value.length < 30 ? value : undefined
    assertSqliteWalSafeVersion(value)
    const result = { capability: { available: true, version }, engine }; probes.set(loader, result); return result
  } catch (error) {
    const result = { capability: { available: false, version, reason: (error as Error)?.message === 'session_storage_sqlite_version_unsupported' ? 'session_storage_sqlite_version_unsupported' : 'session_storage_sqlite_native_unavailable' } }
    probes.set(loader, result); return result
  } finally { database?.close() }
}

export function sqliteEngineCapability(loader: Loader = nativeLoader): SqliteEngineCapability { return { ...probe(loader).capability } }

export function requireSafeSqliteEngine(): SafeSqliteEngine {
  const value = probe(nativeLoader)
  if (!value.capability.available || !value.engine) throw new SessionStorageError(503, value.capability.reason || 'session_storage_sqlite_native_unavailable')
  return value.engine
}
