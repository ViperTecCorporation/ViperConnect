import type { Config } from '../config'
import { configs } from '../config'
import { assertLocalStorageOwner, isSqliteSession } from './routing'
import { SessionStorageError } from './types'

function matching(selected: Config, current: Config) {
  if (['migrating', 'restoring'].includes(current.sessionStorage?.state || '')) throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  const before = selected.sessionStorage, now = current.sessionStorage
  if (!now || now.backend !== 'sqlite' || !before || now.storageId !== before.storageId || now.generation !== before.generation || now.owner !== before.owner) {
    throw new SessionStorageError(409, 'session_storage_generation_changed')
  }
}

/** Recheck synchronously immediately before opening/committing SQL; no await may split this guard and the write. */
export function assertCurrentSqliteWriteSelection(phone: string, selected: Config, requireOwner = true) {
  if (!isSqliteSession(selected)) throw new SessionStorageError(409, 'session_storage_sqlite_required')
  if (requireOwner) assertLocalStorageOwner(selected)
  matching(selected, selected)
  const current = configs.get(phone)
  if (current) matching(selected, current)
}

/** Shared control-plane preflight. Fixture-only tests must never need external services. */
export async function assertFreshSqliteWriteSelection(phone: string, selected: Config, requireOwner = true) {
  assertCurrentSqliteWriteSelection(phone, selected, requireOwner)
  if (selected.sessionStorage?.fixture) return
  let raw: string | null | undefined
  try { raw = await (await module.require('../redis').getRedis()).get(`unoapi-config:${phone}`) }
  catch { throw new SessionStorageError(503, 'session_storage_control_unavailable') }
  if (!raw) throw new SessionStorageError(409, 'session_storage_configuration_missing')
  let current: Config
  try { current = JSON.parse(raw) }
  catch { throw new SessionStorageError(503, 'session_storage_configuration_invalid') }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new SessionStorageError(503, 'session_storage_configuration_invalid')
  matching(selected, current)
  assertCurrentSqliteWriteSelection(phone, selected, requireOwner)
}
