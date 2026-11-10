import type Redis from 'ioredis'
import type { SessionDatabase } from './database'

/** Official Redis decoders may read only the captured session, never live Redis.
 * A fixed read instant prevents a TTL expiring between a parent and its binary
 * fields from changing an otherwise consistent decode. Deadlines are never reset. */
export function createNativeSnapshotReader(db: SessionDatabase, phone: string, prefix: string, readAt: number): Redis {
  if (!/^[1-9]\d{7,14}$/.test(phone) || !/^[A-Za-z\d_:]*$/.test(prefix) || !Number.isSafeInteger(readAt)) throw new Error('session_storage_snapshot_scope_invalid')
  const entry = (key: string, expected: string) => {
    if (typeof key !== 'string' || !key.startsWith(prefix) || key.slice(prefix.length).split(':').find(part => /^\d{8,16}$/.test(part)) !== phone) throw new Error('session_storage_snapshot_scope_invalid')
    const row = db.get('SELECT type,expires_at FROM uno_redis_types WHERE key=?', [key])
    if (!row || row.expires_at !== null && row.expires_at <= readAt) return false
    if (row.type !== expected) throw new Error('session_storage_snapshot_type_mismatch')
    return true
  }
  const binary = (key: string) => {
    if (!entry(key, 'string')) return null
    const value = db.getValue(key, readAt)
    if (!value) throw new Error('session_storage_snapshot_value_missing')
    return value
  }
  const fields = (key: string) => entry(key, 'hash') ? db.all('SELECT field,value FROM uno_hash WHERE key=? ORDER BY field', [key]) : []
  const field = (key: string, name: string) => {
    if (!entry(key, 'hash')) return null
    const value = db.get('SELECT value FROM uno_hash WHERE key=? AND field=?', [key, name])?.value
    return value === undefined ? null : Buffer.from(value)
  }
  const commands: Record<string, (...args: any[]) => unknown> = {
    getBuffer: binary,
    get: (key: string) => binary(key)?.toString() ?? null,
    hgetBuffer: field,
    hget: (key: string, name: string) => field(key, name)?.toString() ?? null,
    hgetallBuffer: (key: string) => Object.fromEntries(fields(key).map(row => [row.field, Buffer.from(row.value)])),
    hgetall: (key: string) => Object.fromEntries(fields(key).map(row => [row.field, Buffer.from(row.value).toString()])),
  }
  const fail = () => { throw new Error('session_storage_snapshot_command_unsupported') }
  const reader: Record<string, unknown> = Object.fromEntries(Object.entries(commands).map(([name, run]) => [name, async (...args: unknown[]) => run(...args)]))
  reader.pipeline = () => {
    const queued: Array<() => unknown> = []
    const pipeline: Record<string, unknown> = { exec: async () => queued.map(run => [null, run()]) }
    for (const [name, run] of Object.entries(commands)) pipeline[name] = (...args: unknown[]) => { queued.push(() => run(...args)); return proxy }
    const proxy = new Proxy(pipeline, { get: (target, name) => name in target ? target[name as string] : fail })
    return proxy
  }
  return new Proxy(reader, { get: (target, name) => name in target ? target[name as string] : fail }) as unknown as Redis
}
