import { createHash } from 'node:crypto'
import { projectSessionMessage } from '../messages/session_message_projection'

export const EXPLORER_VALUE_LIMIT = 65536
const sensitive = /token|secret|password|credential|authorization|api.?key|passkey|private|signature|salt|nonce|mediaKey|directPath|identityKey|encKey|macKey|url|href/i
const dataTables = new Set(['uno_kv', 'uno_hash', 'uno_set', 'uno_zset', 'uno_list', 'mailbox_messages', 'mailbox_threads', 'mailbox_contacts', 'chat_metadata_cache', 'group_participants_cache', 'device_list_cache'])
export const explorerTableEditable = (name: string) => dataTables.has(name)
export const explorerEtag = (table: string, row: Record<string, any>) => createHash('sha256').update(table).update(JSON.stringify(row, (_key, value) => {
  if (typeof value === 'bigint') return { integer: String(value) }
  if (value instanceof Uint8Array) return { binary: Buffer.from(value).toString('base64') }
  return value
})).digest('hex')

function safeJson(value: any, depth = 0): any {
  if (depth > 6) return '[Limite de profundidade]'
  if (typeof value === 'string') return value.slice(0, 2048)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeJson(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, sensitive.test(key) ? '[Protegido]' : safeJson(item, depth + 1)]))
  return String(value)
}

/** No credentials, raw protobuf, base64 media or signed CDN URLs leave the inspector. */
export function explorerCell(table: string, column: string, value: any, row: Record<string, any>) {
  if (value === null) return { value: null, editable: true }
  const binary = value instanceof Uint8Array, bytes = binary ? Buffer.from(value) : Buffer.from(String(value))
  if (sensitive.test(column) || sensitive.test(String(row.key || ''))) return { value: '[Protegido]', bytes: bytes.length, editable: false }
  if (column === 'message_bytes' && table === 'mailbox_messages' && bytes.length <= EXPLORER_VALUE_LIMIT) {
    const projected = projectSessionMessage({ id: row.message_id, threadJid: row.thread_jid, fromMe: !!row.from_me, timestampMs: Number(row.timestamp_ms), messageBytes: bytes }, false)
    return { value: { type: projected.type, text: projected.text.slice(0, 2048) }, bytes: bytes.length, editable: false, format: 'message-preview' }
  }
  if (typeof value === 'number' || typeof value === 'bigint') return { value: String(value), editable: true, format: 'number' }
  const text = bytes.toString('utf8')
  if (bytes.length > EXPLORER_VALUE_LIMIT || !Buffer.from(text).equals(bytes) || /[\x00-\x08\x0e-\x1f]/.test(text)) return { value: '[Binário]', bytes: bytes.length, editable: false }
  let parsed: any
  try { parsed = JSON.parse(text) } catch { /* Plain text/ID. */ }
  const preview = parsed !== undefined ? safeJson(parsed) : text.slice(0, 4096)
  // Redacted or truncated fields cannot be accidentally saved back over originals.
  const exact = bytes.length <= 4096 && (parsed === undefined || JSON.stringify(parsed) === JSON.stringify(preview))
  return { value: preview, bytes: bytes.length, editable: exact, format: binary ? 'utf8-blob' : 'text', ...(exact ? { input: text } : {}) }
}
