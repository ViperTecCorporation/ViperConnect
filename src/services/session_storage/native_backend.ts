import { proto, type WaStoreBackend, type WaStoredMessageRecord, type WaMessageStore } from 'zapo-js'
import { ensureSqliteMigrations } from '@zapo-js/store-sqlite'
import { ZAPO_REDIS_MESSAGES_TTL_MS, ZAPO_REDIS_CONTACTS_TTL_MS, ZAPO_REDIS_THREADS_TTL_MS } from '../../defaults'
import { messageRetentionMs, messageTimestampMs } from '../messages/message_retention'
import { projectSessionMessage } from '../messages/session_message_projection'
import { openSessionDatabase, type SqliteSessionConfig } from './database'
import { sqliteSdkConnection } from './native_migration'
import { extendNewMessageMappings } from './sqlite_mapping_retention'
import type { SqliteMessageChangeCallback } from './change_events'
import logger from '../logger'
import type { ZapoHistoryReader } from '../zapo/zapo_history'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { NATIVE_MESSAGE_ALIVE_SQL, NATIVE_MESSAGE_EXPIRED_SQL, NATIVE_RECORD_DEADLINE_SQL } from './native_expiry_sql'

const bounded = (value?: number, fallback = 50) => Number.isInteger(value) && value! > 0 ? Math.min(value!, 200) : fallback
const panelStateKey = (phone: string, id: string) => `unoapi:zapo:panel:${phone}:state:${id}`

/** Replay traverses native messages directly, not the bounded thread metadata
 * cache. Composite keyset includes every ID sharing a timestamp, across chats. */
export function sqliteZapoHistoryReader(phone: string, config: SqliteSessionConfig): ZapoHistoryReader {
  return async (cutoff, cursor, until = Date.now()) => {
    const db = openSessionDatabase(phone, config), now = Date.now()
    if (!db.get("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='mailbox_messages'")) return { records: [] }
    db.exec('CREATE INDEX IF NOT EXISTS uno_history_message_order ON mailbox_messages(session_id,timestamp_ms,message_id)')
    const args: unknown[] = [phone, cutoff, until, now - messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS), now, now]
    let where = `m.session_id=? AND m.timestamp_ms>=? AND m.timestamp_ms<=? AND m.timestamp_ms>?
      AND ${NATIVE_MESSAGE_ALIVE_SQL}`
    if (db.get("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='uno_native_tombstones'")) where += " AND NOT EXISTS(SELECT 1 FROM uno_native_tombstones t WHERE t.domain='msg' AND t.record_id=m.message_id)"
    if (cursor) {
      if (!Number.isSafeInteger(cursor.timestampMs) || typeof cursor.id !== 'string' || !cursor.id) throw new Error('session_storage_history_cursor_invalid')
      where += ' AND (m.timestamp_ms>? OR (m.timestamp_ms=? AND m.message_id>?))'; args.push(cursor.timestampMs, cursor.timestampMs, cursor.id)
    }
    const rows = db.all(`SELECT m.* FROM mailbox_messages m WHERE ${where} ORDER BY m.timestamp_ms ASC,m.message_id ASC LIMIT 201`, args), selected = rows.slice(0, 200)
    const records: WaStoredMessageRecord[] = selected.map(row => ({ id: row.message_id, threadJid: row.thread_jid, fromMe: !!row.from_me,
      timestampMs: row.timestamp_ms, senderJid: row.sender_jid || undefined, participantJid: row.participant_jid || undefined,
      messageBytes: row.message_bytes == null ? undefined : Buffer.from(row.message_bytes) }))
    const last = selected.at(-1)
    return { records, ...(rows.length > 200 && last ? { next: { timestampMs: last.timestamp_ms, id: last.message_id } } : {}) }
  }
}

/** Persistent mailbox retention and projections, independent of the Redis control plane. */
export function decorateSqliteBackend(backend: WaStoreBackend, phone: string, config: SqliteSessionConfig, onChange?: SqliteMessageChangeCallback): WaStoreBackend {
  const db = () => openSessionDatabase(phone, config)
  let ready: Promise<void> | undefined
  const initialize = () => ready ||= ensureSqliteMigrations(sqliteSdkConnection(db()), ['mailbox']).then(() => {
    db().exec('CREATE TABLE IF NOT EXISTS uno_native_tombstones(domain TEXT NOT NULL,record_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(domain,record_id))')
    db().exec('CREATE INDEX IF NOT EXISTS uno_history_message_order ON mailbox_messages(session_id,timestamp_ms,message_id)')
  })
  const verify = (session: string) => { if (session !== phone) throw new Error('session_storage_scope_mismatch') }
  const notify = async (conversationId: string, id?: string) => {
    try { await onChange?.(phone, conversationId, id) } catch { logger.warn('SESSION_STORAGE_CHANGE_PUBLISH_FAILED session=%s', phone) }
  }
  const deadline = (domain: string, id: string): number | undefined => db().get(NATIVE_RECORD_DEADLINE_SQL, [domain, id, domain, `${id}:message_bytes`])?.deadline ?? undefined
  const isDeleted = (id: string) => !!db().get('SELECT 1 AS found FROM uno_native_tombstones WHERE domain=? AND record_id=?', ['msg', id])
  const expires = (record: WaStoredMessageRecord, now = Date.now()) => {
    const stamp = messageTimestampMs(record.timestampMs), absolute = deadline('msg', record.id)
    return isDeleted(record.id) || (absolute !== undefined && absolute <= now) || (stamp !== undefined && stamp + messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS) <= now)
  }
  const state = (id: string, value: Record<string, unknown>, expiration: number) => {
    const key = panelStateKey(phone, id), raw = db().getValue(key), previous = raw ? JSON.parse(raw.toString()) : {}
    db().putValue(key, JSON.stringify({ ...previous, ...value }), { encoding: 'json', expiresAt: expiration, keepEarlierExpiry: true })
  }
  const write = async (records: readonly WaStoredMessageRecord[]) => {
    await initialize()
    for (let offset = 0; offset < records.length; offset += 200) {
      const changes = new Map<string, string>()
      db().transaction(() => {
        for (const record of records.slice(offset, offset + 200)) {
          if (!record.id || !record.threadJid) throw new Error('session_storage_native_message_identity_required')
          const old = db().get('SELECT timestamp_ms,from_me,participant_jid,sender_jid,thread_jid FROM mailbox_messages WHERE session_id=? AND message_id=?', [phone, record.id])
          if (old && (old.thread_jid !== record.threadJid || Boolean(old.from_me) !== record.fromMe || (old.participant_jid || '') !== (record.participantJid || '') || (old.sender_jid && record.senderJid && old.sender_jid !== record.senderJid))) throw new Error('session_storage_native_message_identity_conflict')
          const now = Date.now(), stamp = Math.min(messageTimestampMs(record.timestampMs) ?? now, messageTimestampMs(old?.timestamp_ms) ?? now, now)
          const end = Math.min(stamp + messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS), deadline('msg', record.id) ?? Infinity)
          db().run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?) ON CONFLICT(domain,record_id) DO UPDATE SET expires_at=MIN(expires_at,excluded.expires_at)', ['msg', record.id, end])
          if (end <= now || isDeleted(record.id)) continue
          db().run(`INSERT INTO mailbox_messages(session_id,message_id,thread_jid,sender_jid,participant_jid,from_me,timestamp_ms,message_bytes) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(session_id,message_id) DO UPDATE SET sender_jid=COALESCE(excluded.sender_jid,sender_jid),timestamp_ms=MIN(timestamp_ms,excluded.timestamp_ms),message_bytes=COALESCE(excluded.message_bytes,message_bytes)`,
          [phone, record.id, record.threadJid, record.senderJid ?? null, record.participantJid ?? null, record.fromMe ? 1 : 0, stamp, record.messageBytes ?? null])
          extendNewMessageMappings(db(), phone, record.id, end)
          changes.set(record.threadJid, record.id)
          if (record.messageBytes) {
            let protocol: proto.Message.IProtocolMessage | undefined
            try { protocol = proto.Message.decode(record.messageBytes).protocolMessage ?? undefined } catch { /* Opaque bytes remain stored exactly. */ }
            const targetId = protocol?.key?.id
            if (targetId) {
              const target = db().get('SELECT thread_jid,from_me,participant_jid FROM mailbox_messages WHERE session_id=? AND message_id=?', [phone, targetId])
              const identityMatches = target && (protocol?.key?.fromMe === null || protocol?.key?.fromMe === undefined || Boolean(target.from_me) === protocol?.key?.fromMe)
                && (!target.participant_jid || !record.participantJid || target.participant_jid === record.participantJid)
              if (target?.thread_jid === record.threadJid && identityMatches) {
                const expiration = deadline('msg', targetId) ?? end
                if (protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE) state(targetId, { type: 'revoked', text: 'Mensagem removida', media: null }, expiration)
                else if (protocol?.editedMessage) {
                  const projection = projectSessionMessage({ ...record, id: targetId, messageBytes: proto.Message.encode(protocol.editedMessage).finish() })
                  state(targetId, { edited: true, text: projection.text }, expiration)
                }
                changes.set(record.threadJid, targetId)
              }
            }
          }
        }
      })
      for (const [conversation, id] of changes) await notify(conversation, id)
      // A resolved async SDK call only yields a microtask. Permit actual socket,
      // lease and AMQP heartbeat I/O between durable, bounded transactions.
      if (offset + 200 < records.length) await yieldToEventLoop()
    }
  }
  const original = backend.stores!
  return { ...backend, stores: { ...original,
    messages: (session: string): WaMessageStore & { destroy(): Promise<void> } => {
      verify(session); const native = original.messages!(session)
      return {
        destroy: async () => { await (native as WaMessageStore & { destroy?(): Promise<void> }).destroy?.() },
        upsert: record => write([record]), upsertBatch: write,
        getById: async id => { await initialize(); const result = await native.getById(id); return result && !expires(result) ? result : null },
        listByThread: async (thread, limit, before) => {
          await initialize(); const now = Date.now(), max = bounded(limit)
          const ids = db().all(`SELECT m.message_id FROM mailbox_messages m
            WHERE m.session_id=? AND m.thread_jid=? AND (m.timestamp_ms IS NULL OR m.timestamp_ms>?)
            AND (? IS NULL OR m.timestamp_ms<?)
            AND ${NATIVE_MESSAGE_ALIVE_SQL}
            AND NOT EXISTS(SELECT 1 FROM uno_native_tombstones t WHERE t.domain='msg' AND t.record_id=m.message_id)
            ORDER BY m.timestamp_ms DESC,m.message_id DESC LIMIT ?`, [phone, thread, now - messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS), before ?? null, before ?? null, now, now, max])
          const records: WaStoredMessageRecord[] = []
          for (const row of ids) { const value = await native.getById(row.message_id); if (value && !expires(value, now)) records.push(value) }
          return records
        },
        deleteById: async id => {
          await initialize(); const existing = await native.getById(id); if (!existing) return 0
          db().transaction(() => { db().run('INSERT OR IGNORE INTO uno_native_tombstones(domain,record_id,deleted_at) VALUES(?,?,?)', ['msg', id, Date.now()]); state(id, { type: 'revoked', text: 'Mensagem removida', media: null }, deadline('msg', id) ?? Date.now() + messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS)) })
          await notify(existing.threadJid, id)
          return 1
        },
        clear: async () => { await initialize(); await native.clear(); db().transaction(() => { db().run("DELETE FROM uno_native_expiry WHERE domain='msg'"); db().run("DELETE FROM uno_native_tombstones WHERE domain='msg'") }); await notify('') },
      }
    },
    contacts: (session: string) => {
      verify(session); const native = original.contacts!(session)
      const valid = (record: Awaited<ReturnType<typeof native.getByJid>>) => record && (deadline('contact', record.jid) ?? Infinity) > Date.now() ? record : null
      const update = async (record: Parameters<typeof native.upsert>[0]) => { await initialize(); await native.upsert(record); db().run('INSERT OR REPLACE INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['contact', record.jid, Date.now() + messageRetentionMs(ZAPO_REDIS_CONTACTS_TTL_MS)]); await notify(record.jid) }
      return { destroy: async () => { await (native as typeof native & { destroy?(): Promise<void> }).destroy?.() }, upsert: update, upsertBatch: async records => { for (let i = 0; i < records.length; i++) { await update(records[i]); if ((i + 1) % 200 === 0 && i + 1 < records.length) await yieldToEventLoop() } },
        getByJid: async jid => { await initialize(); return valid(await native.getByJid(jid)) },
        getByPhoneNumber: async pn => { await initialize(); return valid(await native.getByPhoneNumber(pn)) },
        deleteByJid: async jid => { await initialize(); const result = await native.deleteByJid(jid); db().run("DELETE FROM uno_native_expiry WHERE domain='contact' AND record_id=?", [jid]); return result },
        clear: async () => { await native.clear(); db().run("DELETE FROM uno_native_expiry WHERE domain='contact'") },
      }
    },
    threads: (session: string) => {
      verify(session); const native = original.threads!(session)
      const valid = (record: Awaited<ReturnType<typeof native.getByJid>>) => record && (deadline('thread', record.jid) ?? Infinity) > Date.now() ? record : null
      const update = async (record: Parameters<typeof native.upsert>[0]) => { await initialize(); await native.upsert(record); db().run('INSERT OR REPLACE INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['thread', record.jid, Date.now() + messageRetentionMs(ZAPO_REDIS_THREADS_TTL_MS)]); await notify(record.jid) }
      return { destroy: async () => { await (native as typeof native & { destroy?(): Promise<void> }).destroy?.() }, upsert: update, upsertBatch: async records => { for (let i = 0; i < records.length; i++) { await update(records[i]); if ((i + 1) % 200 === 0 && i + 1 < records.length) await yieldToEventLoop() } }, getByJid: async jid => { await initialize(); return valid(await native.getByJid(jid)) },
        list: async limit => { await initialize(); const records = await native.list(bounded(limit, 100)); return records.filter(record => !!valid(record)) },
        deleteByJid: async jid => { await initialize(); const result = await native.deleteByJid(jid); db().run("DELETE FROM uno_native_expiry WHERE domain='thread' AND record_id=?", [jid]); return result },
        clear: async () => { await native.clear(); db().run("DELETE FROM uno_native_expiry WHERE domain='thread'") },
      }
    },
  } }
}

/** Bounded disk retention. Keep the expiration tombstone so replay cannot rejuvenate an ID. */
export function pruneSqliteNativeMailbox(phone: string, config: SqliteSessionConfig, now = Date.now(), limit = 200): number {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('session_storage_prune_limit_invalid')
  const db = openSessionDatabase(phone, config)
  return db.transaction(() => {
    let removed = 0
    if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='mailbox_messages'")) removed += db.run(`DELETE FROM mailbox_messages WHERE session_id=? AND message_id IN (
      SELECT m.message_id FROM mailbox_messages m WHERE m.session_id=? AND (m.timestamp_ms<=? OR ${NATIVE_MESSAGE_EXPIRED_SQL}) LIMIT ?)`,
    [phone, phone, now - messageRetentionMs(ZAPO_REDIS_MESSAGES_TTL_MS), now, now, limit]).changes
    for (const [table, domain] of [['mailbox_contacts', 'contact'], ['mailbox_threads', 'thread']]) {
      if (removed >= limit) break
      if (db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])) removed += db.run(`DELETE FROM ${table} WHERE session_id=? AND jid IN (SELECT record_id FROM uno_native_expiry WHERE domain=? AND expires_at<=? LIMIT ?)`, [phone, domain, now, limit - removed]).changes
    }
    // Preserve expiry/tombstone records: old replays must stay expired after pruning.
    return removed
  })
}
