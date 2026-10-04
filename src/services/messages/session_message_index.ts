import type Redis from 'ioredis'
import type { WaMessageStore, WaStoreBackend, WaStoredMessageRecord } from 'zapo-js'
import { proto } from 'zapo-js'
import { randomUUID } from 'node:crypto'
import { ZAPO_REDIS_MESSAGES_TTL_MS } from '../../defaults'
import logger from '../logger'
import { conversationJid, projectSessionMessage } from './session_message_projection'
import { RedisMessageRetention } from './redis_message_retention'

export const MESSAGE_CHANGE_CHANNEL = 'unoapi:session-messages:changes'
export const MERGE_MESSAGE_STATUS_LUA = `local rank={sent=1,delivered=2,read=3,played=4}; if s.status and v.status and (rank[s.status] or 0)>(rank[v.status] or 0) then v.status=nil; v.error=nil end; for k,x in pairs(v) do s[k]=x end`
const indexes = new Map<string, SessionMessageIndex>()
export const sessionMessageIndex = (prefix: string) => indexes.get(prefix)
const sleepBatch = () => new Promise(resolve => setTimeout(resolve, 25))

export class SessionMessageIndex {
  constructor(readonly redis: Redis, readonly prefix: string, readonly ttl = ZAPO_REDIS_MESSAGES_TTL_MS) {}
  key(phone: string, part: string) { return `${this.prefix}panel:${phone}:${part}` }
  native(phone: string, part: string) { return `${this.prefix}${part}:${phone}` }

  async changed(phone: string, conversationId: string, id?: string) {
    await this.redis.publish(MESSAGE_CHANGE_CHANNEL, JSON.stringify({ phone, conversation_id: conversationId, id }))
  }

  async update(phone: string, records: readonly WaStoredMessageRecord[]) {
    const latest = new Map<string, WaStoredMessageRecord>()
    for (const record of records) {
      if (record.messageBytes) {
        try {
          const protocol = proto.Message.decode(record.messageBytes).protocolMessage
          if (protocol?.key?.id && protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) await this.state(phone, [protocol.key.id], { type: 'revoked', text: 'Mensagem removida', media: null })
          if (protocol?.key?.id && protocol.editedMessage) await this.state(phone, [protocol.key.id], { edited: true, text: protocol.editedMessage.conversation || protocol.editedMessage.extendedTextMessage?.text || '' })
        } catch { /* Unknown protobuf remains a safe unsupported bubble. */ }
      }
      if (!conversationJid(record.threadJid) || !record.timestampMs || record.timestampMs < Date.now() - this.ttl) continue
      const prev = latest.get(record.threadJid)
      if (!prev || record.timestampMs > prev.timestampMs! || (record.timestampMs === prev.timestampMs && record.id > prev.id)) latest.set(record.threadJid, record)
    }
    const pipe = this.redis.pipeline()
    // Atomic comparison prevents out-of-order history/replays overwriting the preview.
    for (const record of latest.values()) {
      const dto = projectSessionMessage(record)
      const summary = { id: record.threadJid, last_message_id: record.id, timestamp_ms: record.timestampMs, preview: dto.text.slice(0, 180) || dto.type, type: dto.type }
      pipe.eval(`local old=redis.call('GET',KEYS[2]); if old then local s=cjson.decode(old); if s.timestamp_ms>tonumber(ARGV[1]) or (s.timestamp_ms==tonumber(ARGV[1]) and s.last_message_id>ARGV[2]) then return 0 end end; redis.call('SET',KEYS[2],ARGV[3],'PXAT',tonumber(ARGV[1])+tonumber(ARGV[4])); redis.call('ZADD',KEYS[1],ARGV[1],ARGV[5]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',tonumber(ARGV[6])-tonumber(ARGV[4])); local latest=redis.call('ZREVRANGE',KEYS[1],0,0,'WITHSCORES'); if #latest>0 then redis.call('PEXPIREAT',KEYS[1],tonumber(latest[2])+tonumber(ARGV[4])) end; return 1`,
        2, this.key(phone, 'conversations'), this.key(phone, `summary:${record.threadJid}`), record.timestampMs!, record.id, JSON.stringify(summary), this.ttl, record.threadJid, Date.now())
    }
    if (latest.size) {
      const results = await pipe.exec()
      if (results?.some(([error]) => error)) throw new Error('session_message_index_write_failed')
      await Promise.all([...latest.values()].map(record => this.changed(phone, record.threadJid, record.id)))
    }
  }

  async state(phone: string, ids: string[], value: Record<string, unknown>) {
    const records = await this.records(phone, ids.slice(0, 100))
    const pipe = this.redis.pipeline()
    for (const record of records) {
      // Merge status/edit overlays without copying content bodies or extending native TTL.
      pipe.eval(`local old=redis.call('GET',KEYS[1]); local s=old and cjson.decode(old) or {}; local v=cjson.decode(ARGV[1]); ${MERGE_MESSAGE_STATUS_LUA}; redis.call('SET',KEYS[1],cjson.encode(s),'PXAT',ARGV[2]); local raw=redis.call('GET',KEYS[2]); if raw and v.text then local sum=cjson.decode(raw); if sum.last_message_id==ARGV[3] then sum.preview=v.text; redis.call('SET',KEYS[2],cjson.encode(sum),'KEEPTTL') end end; return 1`, 2,
        this.key(phone, `state:${record.id}`), this.key(phone, `summary:${record.threadJid}`), JSON.stringify(value), record.timestampMs! + this.ttl, record.id)
    }
    if (records.length) {
      await pipe.exec()
      await Promise.all(records.map(record => this.changed(phone, record.threadJid, record.id)))
    }
  }

  async records(phone: string, ids: string[]): Promise<WaStoredMessageRecord[]> {
    if (!ids.length) return []
    const pipe = this.redis.pipeline()
    for (const id of ids) {
      const key = `${this.native(phone, 'msg')}:${id}`
      pipe.hgetall(key).getBuffer(`${key}:message_bytes`)
    }
    const rows = await pipe.exec()
    if (!rows || rows.some(([error]) => error)) throw new Error('session_message_read_failed')
    return ids.flatMap((id, i) => {
      const data = rows[i * 2][1] as Record<string, string>
      if (!data?.id || Number(data.timestamp_ms) < Date.now() - this.ttl) return []
      return [{ id, threadJid: data.thread_jid, fromMe: data.from_me === '1', timestampMs: Number(data.timestamp_ms), senderJid: data.sender_jid, participantJid: data.participant_jid, messageBytes: rows[i * 2 + 1][1] as Buffer | undefined }]
    })
  }

  // Only initialization scans native index keys, in background under a renewable
  // lock. Requests never scan the message keyspace or fetch remote history.
  async ensure(phone: string) {
    if (await this.redis.get(this.key(phone, 'ready'))) return true
    const owner = randomUUID()
    if (await this.redis.set(this.key(phone, 'lock'), owner, 'PX', 60000, 'NX')) {
      void this.backfill(phone, owner).catch(() => logger.warn('SESSION_MESSAGES_INDEX_FAILED session=%s', phone))
    }
    return false
  }

  async backfill(phone: string, owner: string) {
    try {
      let cursor = '0'
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.native(phone, 'msg:idx')}:*`, 'COUNT', 200)
        cursor = next
        for (let offset = 0; offset < keys.length; offset += 200) {
          if (await this.redis.eval(`if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],60000); return 1`, 1, this.key(phone, 'lock'), owner) !== 1) return
          const batch = keys.slice(offset, offset + 200)
          const pipe = this.redis.pipeline()
          batch.forEach(key => pipe.zrevrange(key, 0, 0))
          const rows = await pipe.exec()
          if (rows?.some(([error]) => error)) throw new Error('session_message_backfill_failed')
          const ids = (rows || []).flatMap(([, value]) => value as string[])
          await this.update(phone, await this.records(phone, ids))
          await sleepBatch()
        }
      } while (cursor !== '0')
      await this.redis.set(this.key(phone, 'ready'), '1', 'PX', this.ttl)
      await this.changed(phone, '')
    } finally {
      await this.redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`, 1, this.key(phone, 'lock'), owner)
    }
  }

  async clear(phone: string) {
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', this.key(phone, '*'), 'COUNT', 200)
      cursor = next
      for (let i = 0; i < keys.length; i += 200) if (keys.slice(i, i + 200).length) await this.redis.unlink(...keys.slice(i, i + 200))
    } while (cursor !== '0')
    await this.changed(phone, '')
  }
}

export const decorateMessageBackend = (backend: WaStoreBackend, redis: Redis, prefix: string): WaStoreBackend => {
  const index = new SessionMessageIndex(redis, prefix)
  indexes.set(prefix, index)
  const factory = backend.stores.messages
  return { ...backend, stores: { ...backend.stores, messages: (phone: string): WaMessageStore => {
    const store = factory.call(backend.stores, phone)
    const retention = new RedisMessageRetention(redis, prefix, phone, store, ZAPO_REDIS_MESSAGES_TTL_MS)
    const indexSafely = async (records: readonly WaStoredMessageRecord[]) => {
      try { await index.update(phone, records) } catch { logger.warn('SESSION_MESSAGES_INDEX_WRITE_FAILED session=%s', phone) }
    }
    return {
      upsert: async record => { await indexSafely(await retention.write([record])) },
      upsertBatch: async records => { await indexSafely(await retention.write(records)) },
      getById: id => retention.getById(id), listByThread: (...args) => retention.listByThread(...args),
      deleteById: async id => { const old = await store.getById(id); const result = await store.deleteById(id); if (old) await index.changed(phone, old.threadJid, id); return result },
      clear: async () => { await store.clear(); await index.clear(phone) },
    }
  } } }
}
