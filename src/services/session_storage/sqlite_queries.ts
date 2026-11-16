import type { Config } from '../config'
import type { WaStoredMessageRecord } from 'zapo-js'
import { openSessionDatabase } from './database'
import { assertLocalStorageOwner } from './routing'
import { projectSessionMessage, conversationJid } from '../messages/session_message_projection'
import { messagePageLimit, strongestMessageStatus } from '../messages/session_messages'
import { ZAPO_REDIS_MESSAGES_TTL_MS } from '../../defaults'
import { SendError } from '../send_error'
import { normalizeContactPhoneNumber } from '../zapo/zapo_contact_phone'
import { NATIVE_MESSAGE_ALIVE_SQL } from './native_expiry_sql'

const json = (db: any, key: string) => { const b = db.getValue(key); if (!b) return {}; try { return JSON.parse(b.toString()) } catch { return {} } }
const text = (db: any, key: string) => db.getValue(key)?.toString()
const native = (row: any): WaStoredMessageRecord => ({ id: row.message_id, threadJid: row.thread_jid, fromMe: !!row.from_me,
  timestampMs: row.timestamp_ms, senderJid: row.sender_jid || undefined, participantJid: row.participant_jid || undefined,
  messageBytes: row.message_bytes ? Buffer.from(row.message_bytes) : undefined })
const cursor = (scope: string, stamp: number, id: string) => Buffer.from(JSON.stringify({ scope, stamp, id })).toString('base64url')
function readCursor(value: string | undefined, scope: string) {
  if (!value) return undefined
  try { const c = JSON.parse(Buffer.from(value, 'base64url').toString()); if (value.length > 2048 || c.scope !== scope || !Number.isSafeInteger(c.stamp) || typeof c.id !== 'string') throw 0; return c }
  catch { throw new SendError(400, 'invalid_message_cursor') }
}
const has = (db: any, name: string) => !!db.get('SELECT name FROM sqlite_master WHERE type=? AND name=?', ['table', name])
const alive = (domain: string, id: string) => `NOT EXISTS (SELECT 1 FROM uno_native_expiry e WHERE e.domain='${domain}' AND e.record_id=${id} AND e.expires_at<=?)`

export class SqliteSessionQueries {
  constructor(readonly phone: string, readonly config: Config) { assertLocalStorageOwner(config) }
  private db() { return openSessionDatabase(this.phone, this.config) }
  record(id: string) {
    const db = this.db()
    if (!has(db, 'mailbox_messages')) return undefined
    if (has(db, 'uno_native_tombstones') && db.get("SELECT 1 AS found FROM uno_native_tombstones WHERE domain='msg' AND record_id=?", [id])) return undefined
    const now = Date.now(), row = db.get<any>(`SELECT m.* FROM mailbox_messages m WHERE session_id=? AND message_id=? AND timestamp_ms>=? AND ${NATIVE_MESSAGE_ALIVE_SQL}`, [this.phone, id, now - ZAPO_REDIS_MESSAGES_TTL_MS, now, now])
    return row ? native(row) : undefined
  }
  private overlay(record: WaStoredMessageRecord) {
    const db = this.db(), prefix = 'unoapi:zapo:'
    const uno = text(db, `unoapi-id:${this.phone}:${record.id}`) || record.id
    const tombstone = has(db, 'uno_native_tombstones') && db.get("SELECT 1 AS found FROM uno_native_tombstones WHERE domain='msg' AND record_id=?", [record.id])
    const state = { ...json(db, `${prefix}panel:${this.phone}:state:${record.id}`), ...(tombstone ? { type: 'revoked', text: 'Mensagem removida', media: null } : {}) }
    const status = strongestMessageStatus(state.status, text(db, `unoapi-message-status:${this.phone}:${record.id}`), text(db, `unoapi-message-status:${this.phone}:${uno}`))
    const dto = { ...projectSessionMessage(record), ...state, reply_id: uno, ...(status ? { status } : {}) }
    if (dto.type === 'revoked') {
      for (const key of ['media', 'contacts', 'buttons', 'location', 'reply_preview']) delete (dto as any)[key]
    }
    if (dto.media && this.config.sessionStorage?.fixture) dto.media = { ...dto.media, available: false }
    return dto
  }
  private senderName(sender: string | undefined, group: any): string | undefined {
    if (!sender) return undefined
    const db = this.db(), canonical = (value: string) => value.replace(/:\d+(?=@)/, '')
    const name = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim()) as string | undefined
    const read = (jid: string) => {
      const row = db.get<any>(`SELECT * FROM mailbox_contacts c WHERE session_id=? AND jid=? AND ${alive('contact', 'c.jid')}`, [this.phone, jid, Date.now()]) || {}
      const info = json(db, `unoapi-contact-info:${this.phone}:${jid}`)
      const participant = group?.participants?.find?.((p: any) => canonical(p.jid || p.id || '') === jid)
      return { name: name(row.display_name, text(db, `unoapi-contact-name:${this.phone}:${jid}`), info.name, row.push_name), alias: name(text(db, `unoapi-jidmap:${this.phone}:pn_for_lid:${jid}`), info.pnJid, row.phone_number, participant?.phoneNumber) }
    }
    const contact = read(canonical(sender))
    const alias = contact.alias && canonical(contact.alias.includes('@') ? contact.alias : `${contact.alias}@s.whatsapp.net`)
    return (contact.name || (alias && /^\d+@s.whatsapp.net$/.test(alias) ? read(alias).name : undefined))?.trim().slice(0, 200)
  }
  conversations(query: any = {}) {
    const db = this.db(), limit = messagePageLimit(query.limit, 30), search = `${query.search || ''}`.trim().toLowerCase()
    if (search && (search.length < 3 || search.length > 100)) throw new SendError(400, 'message_search_requires_3_to_100_characters')
    if (query.kind && !['all', 'direct', 'group'].includes(query.kind)) throw new SendError(400, 'invalid_conversation_kind')
    if (!has(db, 'mailbox_messages')) return { data: [], has_more: false, next_cursor: null, indexing: false }
    const scope = `${this.phone}:sqlite:conversations:${query.kind || 'all'}:${search}`, c = readCursor(query.cursor, scope)
    const now = Date.now(), args: any[] = [this.phone, now - ZAPO_REDIS_MESSAGES_TTL_MS, now, now]
    let where = `m.session_id=? AND m.timestamp_ms>=? AND ${NATIVE_MESSAGE_ALIVE_SQL}`
    if (query.kind === 'group') where += " AND m.thread_jid LIKE '%@g.us'"
    if (query.kind === 'direct') where += " AND m.thread_jid NOT LIKE '%@g.us'"
    if (query.conversationIds) {
      if (!Array.isArray(query.conversationIds) || query.conversationIds.length > 100 || query.conversationIds.some((id: string) => !conversationJid(id))) throw new SendError(400, 'invalid_conversation_ids')
      if (!query.conversationIds.length) return { data: [], has_more: false, next_cursor: null, indexing: false }
      where += ` AND m.thread_jid IN (${query.conversationIds.map(() => '?').join(',')})`; args.push(...query.conversationIds)
    }
    let sql = `SELECT m.thread_jid, MAX(m.timestamp_ms) stamp FROM mailbox_messages m WHERE ${where} GROUP BY m.thread_jid`
    if (c) { sql += ' HAVING stamp < ? OR (stamp = ? AND m.thread_jid < ?)'; args.push(c.stamp, c.stamp, c.id) }
    // Search is filtered in SQL using bounded native contact/thread joins.
    sql = `SELECT q.*, c.display_name,c.push_name,c.phone_number,c.lid,t.name FROM (${sql}) q LEFT JOIN mailbox_contacts c ON c.session_id=? AND c.jid=q.thread_jid AND ${alive('contact', 'c.jid')} LEFT JOIN mailbox_threads t ON t.session_id=? AND t.jid=q.thread_jid AND ${alive('thread', 't.jid')}`
    args.push(this.phone, Date.now(), this.phone, Date.now())
    if (search) { sql += " WHERE instr(lower(coalesce(c.display_name,'')||' '||coalesce(c.push_name,'')||' '||coalesce(c.phone_number,'')||' '||coalesce(t.name,'')||' '||q.thread_jid),?)>0"; args.push(search) }
    sql += ' ORDER BY q.stamp DESC,q.thread_jid DESC LIMIT ?'; args.push(limit + 1)
    const rows = db.all<any>(sql, args), more = rows.length > limit, selected = rows.slice(0, limit)
    const data = selected.filter(row => conversationJid(row.thread_jid)).map(row => {
      const latest = db.get<any>(`SELECT m.* FROM mailbox_messages m WHERE session_id=? AND thread_jid=? AND ${NATIVE_MESSAGE_ALIVE_SQL} ORDER BY timestamp_ms DESC,message_id DESC LIMIT 1`, [this.phone, row.thread_jid, now, now])!
      const dto = this.overlay(native(latest)), group = row.thread_jid.endsWith('@g.us'), cached = json(db, `unoapi-group:${this.phone}:${row.thread_jid}`)
      return { id: row.thread_jid, last_message_id: dto.id, timestamp_ms: row.stamp, preview: dto.text.slice(0, 180) || dto.type, type: dto.type,
        name: (group && cached.subject) || row.name || row.display_name || row.push_name || row.phone_number || row.thread_jid.split('@')[0],
        phone_number: normalizeContactPhoneNumber(row.phone_number || ''), picture_id: row.lid || row.thread_jid, kind: group ? 'group' : 'direct' }
    })
    const last = selected.at(-1)
    return { data, has_more: more, next_cursor: more && last ? cursor(scope, last.stamp, last.thread_jid) : null, indexing: false }
  }
  messages(conversation: string, query: any = {}) {
    if (!conversationJid(conversation)) throw new SendError(400, 'invalid_conversation_id')
    const db = this.db(), limit = messagePageLimit(query.limit, 50), scope = `${this.phone}:sqlite:${conversation}`, c = readCursor(query.cursor, scope)
    if (!has(db, 'mailbox_messages')) return { data: [], has_more: false, next_cursor: null, statuses: [] }
    if (query.around && (!/^[A-Za-z0-9_-]{1,200}$/.test(query.around) || query.ids || query.cursor)) throw new SendError(400, 'invalid_message_around')
    const now = Date.now(), args: any[] = [this.phone, conversation, now - ZAPO_REDIS_MESSAGES_TTL_MS, now, now]; let where = `m.session_id=? AND m.thread_jid=? AND m.timestamp_ms>=? AND ${NATIVE_MESSAGE_ALIVE_SQL}`
    if (query.ids) { if (!Array.isArray(query.ids) || query.ids.length > 100 || query.ids.some((id: string) => !/^[A-Za-z0-9_-]{1,200}$/.test(id))) throw new SendError(400, 'invalid_message_ids'); if (!query.ids.length) return { data: [], has_more: false, next_cursor: null, statuses: [] }; where += ` AND message_id IN (${query.ids.map(() => '?').join(',')})`; args.push(...query.ids) }
    if (c) { where += ' AND (timestamp_ms<? OR (timestamp_ms=? AND message_id<?))'; args.push(c.stamp, c.stamp, c.id) }
    let offset = 0
    if (query.around) {
      const target = this.record(query.around)
      if (!target || target.threadJid !== conversation) throw new SendError(404, 'quoted_message_not_available')
      const newer = db.get<any>(`SELECT COUNT(*) n FROM mailbox_messages m WHERE session_id=? AND thread_jid=? AND timestamp_ms>=? AND ${NATIVE_MESSAGE_ALIVE_SQL} AND (timestamp_ms>? OR (timestamp_ms=? AND message_id>?))`, [this.phone, conversation, now - ZAPO_REDIS_MESSAGES_TTL_MS, now, now, target.timestampMs, target.timestampMs, target.id])?.n || 0
      offset = Math.max(0, Number(newer) - Math.floor(limit / 2))
    }
    const rows = db.all<any>(`SELECT m.* FROM mailbox_messages m WHERE ${where} ORDER BY timestamp_ms DESC,message_id DESC LIMIT ? OFFSET ?`, [...args, limit + 1, offset]), selected = rows.slice(0, limit)
    const data = selected.map(row => this.overlay(native(row)))
    for (const dto of data) if (dto.reply_to && dto.type !== 'view_once') { const quoted = this.record(dto.reply_to); if (quoted?.threadJid === conversation) { const q = this.overlay(quoted); dto.reply_preview = { id: q.id, text: q.text.slice(0, 180), type: q.type, sender: q.sender, available: true } } }
    if (conversation.endsWith('@g.us')) {
      const group = json(db, `unoapi-group:${this.phone}:${conversation}`)
      for (const dto of data) {
        ;(dto as any).sender_name = this.senderName(dto.sender, group)
        if (dto.reply_preview) (dto.reply_preview as any).sender_name = this.senderName(dto.reply_preview.sender, group)
      }
    }
    if (query.around && !data.some(message => message.id === query.around)) throw new SendError(404, 'quoted_message_not_available')
    if (query.statusIds && (!Array.isArray(query.statusIds) || query.statusIds.length > 100 || query.statusIds.some((id: string) => !/^[A-Za-z0-9_-]{1,200}$/.test(id)))) throw new SendError(400, 'invalid_message_ids')
    const statuses = (query.statusIds || []).map((id: string) => json(db, `unoapi:zapo:panel:${this.phone}:outgoing:${id}`)).filter((s: any) => s.id)
    const last = selected.at(-1), more = !query.ids && rows.length > limit
    return { data, has_more: more, next_cursor: more && last ? cursor(scope, last.timestamp_ms, last.message_id) : null, statuses }
  }
  contacts(query: any = {}) {
    const db = this.db(), limit = Math.min(200, Math.max(1, Math.trunc(query.limit || 100))), offset = Math.max(0, Number(query.cursor || 0)), search = `${query.search || ''}`.trim().toLowerCase()
    if (!has(db, 'mailbox_contacts')) return { contacts: [], has_more: false, next_cursor: '0', total_count: 0, raw_total_count: 0, ignored_count: 0 }
    const now = Date.now(), raw = Number(db.get<any>(`SELECT COUNT(*) n FROM mailbox_contacts c WHERE session_id=? AND ${alive('contact', 'c.jid')}`, [this.phone, now])?.n || 0), total = Number(db.get<any>(`SELECT COUNT(*) n FROM mailbox_contacts c WHERE session_id=? AND jid LIKE '%@lid' AND ${alive('contact', 'c.jid')}`, [this.phone, now])?.n || 0)
    const usernameColumn = db.all<any>('PRAGMA table_info(mailbox_contacts)').some(row => row.name === 'username')
    const username = `coalesce(${usernameColumn ? 'c.username,' : ''}(SELECT CAST(h.value AS TEXT) FROM uno_hash h WHERE h.key=? AND h.field='lid:'||coalesce(c.lid,c.jid) AND (h.expires_at IS NULL OR h.expires_at>?) LIMIT 1),'')`
    const rows = db.all<any>(`SELECT q.* FROM (SELECT c.*,${username} resolved_username FROM mailbox_contacts c WHERE session_id=? AND jid LIKE '%@lid' AND ${alive('contact', 'c.jid')}) q WHERE instr(lower(coalesce(display_name,'')||' '||coalesce(push_name,'')||' '||coalesce(phone_number,'')||' '||resolved_username||' '||jid),?)>0 ORDER BY last_updated_ms DESC,jid LIMIT ? OFFSET ?`, [`unoapi-zapo-username-lid:${this.phone}`, now, this.phone, now, search, limit + 1, offset])
    return { contacts: rows.slice(0, limit).map(row => ({ user_id: row.lid || row.jid, phone_number: normalizeContactPhoneNumber(row.phone_number || ''), display_name: row.display_name || undefined, push_name: row.push_name || undefined, username: row.resolved_username || undefined, last_updated_ms: row.last_updated_ms, picture_id: row.lid || row.jid })), has_more: rows.length > limit, next_cursor: rows.length > limit ? String(offset + limit) : '0', total_count: total, raw_total_count: raw, ignored_count: raw - total }
  }
}
