import type { Config } from '../config'
import { openSessionDatabase } from './database'
import { pruneSqliteNativeMailbox } from './native_backend'
import { assertLocalStorageOwner, isSqliteSession } from './routing'
import { SessionStorageError, validateSessionPhone } from './types'

export interface SqliteMaintenanceResult {
  at: number; deletedCompatibility: number; deletedNative: number; totalDeleted: number
  rowBudget: number; budgetReached: boolean; freedPages: number
  fileShrunk: false; authCryptoPreserved: true; tombstonesPreserved: true
}

/** One bounded owner-local pass. No socket, Redis source deletion, VACUUM or auth pruning. */
export function maintainSessionSqlite(phone: string, config: Config, options: { now?: number; rowBudget?: number } = {}): SqliteMaintenanceResult {
  validateSessionPhone(phone); assertLocalStorageOwner(config)
  if (!isSqliteSession(config) || !['active', 'offline'].includes(config.sessionStorage!.state)) throw new SessionStorageError(409, 'session_storage_maintenance_requires_sqlite')
  const now = options.now ?? Date.now(), budget = options.rowBudget ?? 500
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(budget) || budget < 1 || budget > 1000) throw new SessionStorageError(400, 'session_storage_prune_limit_invalid')
  const db = openSessionDatabase(phone, config)
  // Split the budget so a large compatibility backlog cannot starve native rows.
  const deletedCompatibility = db.pruneExpired(now, Math.max(1, Math.floor(budget / 2)), phone)
  const deletedNative = deletedCompatibility < budget ? pruneSqliteNativeMailbox(phone, config, now, budget - deletedCompatibility) : 0
  const result: SqliteMaintenanceResult = { at: now, deletedCompatibility, deletedNative, totalDeleted: deletedCompatibility + deletedNative,
    rowBudget: budget, budgetReached: deletedCompatibility + deletedNative === budget,
    freedPages: Number(db.get('PRAGMA freelist_count')?.freelist_count || 0), fileShrunk: false, authCryptoPreserved: true, tombstonesPreserved: true }
  db.run("INSERT INTO uno_storage_meta(key,value) VALUES('maintenance_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(result)])
  return result
}
