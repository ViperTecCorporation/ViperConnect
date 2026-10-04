import type { getConfig } from '../config'
import { ZAPO_REDIS_KEY_PREFIX, UNOAPI_AUTH_TOKEN } from '../../defaults'
import { zapoStoreRegistry } from '../zapo/zapo_store_registry'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { sessionMessageIndex, type SessionMessageIndex } from './session_message_index'
import { conversationJid, projectSessionMessage } from './session_message_projection'
import { SendError } from '../send_error'
import { managerIdentity } from '../manager_identity'
import { unoIdKey, messageStatusKey } from '../redis'
import { normalizeContactPhoneNumber } from '../zapo/zapo_contact_phone'
import { cachedMessageGroups, cachedMessageSenderNames } from './session_message_names'

export const authorizedSessionMessages = async (token: string, phone: string, load: getConfig) => {
  if (!token || !/^\d{8,15}$/.test(phone)) return false
  if (token.startsWith('mgr_')) {
    const principal = await managerIdentity.authenticate(token)
    return !!principal && (principal.role === 'admin' || principal.phones.includes(phone))
  }
  const config = await load(phone)
  return (!!UNOAPI_AUTH_TOKEN && token === UNOAPI_AUTH_TOKEN) || (!!config.authToken && token === config.authToken)
}

export type MessageQuery = { cursor?: string; limit?: number; search?: string; kind?: string; ids?: string[]; statusIds?: string[]; conversationIds?: string[]; around?: string }
export const strongestMessageStatus = (...values: unknown[]): string | undefined => {
  const rank: Record<string, number> = { scheduled: 1, pending: 1, accepted: 1, failed: 2, error: 2, sent: 3, delivered: 4, read: 5, played: 6 }
  return values.filter((value): value is string => typeof value === 'string' && !!rank[value]).sort((a, b) => rank[b] - rank[a])[0]
}
export const messagePageLimit = (limit: number | undefined, fallback: number) => Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit!) : fallback))
const encodeCursor = (scope: string, id: string, score: string) => Buffer.from(JSON.stringify({ scope, id, score })).toString('base64url')
export const decodeMessageCursor = (cursor: string, scope: string) => {
  try {
    if (cursor.length > 2048) throw new Error()
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (value.scope !== scope || typeof value.id !== 'string' || typeof value.score !== 'string') throw new Error()
    return value as { id: string; score: string }
  } catch { throw new SendError(400, 'invalid_message_cursor') }
}

export class SessionMessages {
  constructor(readonly loadConfig: getConfig) {}
  async index(phone: string): Promise<SessionMessageIndex> {
    if (!/^\d{8,15}$/.test(phone)) throw new SendError(400, 'invalid_session_phone')
    const config = await this.loadConfig(phone)
    if (config.provider !== 'zapo' || !config.useRedis) throw new SendError(409, 'session_messages_requires_zapo_redis')
    zapoStoreRegistry.get(config)
    const index = sessionMessageIndex(resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX))
    if (!index) throw new SendError(503, 'session_messages_store_unavailable')
    return index
  }

  private async start(index: SessionMessageIndex, key: string, cursor: string | undefined, scope: string) {
    if (!cursor) return 0
    const value = decodeMessageCursor(cursor, scope)
    const [rank, score] = await Promise.all([index.redis.zrevrank(key, value.id), index.redis.zscore(key, value.id)])
    if (rank === null || score !== value.score) throw new SendError(409, 'message_cursor_expired_reload')
    return rank + 1
  }

  async conversations(phone: string, query: MessageQuery) {
    const index = await this.index(phone)
    const ready = await index.ensure(phone)
    const limit = messagePageLimit(query.limit, 30)
    const search = `${query.search || ''}`.trim().toLowerCase()
    if (search && (search.length < 3 || search.length > 100)) throw new SendError(400, 'message_search_requires_3_to_100_characters')
    if (query.kind && !['all', 'direct', 'group'].includes(query.kind)) throw new SendError(400, 'invalid_conversation_kind')
    const scope = `${phone}:conversations:${query.kind || 'all'}:${search}`
    const key = index.key(phone, 'conversations')
    const start = await this.start(index, key, query.cursor, scope)
    // Bounded search budget; an empty page may still have a continuation cursor.
    if (query.conversationIds && (query.conversationIds.length > 100 || query.conversationIds.some(id => !conversationJid(id)))) throw new SendError(400, 'invalid_conversation_ids')
    const ids = query.conversationIds || await index.redis.zrevrange(key, start, start + 199)
    const pipe = index.redis.pipeline()
    ids.forEach(id => pipe.get(index.key(phone, `summary:${id}`)).hgetall(`${index.native(phone, 'thread')}:${id}`).hgetall(`${index.native(phone, 'contact')}:${id}`))
    const rows = ids.length ? await pipe.exec() : []
    if (rows?.some(([error]) => error)) throw new SendError(503, 'session_messages_read_failed')
    const groups = await cachedMessageGroups(index, phone, ids)
    const data: any[] = []
    let examined = 0
    const stale: string[] = []
    for (let i = 0; i < ids.length; i++) {
      examined++
      const raw = rows?.[i * 3]?.[1] as string
      if (!raw) { stale.push(ids[i]); continue }
      const summary = JSON.parse(raw)
      if (summary.timestamp_ms < Date.now() - index.ttl) { stale.push(ids[i]); continue }
      const thread = rows?.[i * 3 + 1]?.[1] as Record<string, string>
      const contact = rows?.[i * 3 + 2]?.[1] as Record<string, string>
      const group = ids[i].endsWith('@g.us')
      const subject = groups.get(ids[i])?.subject
      const name = (group && typeof subject === 'string' && subject.trim() ? subject.trim() : thread?.name) || contact?.display_name || contact?.push_name || contact?.phone_number || ids[i].split('@')[0]
      const phoneNumber = normalizeContactPhoneNumber(contact?.phone_number || (ids[i].endsWith('@s.whatsapp.net') ? ids[i].split('@')[0] : ''))
      if (query.kind === 'group' && !group || query.kind === 'direct' && group) continue
      if (search && !`${name} ${phoneNumber} ${ids[i]}`.toLowerCase().includes(search)) continue
      data.push({ ...summary, name, phone_number: phoneNumber, picture_id: contact?.lid || ids[i], kind: group ? 'group' : 'direct' })
      if (data.length === limit) break
    }
    const last = ids[examined - 1]
    // Build cursor before pruning; no rank-offset pagination exposed to clients.
    const score = last ? await index.redis.zscore(key, last) : null
    const more = !query.conversationIds && !!last && (await index.redis.zrevrange(key, start + examined, start + examined)).length > 0
    const prune = stale.filter(id => !more || id !== last)
    if (prune.length) await index.redis.zrem(key, ...prune)
    return { data, has_more: more, next_cursor: more && score ? encodeCursor(scope, last, score) : null, indexing: !ready }
  }

  async messages(phone: string, conversationId: string, query: MessageQuery) {
    if (!conversationJid(conversationId)) throw new SendError(400, 'invalid_conversation_id')
    const index = await this.index(phone)
    const limit = messagePageLimit(query.limit, 50)
    const key = `${index.native(phone, 'msg:idx')}:${conversationId}`
    const scope = `${phone}:messages:${conversationId}`
    let start = await this.start(index, key, query.cursor, scope)
    if (query.around) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(query.around) || query.ids || query.cursor) throw new SendError(400, 'invalid_message_around')
      const rank = await index.redis.zrevrank(key, query.around)
      if (rank === null) throw new SendError(404, 'quoted_message_not_available')
      start = Math.max(0, rank - Math.floor(limit / 2))
    }
    if (query.ids && (query.ids.length > 100 || query.ids.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id)))) throw new SendError(400, 'invalid_message_ids')
    if (query.statusIds && (query.statusIds.length > 100 || query.statusIds.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id)))) throw new SendError(400, 'invalid_message_ids')
    const ids = query.ids || await index.redis.zrevrange(key, start, start + limit - 1)
    const records = (await index.records(phone, ids)).filter(record => record.threadJid === conversationId)
    const idPipe = index.redis.pipeline()
    records.forEach(record => idPipe.get(unoIdKey(phone, record.id)).get(index.key(phone, `state:${record.id}`)))
    const mappings = records.length ? await idPipe.exec() : []
    if (mappings?.some(([error]) => error)) throw new SendError(503, 'session_messages_read_failed')
    const legacyPipe = index.redis.pipeline()
    records.forEach((record, i) => legacyPipe.get(messageStatusKey(phone, record.id)).get(messageStatusKey(phone, String(mappings?.[i * 2]?.[1] || record.id))))
    const legacy = records.length ? await legacyPipe.exec() : []
    if (legacy?.some(([error]) => error)) throw new SendError(503, 'session_messages_read_failed')
    const data = records.map((record, i) => {
      const state = mappings?.[i * 2 + 1]?.[1] as string
      const overlay = state ? JSON.parse(state) : {}
      const status = strongestMessageStatus(overlay.status, legacy?.[i * 2]?.[1], legacy?.[i * 2 + 1]?.[1])
      return { ...projectSessionMessage(record), reply_id: mappings?.[i * 2]?.[1] || record.id, ...overlay, ...(status ? { status } : {}) }
    })
    const quoteIds = [...new Set(data.map(message => message.reply_to).filter((id): id is string => !!id && /^[A-Za-z0-9_-]{1,200}$/.test(id)))].slice(0, 100)
    const quotes = (await index.records(phone, quoteIds)).filter(record => record.threadJid === conversationId)
    const quoteStates = index.redis.pipeline()
    quotes.forEach(record => quoteStates.get(index.key(phone, `state:${record.id}`)))
    const quoteRows = quotes.length ? await quoteStates.exec() : []
    if (quoteRows?.some(([error]) => error)) throw new SendError(503, 'session_messages_read_failed')
    const previews = new Map(quotes.map((record, i) => {
      const state = quoteRows?.[i]?.[1] ? JSON.parse(String(quoteRows[i][1])) : {}
      const dto = { ...projectSessionMessage(record, false), ...state }
      return [record.id, { id: record.id, text: dto.text.slice(0, 180), type: dto.type, sender: dto.sender, available: true }]
    }))
    data.forEach(message => { if (message.reply_to && message.type !== 'view_once') message.reply_preview = previews.get(message.reply_to) || message.reply_preview })
    if (conversationId.endsWith('@g.us') && data.length) {
      const groups = await cachedMessageGroups(index, phone, [conversationId])
      const senders = data.flatMap(message => [message.sender, message.reply_preview?.sender]).filter((sender): sender is string => !!sender)
      const names = await cachedMessageSenderNames(index, phone, senders, groups.get(conversationId))
      data.forEach(message => {
        message.sender_name = names.get(message.sender)
        if (message.reply_preview) message.reply_preview = { ...message.reply_preview, sender_name: names.get(message.reply_preview.sender) }
      })
    }
    if (query.around && !data.some(message => message.id === query.around)) throw new SendError(404, 'quoted_message_not_available')
    const last = ids.at(-1)
    const score = last ? await index.redis.zscore(key, last) : null
    const more = !query.ids && !!last && (await index.redis.zrevrange(key, start + ids.length, start + ids.length)).length > 0
    // Expired references pruned only after cursor creation, without touching bodies.
    const valid = new Set(records.map(record => record.id))
    const stale = ids.filter(id => !valid.has(id))
    const prune = stale.filter(id => !more || id !== last)
    if (!query.ids && prune.length) await index.redis.zrem(key, ...prune)
    const statusPipe = index.redis.pipeline()
    query.statusIds?.forEach(id => statusPipe.get(index.key(phone, `outgoing:${id}`)))
    const statuses = query.statusIds?.length ? (await statusPipe.exec() || []).flatMap(([error, value]) => !error && value ? [JSON.parse(String(value))] : []) : []
    return { data, has_more: more, next_cursor: more && score && last ? encodeCursor(scope, last, score) : null, statuses }
  }
}
