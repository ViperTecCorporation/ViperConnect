import type { Config } from '../config'
import { readSessionDatabase } from './database'
import { assertLocalStorageOwner } from './routing'
import { SessionStorageError, validateSessionPhone } from './types'
import { explorerCell, explorerEtag, explorerTableEditable, EXPLORER_VALUE_LIMIT } from './explorer_values'
import { isSessionCompatibilityDataKey } from './source_scope'

export type ExplorerQuery = { table?: string; search?: string; cursor?: string; limit?: string }
const invalid = () => new SessionStorageError(400, 'session_storage_explorer_invalid_query')
export function validateExplorerQuery(input: any): ExplorerQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['table', 'search', 'cursor', 'limit'].includes(key))) throw invalid()
  if (Object.values(input).some(value => typeof value !== 'string')) throw invalid()
  if (input.table !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(input.table) || (input.search?.length || 0) > 120 || (input.cursor?.length || 0) > 2048
    || input.limit !== undefined && (!/^\d{1,2}$/.test(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50)
    || !input.table && (input.search || input.cursor)) throw invalid()
  return input
}

export function explorerSchema(db: any) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 80").all()
    .filter((r: any) => /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(r.name)).map((r: any) => ({ name: r.name, editable: explorerTableEditable(r.name) && !/WITHOUT\s+ROWID/i.test(r.sql), protected: !explorerTableEditable(r.name) }))
}
export function explorerColumns(db: any, table: string) {
  if (!explorerSchema(db).some((t: any) => t.name === table && t.editable)) throw new SessionStorageError(403, 'session_storage_explorer_protected_table')
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map((r: any) => ({ name: r.name, type: r.type, required: (!!r.notnull || !!r.pk) && r.dflt_value === null, primaryKey: !!r.pk }))
  if (columns.length > 64 || columns.some((c: any) => !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(c.name))) throw new SessionStorageError(409, 'session_storage_explorer_schema_unsupported')
  return columns
}
export function explorerRecord(db: any, table: string, rowId: string) {
  if (!/^[1-9]\d{0,17}$/.test(rowId)) throw invalid()
  const columns = explorerColumns(db, table)
  const expressions = columns.map((c: any) => `CASE WHEN length(CAST("${c.name}" AS BLOB))>${EXPLORER_VALUE_LIMIT} THEN 1 ELSE 0 END`)
  const tooLarge = db.prepare(`SELECT ${expressions.join('+')} AS n FROM "${table}" WHERE rowid=?`).get(BigInt(rowId))
  if (!tooLarge) throw new SessionStorageError(404, 'session_storage_explorer_record_not_found')
  if (Number(tooLarge.n)) throw new SessionStorageError(413, 'session_storage_explorer_record_too_large')
  return db.prepare(`SELECT * FROM "${table}" WHERE rowid=?`).get(BigInt(rowId))
}

/** Read-only, bounded rowid pages. A sparse search can return an empty page with continuation. */
export function exploreSessionDatabase(phone: string, config: Config, input: unknown) {
  validateSessionPhone(phone); assertLocalStorageOwner(config)
  if (config.sessionStorage?.backend !== 'sqlite') throw new SessionStorageError(409, 'session_storage_sqlite_required')
  if (['migrating', 'restoring'].includes(config.sessionStorage.state)) throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  const query = validateExplorerQuery(input), descriptor = config.sessionStorage
  return readSessionDatabase(phone, config, db => {
    const tables = explorerSchema(db), base = { phone, backend: 'sqlite', generation: descriptor.generation, tables }
    if (!query.table) return { ...base, rows: [], nextCursor: null, hasMore: false }
    const table = query.table, columns = explorerColumns(db, table), search = query.search || '', limit = Number(query.limit || 25)
    let after = '0'
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
        if (cursor.phone !== phone || cursor.storageId !== descriptor.storageId || cursor.generation !== descriptor.generation || cursor.table !== table || cursor.search !== search || !/^\d{1,18}$/.test(cursor.after)) throw invalid()
        after = cursor.after
      } catch { throw invalid() }
    }
    const ids = db.prepare(`SELECT CAST(rowid AS TEXT) AS id FROM "${table}" WHERE rowid>? ORDER BY rowid LIMIT 201`).all(BigInt(after))
    const rows: any[] = []; let scanned = 0, payloadBytes = 0, hasMore = false
    for (const { id } of ids.slice(0, 200)) {
      let row: Record<string, any>
      try { row = explorerRecord(db, table, id) }
      catch (error) {
        if (!(error instanceof SessionStorageError) || error.code !== 'session_storage_explorer_record_too_large') throw error
        rows.push({ id, key: `Registro ${id} · conteúdo excede 64 KiB por campo`, cells: {} }); scanned++; after = id
        if (rows.length >= limit) { hasMore = scanned < ids.length; break }
        continue
      }
      const key = String(row.key ?? row.message_id ?? row.contact_jid ?? row.thread_jid ?? row.jid ?? id)
      // This DB is session-scoped; native rows still carry an explicit session_id fence.
      const scoped = row.key === undefined || isSessionCompatibilityDataKey(String(row.key), phone) || String(row.key).startsWith(`unoapi:zapo:panel:${phone}:`)
      if (scoped && (!row.session_id || row.session_id === phone) && (!search || key.toLowerCase().includes(search.toLowerCase()))) {
        const cells = Object.fromEntries(columns.map((c: any) => [c.name, explorerCell(table, c.name, row[c.name], row)]))
        const entry = { id, key: key.slice(0, 512), etag: explorerEtag(table, row), cells }
        const size = Buffer.byteLength(JSON.stringify(entry))
        if (rows.length && payloadBytes + size > 196608) { hasMore = true; break }
        rows.push(entry); payloadBytes += size
      }
      scanned++; after = id
      if (rows.length >= limit) { hasMore = scanned < ids.length; break }
    }
    hasMore ||= scanned < ids.length
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ phone, storageId: descriptor.storageId, generation: descriptor.generation, table, search, after })).toString('base64url') : null
    return { ...base, table, columns, rows, scanned, hasMore, nextCursor, searchScope: 'keys-and-identifiers' }
  })
}
