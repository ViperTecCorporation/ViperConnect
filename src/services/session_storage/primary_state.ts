import type { WaAuthStore } from 'zapo-js/store'
import type { WaAuthCredentials } from 'zapo-js/auth'
import type { Config } from '../config'
import type { HistoryIndex } from '../mobile_primary/companion_history_stream'
import { openSessionDatabase } from './database'
import { assertLocalStorageOwner, isSqliteSession } from './routing'
import { sessionStorageRpc } from './rpc'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { ZAPO_REDIS_MESSAGES_TTL_MS } from '../../defaults'
import { SendError } from '../send_error'
import type { PrimaryAuthMutation } from '../mobile_primary/primary_bootstrap'
import { NATIVE_MESSAGE_ALIVE_SQL } from './native_expiry_sql'

const validJid = (value: string) => /^\d+(?:@(?:lid|s\.whatsapp\.net)|(?:-\d+)?@g\.us)$/.test(value)

/** Virtual message-index keys for the existing bounded history exporter. No Redis reads or writes. */
export function createSqliteHistoryIndex(phone: string, config: Config, prefix: string): HistoryIndex {
  if (!isSqliteSession(config)) throw new SendError(409, 'session_storage_sqlite_required')
  assertLocalStorageOwner(config)
  const db = openSessionDatabase(phone, config)
  const start = `${resolveZapoRedisKeyPrefix(prefix)}msg:idx:${phone}:`
  const available = () => !!db.get('SELECT name FROM sqlite_master WHERE type=? AND name=?', ['table', 'mailbox_messages'])
  const parameters = () => { const now = Date.now(); return [phone, now - ZAPO_REDIS_MESSAGES_TTL_MS, now, now] }
  return {
    async scan(cursor, options) {
      if (options.MATCH !== start + '*' || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(options.COUNT) || options.COUNT < 1 || options.COUNT > 1000) throw new SendError(400, 'history_index_scope_invalid')
      if (!available()) return { cursor: 0, keys: [] }
      const rows = db.all<{ thread_jid: string }>(`SELECT DISTINCT thread_jid FROM mailbox_messages m WHERE session_id=? AND timestamp_ms>=? AND ${NATIVE_MESSAGE_ALIVE_SQL} ORDER BY thread_jid LIMIT ? OFFSET ?`, [...parameters(), options.COUNT + 1, cursor])
      const page = rows.slice(0, options.COUNT)
      return { cursor: rows.length > options.COUNT ? cursor + options.COUNT : 0, keys: page.filter(row => validJid(row.thread_jid)).map(row => start + row.thread_jid) }
    },
    async zRange(key, from, stop) {
      const jid = key.startsWith(start) ? key.slice(start.length) : ''
      if (!validJid(jid) || !Number.isSafeInteger(from) || !Number.isSafeInteger(stop) || from < 0 || stop < from || stop - from >= 1000) throw new SendError(400, 'history_index_scope_invalid')
      if (!available()) return []
      return db.all<{ message_id: string }>(`SELECT message_id FROM mailbox_messages m WHERE session_id=? AND timestamp_ms>=? AND ${NATIVE_MESSAGE_ALIVE_SQL} AND thread_jid=? ORDER BY timestamp_ms,message_id LIMIT ? OFFSET ?`, [...parameters(), jid, stop - from + 1, from]).map(row => row.message_id)
    },
  }
}

/** HTTP registration must never open the worker's SQLite path or place credentials in HTTP. */
export function primaryAuthStore(phone: string, config: Config, local: () => WaAuthStore,
  rpc: typeof sessionStorageRpc = sessionStorageRpc, mutation?: PrimaryAuthMutation): WaAuthStore {
  if (!isSqliteSession(config) && !mutation) return local()
  return {
    load: () => rpc<WaAuthCredentials | null>(phone, config, 'primary.auth.load', []),
    save: async credentials => {
      if (!mutation) throw new SendError(409, 'session_storage_primary_auth_lease_required')
      await rpc<void>(phone, config, 'primary.auth.save', [credentials, mutation])
    },
    clear: async () => { throw new SendError(409, 'session_storage_primary_auth_clear_requires_explicit_logout') },
  }
}
