import type { Config } from '../config'
import { openSessionDatabase, SessionDatabase } from './database'
import { assertLocalStorageOwner } from './routing'
import { SessionStorageError } from './types'
import { privateSessionKeyOwner } from './private_keys'
import { setSqliteRetainedMessageStatus } from './message_status'
import type { MessageStatus } from '../data_store'
import { assertCurrentSqliteWriteSelection } from './write_fence'

export type SessionStateCommand = { command: string; args: unknown[] }
const tables = ['uno_kv', 'uno_hash', 'uno_set', 'uno_zset'] as const
const maximumResults = 10000
const families = new Set(['zapo-username-lid', 'status-recipients', 'contact-info', 'profile-picture',
  'profile-picture-miss', 'profile-picture-webhook', 'profile-picture-refresh', 'transcription-reference', 'message-status'])
const commands = new Set(['get', 'set', 'del', 'exists', 'expire', 'pExpire', 'ttl', 'pTTL', 'hGet', 'hmGet', 'hSet', 'hDel', 'hKeys', 'hGetAll',
  'zAdd', 'zCard', 'zScore', 'zRange', 'zRangeByScore', 'zRem', 'zRemRangeByScore', 'sAdd', 'sMembers', 'sRem', 'sCard', 'scan',
  'snapshotSet', 'snapshotInvalidate', 'compareSet', 'compareDelete', 'retainedStatusSet'])
const invalid = (code = 'session_storage_state_command_invalid'): never => { throw new SessionStorageError(400, code) }
const text = (value: unknown, maximum = 65536): string => typeof value === 'string' && Buffer.byteLength(value) <= maximum ? value : invalid()
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : invalid()
const list = (value: unknown): unknown[] => Array.isArray(value) && value.length <= 1000 ? value : invalid()
const strings = (value: unknown) => (Array.isArray(value) ? list(value) : [value]).map(item => text(item))
const score = (value: unknown): number => {
  if (value === '-inf') return -Number.MAX_VALUE
  if (value === '+inf') return Number.MAX_VALUE
  return typeof value === 'number' && Number.isFinite(value) ? value : invalid()
}

export function sessionStateKeyOwner(key: unknown): string | undefined {
  if (typeof key !== 'string' || key.length > 1024) return undefined
  const match = /^unoapi-([a-z-]+):([1-9]\d{7,14})(?::|$)/.exec(key)
  return match && families.has(match[1]) ? match[2] : privateSessionKeyOwner(key)
}

function checkedKey(phone: string, value: unknown, pattern = false): string {
  const key = text(value, 1024)
  if (sessionStateKeyOwner(key) !== phone) throw new SessionStorageError(403, 'session_storage_key_scope_invalid')
  if (/[?\[\]\\]/.test(key) || !pattern && key.includes('*')) invalid('session_storage_key_pattern_invalid')
  return key
}

function bounded<T>(values: T[]): T[] {
  if (values.length > maximumResults) throw new SessionStorageError(413, 'session_storage_state_result_too_large')
  return values
}

function removeExpired(db: SessionDatabase, key: string, now: number) {
  for (const table of tables) db.run(`DELETE FROM ${table} WHERE key=? AND expires_at<=?`, [key, now])
}

function keyTable(db: SessionDatabase, key: string): typeof tables[number] | undefined {
  return tables.find(table => db.get(`SELECT 1 FROM ${table} WHERE key=? LIMIT 1`, [key]))
}

function requireTable(db: SessionDatabase, key: string, table: typeof tables[number]) {
  const actual = keyTable(db, key)
  if (actual && actual !== table) throw new SessionStorageError(409, 'session_storage_state_wrong_type')
}

function deadline(db: SessionDatabase, key: string, table: typeof tables[number]): number | null {
  return db.get<{ expires_at: number | null }>(`SELECT MIN(expires_at) AS expires_at FROM ${table} WHERE key=?`, [key])?.expires_at ?? null
}

function deleteKey(db: SessionDatabase, key: string): number {
  let deleted = 0
  for (const table of tables) deleted += db.run(`DELETE FROM ${table} WHERE key=?`, [key]).changes
  return deleted ? 1 : 0
}

function executeOne(db: SessionDatabase, phone: string, request: SessionStateCommand): unknown {
  const { command, args } = request
  if (command === 'scan') {
    const cursor = Number(args[0]), options = args[1] as { MATCH: unknown; COUNT: unknown }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !options || typeof options !== 'object') return invalid()
    const pattern = checkedKey(phone, options.MATCH, true), count = integer(options.COUNT)
    if (count < 1 || count > 1000) return invalid()
    const escaped = pattern.replace(/[%_]/g, '\\$&').replace(/\*/g, '%')
    const rows = db.all<{ key: string }>(`SELECT key FROM (${tables.map(table => `SELECT key FROM ${table} WHERE (expires_at IS NULL OR expires_at>?)`).join(' UNION ')}) WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ? OFFSET ?`,
      [...tables.map(() => Date.now()), escaped, count + 1, cursor])
    return { cursor: rows.length > count ? String(cursor + count) : '0', keys: rows.slice(0, count).map(row => row.key) }
  }
  const key = checkedKey(phone, args[0]), now = Date.now()
  removeExpired(db, key, now)
  if (command === 'retainedStatusSet') {
    const base = `unoapi-message-status:${phone}:`
    if (!key.startsWith(base)) return invalid()
    setSqliteRetainedMessageStatus(db, phone, key.slice(base.length), text(args[1]) as MessageStatus)
    return 'OK'
  }
  if (['snapshotSet', 'snapshotInvalidate', 'compareSet', 'compareDelete'].includes(command)) {
    if (privateSessionKeyOwner(key) !== phone || key.endsWith(':generation')) return invalid()
    requireTable(db, key, 'uno_kv')
    if (command === 'compareDelete') {
      const expected = text(args[1])
      return db.getValue(key)?.toString() === expected ? deleteKey(db, key) : 0
    }
    if (command === 'compareSet') {
      const expected = args[1] === null ? null : text(args[1]), value = text(args[2])
      if ((db.getValue(key)?.toString() ?? null) !== expected) return 0
      db.putValue(key, value); return 1
    }
    const options = args[2] as { generation?: unknown; ttlSeconds?: unknown; deleteSnapshot?: unknown }
    if (!options || typeof options !== 'object' || Array.isArray(options)) return invalid()
    const seconds = integer(options.ttlSeconds)
    if (seconds < 1 || seconds > 7 * 86400) return invalid()
    const generationKey = checkedKey(phone, `${key}:generation`)
    removeExpired(db, generationKey, now); requireTable(db, generationKey, 'uno_kv')
    if (command === 'snapshotSet') {
      const value = text(args[1]), generation = text(options.generation)
      if ((db.getValue(generationKey)?.toString() || '0') !== generation) return null
      db.putValue(key, value, { expiresAt: now + seconds * 1000 }); return 'OK'
    }
    if (typeof options.deleteSnapshot !== 'boolean') return invalid()
    db.putValue(generationKey, text(args[1]), { expiresAt: now + seconds * 1000 })
    return options.deleteSnapshot ? deleteKey(db, key) : 1
  }
  if (command === 'del') return deleteKey(db, key)
  if (command === 'exists') return keyTable(db, key) ? 1 : 0
  if (command === 'expire' || command === 'pExpire') {
    const duration = integer(args[1]), target = now + duration * (command === 'expire' ? 1000 : 1)
    if (!Number.isSafeInteger(target)) return invalid()
    if (target <= now) return deleteKey(db, key)
    let changed = 0
    for (const table of tables) changed += db.run(`UPDATE ${table} SET expires_at=? WHERE key=?`, [target, key]).changes
    return changed ? 1 : 0
  }
  if (command === 'ttl' || command === 'pTTL') {
    const table = keyTable(db, key)
    if (!table) return -2
    const expiration = deadline(db, key, table)
    return expiration === null ? -1 : Math.max(0, command === 'ttl' ? Math.floor((expiration - now) / 1000) : expiration - now)
  }
  if (command === 'get' || command === 'set') {
    if (command === 'get') { requireTable(db, key, 'uno_kv'); return db.getValue(key)?.toString() ?? null }
    const value = text(args[1]); deleteKey(db, key); db.putValue(key, value); return 'OK'
  }
  if (command.startsWith('h')) {
    requireTable(db, key, 'uno_hash')
    const get = (field: unknown) => {
      const value = db.get<{ value: Uint8Array }>('SELECT value FROM uno_hash WHERE key=? AND field=?', [key, text(field)])?.value
      return value === undefined ? null : Buffer.from(value).toString()
    }
    if (command === 'hGet') return get(args[1])
    if (command === 'hmGet') return list(args[1]).map(get)
    if (command === 'hKeys') return bounded(db.all<{ field: string }>('SELECT field FROM uno_hash WHERE key=? ORDER BY field LIMIT ?', [key, maximumResults + 1])).map(row => row.field)
    if (command === 'hGetAll') return Object.fromEntries(bounded(db.all<{ field: string; value: Uint8Array }>('SELECT field,value FROM uno_hash WHERE key=? ORDER BY field LIMIT ?', [key, maximumResults + 1])).map(row => [row.field, Buffer.from(row.value).toString()]))
    if (command === 'hSet') {
      const field = text(args[1]), value = text(args[2]), exists = get(field) !== null
      db.run('INSERT INTO uno_hash(key,field,value,expires_at) VALUES(?,?,?,?) ON CONFLICT(key,field) DO UPDATE SET value=excluded.value', [key, field, Buffer.from(value), deadline(db, key, 'uno_hash')])
      return exists ? 0 : 1
    }
    if (command === 'hDel') return strings(args[1]).reduce((total, field) => total + db.run('DELETE FROM uno_hash WHERE key=? AND field=?', [key, field]).changes, 0)
  }
  if (command.startsWith('s')) {
    requireTable(db, key, 'uno_set')
    if (command === 'sCard') return Number(db.get('SELECT COUNT(*) AS count FROM uno_set WHERE key=?', [key])!.count)
    if (command === 'sMembers') return bounded(db.all<{ member: Uint8Array }>('SELECT member FROM uno_set WHERE key=? ORDER BY member LIMIT ?', [key, maximumResults + 1])).map(row => Buffer.from(row.member).toString())
    if (command === 'sAdd') return strings(args[1]).reduce((total, member) => total + db.run('INSERT OR IGNORE INTO uno_set(key,member,expires_at) VALUES(?,?,?)', [key, Buffer.from(member), deadline(db, key, 'uno_set')]).changes, 0)
    if (command === 'sRem') return strings(args[1]).reduce((total, member) => total + db.run('DELETE FROM uno_set WHERE key=? AND member=?', [key, Buffer.from(member)]).changes, 0)
  }
  if (command.startsWith('z')) {
    requireTable(db, key, 'uno_zset')
    if (command === 'zScore') return db.get<{ score: number }>('SELECT score FROM uno_zset WHERE key=? AND member=?', [key, text(args[1])])?.score ?? null
    if (command === 'zCard') return Number(db.get('SELECT COUNT(*) AS count FROM uno_zset WHERE key=?', [key])!.count)
    if (command === 'zAdd') return list(args[1]).reduce<number>((total, entry: any) => {
      if (!entry || typeof entry !== 'object') return invalid()
      const member = text(entry.value), value = score(entry.score), exists = !!db.get('SELECT 1 FROM uno_zset WHERE key=? AND member=?', [key, member])
      db.run('INSERT INTO uno_zset(key,member,score,expires_at) VALUES(?,?,?,?) ON CONFLICT(key,member) DO UPDATE SET score=excluded.score', [key, member, value, deadline(db, key, 'uno_zset')])
      return total + (exists ? 0 : 1)
    }, 0)
    if (command === 'zRem') return strings(args[1]).reduce((total, member) => total + db.run('DELETE FROM uno_zset WHERE key=? AND member=?', [key, member]).changes, 0)
    if (command === 'zRemRangeByScore') return db.run('DELETE FROM uno_zset WHERE key=? AND score>=? AND score<=?', [key, score(args[1]), score(args[2])]).changes
    if (command === 'zRangeByScore') return bounded(db.all<{ member: string }>('SELECT member FROM uno_zset WHERE key=? AND score>=? AND score<=? ORDER BY score,member LIMIT ?', [key, score(args[1]), score(args[2]), maximumResults + 1])).map(row => row.member)
    if (command === 'zRange') {
      const count = Number(db.get('SELECT COUNT(*) AS count FROM uno_zset WHERE key=?', [key])!.count)
      const first = integer(args[1]), last = integer(args[2]), start = Math.max(0, first < 0 ? count + first : first), stop = last < 0 ? count + last : last
      if (stop < start) return []
      return bounded(db.all<{ member: string }>('SELECT member FROM uno_zset WHERE key=? ORDER BY score,member LIMIT ? OFFSET ?', [key, Math.min(stop - start + 1, maximumResults + 1), start])).map(row => row.member)
    }
  }
  return invalid()
}

/** Narrow state protocol, not a general Redis/Lua or native credential gateway. Atomic batches. */
export function executeSessionStateCommands(phone: string, config: Config, requests: SessionStateCommand[]): unknown[] {
  assertLocalStorageOwner(config)
  assertCurrentSqliteWriteSelection(phone, config)
  if (['migrating', 'restoring'].includes(config.sessionStorage?.state || '')) throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  if (!Array.isArray(requests) || !requests.length || requests.length > 1000 || Buffer.byteLength(JSON.stringify(requests)) > 1024 * 1024) invalid()
  for (const request of requests) {
    if (!request || !commands.has(request.command) || !Array.isArray(request.args) || request.args.length > 3) invalid()
  }
  const db = openSessionDatabase(phone, config)
  return db.transaction(() => {
    const result = requests.map(request => executeOne(db, phone, request))
    if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new SessionStorageError(413, 'session_storage_state_result_too_large')
    return result
  })
}
