import { validateSessionPhone } from './types'

interface QueryDatabase { get(sql: string, parameters: unknown[]): Record<string, any> | undefined }

/** Expired references are historical garbage, not live mappings. Check every live direction. */
export function validateLiveIdMappings(database: QueryDatabase, phone: string, now = Date.now()): boolean {
  validateSessionPhone(phone)
  const forward = `unoapi-id:${phone}:`, reverse = `unoapi-id_rev:${phone}:`
  for (const [source, target] of [[forward, reverse], [reverse, forward]]) {
    const invalid = database.get(`SELECT COUNT(*) n FROM uno_kv f LEFT JOIN uno_kv r ON r.key=?||CAST(f.value AS TEXT)
      WHERE substr(f.key,1,?)=? AND (f.expires_at IS NULL OR f.expires_at>?)
      AND (r.value IS NULL OR (r.expires_at IS NOT NULL AND r.expires_at<=?) OR CAST(r.value AS TEXT)!=substr(f.key,?))`,
    [target, source.length, source, now, now, source.length + 1])
    if (Number(invalid?.n) !== 0) return false
  }
  return true
}
