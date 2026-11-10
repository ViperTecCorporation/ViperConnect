import type { SessionDatabase } from './database'

/** Never changes an imported mapping's original absolute deadline during cutover. */
export function extendNewMessageMappings(db: SessionDatabase, phone: string, id: string, messageDeadline: number): number {
  if (!Number.isSafeInteger(messageDeadline) || messageDeadline <= Date.now()) return 0
  const read = (kind: string, value: string) => db.getValue(`unoapi-${kind}:${phone}:${value}`)?.toString()
  const provider = read('id_rev', id) || id, uno = read('id', provider)
  if (!uno) return 0
  const imported = !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='uno_redis_types'")
  let extended = 0
  for (const key of [`unoapi-id:${phone}:${provider}`, `unoapi-id_rev:${phone}:${uno}`]) {
    if (imported && db.get('SELECT 1 AS found FROM uno_redis_types WHERE key=?', [key])) continue
    extended += db.run('UPDATE uno_kv SET expires_at=? WHERE key=? AND expires_at>? AND expires_at<?', [messageDeadline, key, Date.now(), messageDeadline]).changes
  }
  if (extended) db.run("INSERT INTO uno_storage_meta(key,value) VALUES('mapping_retention_extensions',?) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+? AS TEXT)", [String(extended), extended])
  return extended
}

export function associatedMessageDeadline(db: SessionDatabase, phone: string, ids: readonly string[]): number | undefined {
  let deadline: number | undefined
  for (const id of new Set(ids)) {
    const raw = db.getValue(`unoapi-key:${phone}:${id}`)
    if (raw) {
      const metadata = JSON.parse(raw.toString())
      if (typeof metadata?.remoteJid === 'string') {
        for (const candidate of new Set([id, metadata.id].filter(Boolean))) {
          const end = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-message:${phone}:${metadata.remoteJid}:${candidate}`])?.expires_at
          if (typeof end === 'number') deadline = Math.max(deadline ?? 0, end)
        }
      }
    }
    const native = db.get("SELECT MAX(expires_at) AS deadline FROM uno_native_expiry WHERE domain='msg' AND record_id=?", [id])?.deadline
    if (typeof native === 'number') deadline = Math.max(deadline ?? 0, native)
  }
  return deadline
}
