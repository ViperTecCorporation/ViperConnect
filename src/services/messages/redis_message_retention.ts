import type Redis from 'ioredis'
import type { WaMessageStore, WaStoredMessageRecord } from 'zapo-js'
import { MESSAGE_DEADLINE_LUA, messageIsExpired, messageRetentionMs, messageTimestampMs } from './message_retention'

// Same schema as @zapo-js/store-redis, but writes/expiration/index pruning are atomic.
export const UPSERT_RETAINED_MESSAGE_LUA = `${MESSAGE_DEADLINE_LUA}
local previous=tonumber(redis.call('HGET',KEYS[1],'timestamp_ms'));
if previous and previous>0 then stamp=math.min(stamp,previous); deadline=math.min(deadline,stamp+ttl) end;
local oldThread=redis.call('HGET',KEYS[1],'thread_jid');
if oldThread and oldThread~=ARGV[5] then redis.call('ZREM',ARGV[6]..oldThread,ARGV[4]) end;
redis.call('ZREMRANGEBYSCORE',KEYS[4],'-inf',now-ttl);
if deadline<=now then
  redis.call('DEL',KEYS[1],KEYS[2],KEYS[3]); redis.call('ZREM',KEYS[4],ARGV[4]); return 0;
end;
local fields=cjson.decode(ARGV[7]);
for k,v in pairs(fields) do redis.call('HSET',KEYS[1],k,v) end;
redis.call('HSET',KEYS[1],'timestamp_ms',stamp);
if ARGV[8]=='1' then redis.call('SET',KEYS[2],ARGV[9]) end;
redis.call('DEL',KEYS[3]);
redis.call('PEXPIREAT',KEYS[1],deadline); redis.call('PEXPIREAT',KEYS[2],deadline);
redis.call('ZADD',KEYS[4],stamp,ARGV[4]);
local latest=redis.call('ZREVRANGE',KEYS[4],0,0,'WITHSCORES');
if #latest>0 then redis.call('PEXPIREAT',KEYS[4],math.min(tonumber(latest[2]),now)+ttl) end;
return stamp;
`

export class RedisMessageRetention {
  readonly ttl: number
  constructor(readonly redis: Redis, readonly prefix: string, readonly phone: string, readonly native: WaMessageStore, ttl: number) {
    this.ttl = messageRetentionMs(ttl)
  }

  async write(records: readonly WaStoredMessageRecord[]): Promise<WaStoredMessageRecord[]> {
    const retained: WaStoredMessageRecord[] = []
    // Bound pipeline size for large history imports; never scan the message keyspace.
    for (let offset = 0; offset < records.length; offset += 200) {
      const batch = records.slice(offset, offset + 200)
      const pipe = this.redis.pipeline()
      const now = Date.now()
      for (const record of batch) {
        const key = `${this.prefix}msg:${this.phone}:${record.id}`
        const indexPrefix = `${this.prefix}msg:idx:${this.phone}:`
        const fields: Record<string, string> = { id: record.id, thread_jid: record.threadJid, from_me: record.fromMe ? '1' : '0' }
        if (record.senderJid !== undefined) fields.sender_jid = record.senderJid
        if (record.participantJid !== undefined) fields.participant_jid = record.participantJid
        pipe.eval(UPSERT_RETAINED_MESSAGE_LUA, 4, key, `${key}:message_bytes`, `${key}:plaintext`, `${indexPrefix}${record.threadJid}`,
          now, this.ttl, messageTimestampMs(record.timestampMs) ?? now, record.id, record.threadJid, indexPrefix,
          JSON.stringify(fields), record.messageBytes !== undefined ? '1' : '0', record.messageBytes !== undefined ? Buffer.from(record.messageBytes) : '')
      }
      const results = await pipe.exec()
      if (!results || results.length !== batch.length || results.some(([error]) => error)) throw new Error('message_retention_write_failed')
      results.forEach(([, stamp], i) => { if (Number(stamp) > 0) retained.push({ ...batch[i], timestampMs: Number(stamp) }) })
    }
    return retained
  }

  async getById(id: string) {
    const record = await this.native.getById(id)
    return record && !messageIsExpired(record.timestampMs, this.ttl) ? record : null
  }

  async listByThread(thread: string, limit?: number, before?: number) {
    const records = await this.native.listByThread(thread, limit, before)
    return records.filter(record => !messageIsExpired(record.timestampMs, this.ttl))
  }
}
