import type { Config } from '../config'
import { ZAPO_REDIS_MESSAGES_TTL_MS } from '../../defaults'
import { MESSAGE_CHANGE_CHANNEL } from '../messages/session_message_index'
import { assertLocalStorageOwner } from './routing'
import { openSessionDatabase, type SessionDatabase } from './database'
import { messageRetentionMs } from '../messages/message_retention'
import { SendError } from '../send_error'
import { assertFreshSqliteWriteSelection, assertCurrentSqliteWriteSelection } from './write_fence'

export type PublicSessionStatus = { id: string; status: 'sent' | 'failed' | 'delivered' | 'read' | 'played' }
type Change = { phone: string; conversation_id: string; id?: string; outgoing?: { id: string; status: string; error?: string } }
export type PublishStatusChange = (change: Change) => Promise<void>
const prefix = 'unoapi:zapo:panel:'
const rank: Record<string, number> = { failed: 0, sent: 1, delivered: 2, read: 3, played: 4 }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)
const read = (db: SessionDatabase, key: string) => { const raw = db.getValue(key); if (!raw) return {}; try { return JSON.parse(raw.toString()) || {} } catch { return {} } }
const merge = (previous: any, value: any) => {
  const next = { ...previous, ...value }
  if ((rank[previous.status] ?? -1) > (rank[value.status] ?? -1)) next.status = previous.status
  if (next.status !== 'failed') delete next.error
  return next
}
const publish: PublishStatusChange = async change => {
  const { getRedis } = module.require('../redis.js') as typeof import('../redis')
  await (await getRedis()).publish(MESSAGE_CHANGE_CHANNEL, JSON.stringify(change))
}
function nativeRecord(db: SessionDatabase, phone: string, id: string, now: number) {
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='mailbox_messages'")) return undefined
  if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='uno_native_tombstones'") && db.get("SELECT 1 found FROM uno_native_tombstones WHERE domain='msg' AND record_id=?", [id])) return undefined
  const row = db.get<{ message_id: string; thread_jid: string; timestamp_ms: number }>('SELECT message_id,thread_jid,timestamp_ms FROM mailbox_messages WHERE session_id=? AND message_id=?', [phone, id])
  if (!row) return undefined
  const imported = db.get("SELECT MIN(expires_at) deadline FROM uno_native_expiry WHERE domain='msg' AND record_id IN (?,?)", [id, `${id}:message_bytes`])?.deadline
  const deadline = Math.min(Number(row.timestamp_ms) + messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS), typeof imported === 'number' ? imported : Infinity)
  return Number.isFinite(deadline) && deadline > now ? { ...row, deadline } : undefined
}

/** Worker-only state projection. Commits first; the shared bus contains invalidation metadata only. */
export async function applySqliteStatuses(phone: string, config: Config, statuses: PublicSessionStatus[], notify: PublishStatusChange = publish) {
  assertLocalStorageOwner(config)
  if (!Array.isArray(statuses) || statuses.length > 100 || statuses.some(item => !validId(item?.id) || !Object.prototype.hasOwnProperty.call(rank, item.status))) throw new SendError(400, 'session_storage_statuses_invalid')
  await assertFreshSqliteWriteSelection(phone, config)
  assertCurrentSqliteWriteSelection(phone, config)
  const db = openSessionDatabase(phone, config), now = Date.now(), changes: Change[] = []
  db.transaction(() => {
    for (const status of statuses) {
      const outgoingKey = `${prefix}${phone}:outgoing:${status.id}`
      const outgoing = merge(read(db, outgoingKey), { id: status.id, status: status.status, ...(status.status === 'failed' ? { error: 'O envio falhou no worker. Consulte o diagnóstico do webhook.' } : {}) })
      db.putValue(outgoingKey, JSON.stringify(outgoing), { expiresAt: now + messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS), encoding: 'json', keepEarlierExpiry: true })
      changes.push({ phone, conversation_id: '', outgoing: { id: status.id, status: outgoing.status, ...(outgoing.status === 'failed' ? { error: 'O envio falhou no worker. Consulte o diagnóstico do webhook.' } : {}) } })
      const provider = db.getValue(`unoapi-id_rev:${phone}:${status.id}`)?.toString() || status.id
      const record = nativeRecord(db, phone, provider, now)
      if (!record) continue
      const stateKey = `${prefix}${phone}:state:${provider}`
      db.putValue(stateKey, JSON.stringify(merge(read(db, stateKey), { status: status.status })), { expiresAt: record.deadline, encoding: 'json', keepEarlierExpiry: true })
      changes.push({ phone, conversation_id: record.thread_jid, id: provider })
    }
  })
  for (const change of changes) await notify(change)
  return { applied: statuses.length }
}

/** Receipts/edits operate only on existing records; caller passes a bounded public projection, not raw protocol bytes. */
export async function applySqliteMessageEvent(phone: string, config: Config, ids: string[], value: { status?: string; edited?: boolean; text?: string }, notify: PublishStatusChange = publish) {
  assertLocalStorageOwner(config)
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !validId(id)) || !value || Object.keys(value).some(key => !['status', 'edited', 'text'].includes(key))
    || value.status !== undefined && !['delivered', 'read', 'played'].includes(value.status) || value.edited !== undefined && value.edited !== true || value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 16000)) throw new SendError(400, 'session_storage_message_event_invalid')
  await assertFreshSqliteWriteSelection(phone, config)
  assertCurrentSqliteWriteSelection(phone, config)
  const db = openSessionDatabase(phone, config), changes: Change[] = [], now = Date.now()
  db.transaction(() => {
    for (const id of new Set(ids)) {
      const record = nativeRecord(db, phone, id, now)
      if (!record) continue
      const key = `${prefix}${phone}:state:${id}`, previous = read(db, key)
      if (value.edited && previous.type === 'revoked') continue
      const state = value.status ? merge(previous, value) : { ...previous, ...value }
      db.putValue(key, JSON.stringify(state), { expiresAt: record.deadline, keepEarlierExpiry: true, encoding: 'json' })
      changes.push({ phone, conversation_id: record.thread_jid, id })
    }
  })
  for (const change of changes) await notify(change)
  return { applied: changes.length }
}
