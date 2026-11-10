import type { Config } from '../config'
import { configs } from '../config'
import { storageRoot } from './capability'
import { assertLocalStorageOwner, isStorageWorker, storageOwner } from './routing'
import { SessionStorageError } from './types'
import { privateSessionKeyOwner } from './private_keys'
import { SESSION_COMPATIBILITY_DATA_FAMILIES } from './source_scope'

const FAMILIES = new Set(SESSION_COMPATIBILITY_DATA_FAMILIES)
export function compatibilityKeyOwner(key: string) {
  const match = /^unoapi-([a-z_-]+):([1-9]\d{7,14})(?::|$)/.exec(key)
  return match && FAMILIES.has(match[1]) ? match[2] : privateSessionKeyOwner(key)
}

/** Route old helper call-sites too, rather than silently recreating shadows in Redis. */
export async function routeCompatibilityValue(key: string, operation: 'get' | 'set' | 'delete' | 'keys', rawRedis: any, value?: string, ttl?: number): Promise<{ handled: boolean; value?: any }> {
  const phone = compatibilityKeyOwner(key)
  if (!phone) return { handled: false }
  let config = configs.get(phone)
  if (!config) {
    const raw = await rawRedis.get(`unoapi-config:${phone}`)
    if (!raw) return { handled: false }
    try { config = JSON.parse(raw) } catch { throw new SessionStorageError(503, 'session_storage_configuration_invalid') }
  }
  if (config?.sessionStorage?.backend !== 'sqlite') return { handled: false }
  if (isStorageWorker() && config.sessionStorage.owner === storageOwner()) return { handled: true, value: executeCompatibilityValue(phone, { ...config, baseStore: storageRoot() }, operation, key, value, ttl) }
  const { getConfigRedis } = module.require('../config_redis')
  const { sessionStorageRpc } = module.require('./rpc')
  return { handled: true, value: await sessionStorageRpc(phone, await getConfigRedis(phone), `compat.${operation}`, [key, value, ttl]) }
}

export function executeCompatibilityValue(phone: string, config: Config, operation: string, key: string, value?: string, ttl?: number) {
  assertLocalStorageOwner(config)
  if (['migrating', 'restoring'].includes(config.sessionStorage?.state || '')) throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  if (compatibilityKeyOwner(key) !== phone) throw new SessionStorageError(403, 'session_storage_key_scope_invalid')
  const { openSessionDatabase } = module.require('./database')
  const db = openSessionDatabase(phone, config)
  if (operation === 'get') return db.getValue(key)?.toString() ?? null
  if (operation === 'delete') return db.deleteValue(key) ? 1 : 0
  if (operation === 'keys') {
    if (key.length > 1024 || /[?\[\]\\]/.test(key)) throw new SessionStorageError(400, 'session_storage_key_pattern_invalid')
    const escaped = key.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%')
    return db.all("SELECT key FROM uno_kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT 10000", [escaped, Date.now()]).map((row: any) => row.key)
  }
  if (operation === 'set') {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024 || ttl !== undefined && (!Number.isFinite(ttl) || ttl < -1)) throw new SessionStorageError(400, 'session_storage_value_invalid')
    db.putValue(key, value, { expiresAt: ttl !== undefined && ttl >= 0 ? Date.now() + ttl * 1000 : null })
    return 'OK'
  }
  throw new SessionStorageError(400, 'session_storage_invalid_operation')
}
