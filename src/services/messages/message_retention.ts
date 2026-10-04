export const DEFAULT_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const messageRetentionMs = (value: number) => Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MESSAGE_RETENTION_MS

// WebMessageInfo timestamps are seconds (including protobuf Long); store records use milliseconds.
export const messageTimestampMs = (value: unknown, seconds = false): number | undefined => {
  const numeric = Number(value)
  const ms = numeric * (seconds ? 1000 : 1)
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : undefined
}

export const messageIsExpired = (timestamp: unknown, ttl: number, seconds = false, now = Date.now()) => {
  const ms = messageTimestampMs(timestamp, seconds)
  return ms !== undefined && ms + messageRetentionMs(ttl) <= now
}

// Preserve an earlier expiration when a timestamp is missing or changes on a replay.
export const MESSAGE_DEADLINE_LUA = `
local now=tonumber(ARGV[1]); local ttl=tonumber(ARGV[2]);
local stamp=tonumber(ARGV[3]) or now; stamp=math.min(stamp,now);
local deadline=stamp+ttl;
local remaining=redis.call('PTTL',KEYS[1]);
if remaining>=0 then deadline=math.min(deadline,now+remaining) end;
`

export const SET_RETAINED_MESSAGE_LUA = `${MESSAGE_DEADLINE_LUA}
if deadline<=now then redis.call('DEL',KEYS[1]); return 0 end;
redis.call('SET',KEYS[1],ARGV[4],'PXAT',deadline); return 1;
`
