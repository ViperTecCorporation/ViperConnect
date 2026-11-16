import type { Config } from '../config'
import { openSessionDatabase, type SessionDatabase } from './database'
import { assertLocalStorageOwner } from './routing'
import { SendError } from '../send_error'
import { extractContactPhoneNumber } from '../zapo/zapo_contact_phone'

export type ContactSyncRecord = { jid: string; pn: string; name: string; username?: string }
export type ContactSyncPage = { contacts: ContactSyncRecord[]; has_more: boolean; next_cursor: string | null }
type PageCursor = { scope: string; phase: 'shadow' | 'native'; after: string }
const normalizeUsername = (value: unknown) => typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase().slice(0, 64) : ''
const phoneNumber = (value: unknown) => {
  if (typeof value !== 'string' || !/^[1-9]\d{6,14}(?::\d+)?(?:@s\.whatsapp\.net)?$/.test(value)) return undefined
  return extractContactPhoneNumber(value)
}
const usernameAt = (db: SessionDatabase, phone: string, lid: unknown, now: number) => {
  if (typeof lid !== 'string' || !/^\d+(?::\d+)?@lid$/.test(lid)) return ''
  const canonical = lid.replace(/:\d+(?=@)/, '')
  const row = db.get('SELECT value FROM uno_hash WHERE key=? AND field=? AND (expires_at IS NULL OR expires_at>?)', [`unoapi-zapo-username-lid:${phone}`, `lid:${canonical}`, now])
  return normalizeUsername(row?.value ? Buffer.from(row.value).toString() : '')
}

/** Read-only keyset pages on the owner, including shadows and native contacts. */
export function queryLocalContactSyncPage(phone: string, config: Config, query: { cursor?: string; limit?: number } = {}, database?: SessionDatabase): ContactSyncPage {
  assertLocalStorageOwner(config)
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new SendError(400, 'session_storage_contact_sync_query_invalid')
  if (config.sessionStorage?.backend !== 'sqlite') throw new SendError(409, 'session_storage_contact_sync_requires_sqlite')
  if (['migrating', 'restoring'].includes(config.sessionStorage.state)) throw new SendError(409, 'session_storage_operation_in_progress')
  const scope = `${phone}:${config.sessionStorage.storageId}:${config.sessionStorage.generation}`
  let current: PageCursor = { scope, phase: 'shadow', after: '' }
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 2048) throw 0
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
      if (parsed.scope !== scope || !['shadow', 'native'].includes(parsed.phase) || typeof parsed.after !== 'string' || parsed.after.length > 1024) throw 0
      current = parsed
    } catch { throw new SendError(400, 'session_storage_contact_sync_cursor_invalid') }
  }
  const limit = query.limit === undefined ? 100 : query.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new SendError(400, 'session_storage_contact_sync_limit_invalid')
  const db = database || openSessionDatabase(phone, config), now = Date.now(), contacts: ContactSyncRecord[] = []
  let rows: any[], next: PageCursor | undefined
  if (current.phase === 'shadow') {
    const prefix = `unoapi-contact-info:${phone}:`
    rows = db.all('SELECT key,value FROM uno_kv WHERE key>=? AND key<? AND key>? AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT ?', [prefix, `${prefix}\uffff`, current.after, now, limit + 1])
    const selected = rows.slice(0, limit)
    for (const row of selected) {
      const jid = row.key.slice(prefix.length)
      if (!/^[1-9]\d{6,14}(?::\d+)?(?:@s\.whatsapp\.net)?$/.test(jid)) continue
      let info: any
      try { info = JSON.parse(Buffer.from(row.value).toString()) } catch { continue }
      const pn = phoneNumber(info?.pn) || phoneNumber(info?.pnJid) || phoneNumber(jid)
      if (!pn) continue
      const username = normalizeUsername(info?.username) || usernameAt(db, phone, info?.lidJid, now)
      contacts.push({ jid: `${pn}@s.whatsapp.net`, pn, name: typeof info?.name === 'string' ? info.name.trim().slice(0, 200) : '', ...(username ? { username } : {}) })
    }
    next = rows.length > limit ? { scope, phase: 'shadow', after: selected.at(-1)!.key } : { scope, phase: 'native', after: '' }
  } else {
    if (!db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='mailbox_contacts'")) return { contacts: [], has_more: false, next_cursor: null }
    rows = db.all(`SELECT c.* FROM mailbox_contacts c WHERE c.session_id=? AND c.jid>? AND NOT EXISTS (SELECT 1 FROM uno_native_expiry e WHERE e.domain='contact' AND e.record_id=c.jid AND e.expires_at<=?) ORDER BY c.jid LIMIT ?`, [phone, current.after, now, limit + 1])
    const selected = rows.slice(0, limit)
    for (const row of selected) {
      const pn = phoneNumber(row.phone_number) || (row.jid.endsWith('@s.whatsapp.net') ? phoneNumber(row.jid) : undefined)
      if (!pn) continue
      const username = normalizeUsername(row.username) || usernameAt(db, phone, row.lid || row.jid, now)
      contacts.push({ jid: `${pn}@s.whatsapp.net`, pn, name: `${row.display_name || row.push_name || ''}`.trim().slice(0, 200), ...(username ? { username } : {}) })
    }
    if (rows.length > limit) next = { scope, phase: 'native', after: selected.at(-1)!.jid }
  }
  return { contacts, has_more: !!next, next_cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null }
}
