import { proto } from 'zapo-js/proto'
import { messageRetentionMs, messageTimestampMs } from './message_retention'

type RedisStatusClient = {
  mGet: (keys: string[]) => Promise<(string | null)[]>
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
}
type StatusRetentionOptions = { ttlMs: number; nativeTtlMs: number; nativePrefix: string; basePrefix?: string }

export const SET_RETAINED_STATUS_LUA = `
local now=tonumber(ARGV[1]); local deadline=tonumber(ARGV[2]);
local aliases=cjson.decode(ARGV[4]); local messages=cjson.decode(ARGV[5]);
local function cap(key)
  local remaining=redis.call('PTTL',key);
  if remaining>=0 then deadline=math.min(deadline,now+remaining) end;
end;
for _,i in ipairs(aliases) do cap(KEYS[i]) end;
for _,i in ipairs(messages) do
  local stamp=tonumber(redis.call('HGET',KEYS[i],'timestamp_ms'));
  if stamp and stamp>0 then deadline=math.min(deadline,math.min(stamp,now)+tonumber(ARGV[6])) end;
  cap(KEYS[i]);
end;
for i=tonumber(ARGV[7]),#KEYS do cap(KEYS[i]) end;
if deadline<=now then
  for _,i in ipairs(aliases) do redis.call('DEL',KEYS[i]) end;
  return 0;
end;
redis.call('SET',KEYS[1],ARGV[3],'PXAT',deadline);
for _,i in ipairs(aliases) do
  if i~=1 and redis.call('EXISTS',KEYS[i])==1 then redis.call('PEXPIREAT',KEYS[i],deadline) end;
end;
return 1;
`

// Bounded direct lookups only: at most the supplied ID, its provider ID and Uno ID.
// Missing message data uses the first status deadline, never a sliding TTL.
export const setRetainedMessageStatus = async (redis: RedisStatusClient, phone: string, id: string, status: string, options: StatusRetentionOptions) => {
  const base = options.basePrefix ?? 'unoapi-'
  const now = Date.now()
  let deadline = now + messageRetentionMs(options.ttlMs)
  const mapping = await redis.mGet([`${base}id_rev:${phone}:${id}`, `${base}id:${phone}:${id}`])
  const ids = [...new Set([id, ...mapping.filter((value): value is string => !!value)])]
  const metadata = await redis.mGet(ids.map(value => `${base}key:${phone}:${value}`))
  const copies = new Set<string>()
  metadata.forEach((raw, i) => {
    try {
      const key = raw ? JSON.parse(raw) : null
      if (typeof key?.remoteJid === 'string' && key.remoteJid) {
        copies.add(`${base}message:${phone}:${key.remoteJid}:${ids[i]}`)
        if (typeof key.id === 'string' && key.id) copies.add(`${base}message:${phone}:${key.remoteJid}:${key.id}`)
      }
    } catch { /* Unknown metadata still has the bounded first-status deadline. */ }
  })
  const copyKeys = [...copies]
  if (copyKeys.length) {
    const values = await redis.mGet(copyKeys)
    for (const raw of values) {
      if (!raw) continue
      try {
        const message = raw.trim().startsWith('{') ? JSON.parse(raw) : proto.WebMessageInfo.decode(Buffer.from(raw, 'base64'))
        const timestamp = messageTimestampMs(message.messageTimestamp, true)
        if (timestamp !== undefined) deadline = Math.min(deadline, Math.min(timestamp, now) + messageRetentionMs(options.ttlMs))
      } catch { /* Corrupt content does not disable the TTL cap. */ }
    }
  }
  const statuses = ids.map(value => `${base}message-status:${phone}:${value}`)
  const native = ids.map(value => `${options.nativePrefix}msg:${phone}:${value}`)
  const keys = [...statuses, ...native, ...copyKeys]
  return redis.eval(SET_RETAINED_STATUS_LUA, { keys, arguments: [String(now), String(deadline), status,
    JSON.stringify(statuses.map((_, i) => i + 1)), JSON.stringify(native.map((_, i) => statuses.length + i + 1)),
    String(messageRetentionMs(options.nativeTtlMs)), String(statuses.length + native.length + 1)] })
}
