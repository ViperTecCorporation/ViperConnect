/** Explicit conditional operations for snapshots; no arbitrary Redis Lua reaches SQLite/RPC. */
export async function saveSnapshot(state: any, key: string, generation: string, value: string, ttlSeconds: number) {
  if (typeof state.snapshotSet === 'function') return state.snapshotSet(key, value, { generation, ttlSeconds })
  return state.eval("if (redis.call('GET', KEYS[2]) or '0') == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return nil", {
    keys: [key, `${key}:generation`], arguments: [generation, value, String(ttlSeconds)],
  })
}

export async function invalidateSnapshot(state: any, key: string, generation: string, ttlSeconds: number, deleteSnapshot: boolean) {
  if (typeof state.snapshotInvalidate === 'function') return state.snapshotInvalidate(key, generation, { ttlSeconds, deleteSnapshot })
  const script = deleteSnapshot ? "redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return redis.call('DEL', KEYS[1])"
    : "redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return 1"
  return state.eval(script, { keys: [key, `${key}:generation`], arguments: [generation, String(ttlSeconds)] })
}
