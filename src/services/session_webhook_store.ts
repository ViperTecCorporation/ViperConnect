import { randomUUID } from 'crypto'
import { getRedis, configKey, sessionPhoneIndexKey } from './redis'
import { SessionLifecycleEvent, SessionWebhookDelivery, SessionWebhookDestination } from './session_webhook_types'

export const SESSION_WEBHOOK_KEYS = {
  destinations: 'unoapi-session-webhooks:destinations',
  states: 'unoapi-session-webhooks:states',
  outbox: 'unoapi-session-webhooks:outbox',
  heartbeat: 'unoapi-session-webhooks:heartbeat',
}

// The state transition and its delivery snapshots are one Redis operation.
// Deletion also removes the configuration in that same operation: a late socket
// callback cannot resurrect the session or lose the removed event's recipients.
export const SESSION_EVENT_LUA = `
local operation, phone = ARGV[1], ARGV[2]
local event = cjson.decode(ARGV[3])
local heartbeatObservation = event.event == 'session.heartbeat'
local rawConfig = redis.call('GET', KEYS[5])
if operation == 'save_config' then
  local isNew = not rawConfig
  rawConfig = ARGV[6]
  -- Parse before writing so malformed input never leaves a half-created config.
  cjson.decode(rawConfig)
  if tonumber(ARGV[7]) < 0 then redis.call('SET', KEYS[5], rawConfig)
  else redis.call('SET', KEYS[5], rawConfig, 'EX', ARGV[7]) end
  redis.call('SADD', KEYS[6], phone)
  if not isNew then return 1 end
  operation = 'register'
end
if not rawConfig then
  if operation == 'remove' then redis.call('SREM', KEYS[6], phone) end
  return 0
end
local config = cjson.decode(rawConfig)
local previousRaw = redis.call('HGET', KEYS[2], phone)
local previous = previousRaw and cjson.decode(previousRaw) or nil
if operation == 'register' then
  local rows = redis.call('HGETALL', KEYS[1])
  for i = 1, #rows, 2 do
    local d = cjson.decode(rows[i+1])
    if d.auto_include_new_sessions and d.server == (config.server or 'server_1') and config.provider == 'zapo' then
      local found = false
      for _, id in ipairs(d.session_ids) do if id == phone then found = true end end
      if not found and #d.session_ids < 1000 then
        table.insert(d.session_ids, phone)
        redis.call('HSET', KEYS[1], rows[i], cjson.encode(d))
      end
    end
  end
  -- Fence callbacks from a previous incarnation without inventing a connection.
  if previous then
    event.state.sequence = previous.state.sequence + 1
    event.state.previous = previous.state.current
    event.connection.reason = 'session_registered_pending_observation'
    event.session.provider = config.provider or 'baileys'
    event.session.server = config.server or 'server_1'
    event.session.label = type(config.label) == 'string' and config.label or cjson.null
    redis.call('HSET', KEYS[2], phone, cjson.encode(event))
  end
  return 1
end
if operation ~= 'remove' and previous and (event.occurred_at < previous.last_observed_at or event.occurred_at < previous.occurred_at) then return 0 end
if ARGV[4] ~= '' and (not previous or previous.last_observed_at ~= ARGV[4]) then return 0 end
event.session.label = type(config.label) == 'string' and config.label or cjson.null
event.session.provider = config.provider or 'baileys'
event.session.server = config.server or 'server_1'
local changed = not previous or previous.state.current ~= event.state.current
if changed and event.event == 'session.heartbeat' then event.event = 'session.connected' end
event.state.previous = previous and previous.state.current or cjson.null
event.state.sequence = previous and previous.state.sequence + 1 or 1
if not changed then event.state.changed_at = previous.state.changed_at end
if ARGV[1] == 'remove' or heartbeatObservation or event.event == 'session.unavailable' or event.last_verified_at == cjson.null then
  event.last_verified_at = previous and previous.last_verified_at or cjson.null
end
if event.event == 'session.unavailable' and previous then event.last_observed_at = previous.last_observed_at end
redis.call('HSET', KEYS[2], phone, cjson.encode(event))
local rows = redis.call('HGETALL', KEYS[1])
for i = 1, #rows, 2 do
  local d = cjson.decode(rows[i+1])
  local member = false
  for _, id in ipairs(d.session_ids) do if id == phone then member = true end end
  local accepted = false
  for _, name in ipairs(d.events) do if name == event.event then accepted = true end end
  local emit = changed
  if event.event == 'session.heartbeat' then
    local key = d.id .. ':' .. phone
    local last = tonumber(redis.call('HGET', KEYS[4], key) or '0')
    emit = tonumber(ARGV[5]) - last >= d.heartbeat_interval_seconds * 1000
    if emit and d.enabled and member and accepted then redis.call('HSET', KEYS[4], key, ARGV[5]) end
  end
  if emit and accepted and member and d.enabled and d.server == event.session.server then
    event.destination_id = d.id
    local delivery = {destination_id=d.id, revision=d.revision, event=event}
    redis.call('HSET', KEYS[3], event.event_id .. ':' .. d.id, cjson.encode(delivery))
  end
  if operation == 'remove' and member then
    local ids = {}
    for _, id in ipairs(d.session_ids) do if id ~= phone then table.insert(ids, id) end end
    d.session_ids = ids
    redis.call('HSET', KEYS[1], d.id, cjson.encode(d))
    redis.call('HDEL', KEYS[4], d.id .. ':' .. phone)
  end
end
if operation == 'remove' then
  redis.call('DEL', KEYS[5])
  redis.call('SREM', KEYS[6], phone)
end
return 1
`

export class SessionWebhookStore {
  constructor(private readonly redis = () => getRedis()) {}

  async destinations(): Promise<SessionWebhookDestination[]> {
    const rows = await (await this.redis()).hGetAll(SESSION_WEBHOOK_KEYS.destinations)
    return Object.values(rows).map((row: string) => {
      const value = JSON.parse(row)
      // Redis Lua cjson represents an empty table as {}, normalize at the boundary.
      return { ...value, session_ids: Array.isArray(value.session_ids) ? value.session_ids : [] }
    })
  }

  async save(value: SessionWebhookDestination): Promise<void> {
    await (await this.redis()).hSet(SESSION_WEBHOOK_KEYS.destinations, value.id, JSON.stringify(value))
  }

  async removeDestination(id: string): Promise<void> {
    await (await this.redis()).hDel(SESSION_WEBHOOK_KEYS.destinations, id)
  }

  async states(): Promise<SessionLifecycleEvent[]> {
    return Object.values(await (await this.redis()).hGetAll(SESSION_WEBHOOK_KEYS.states)).map((row: string) => JSON.parse(row))
  }

  async record(operation: 'observe' | 'register' | 'remove', event: SessionLifecycleEvent, expectedObservedAt = ''): Promise<void> {
    const { destinations, states, outbox, heartbeat } = SESSION_WEBHOOK_KEYS
    await (await this.redis()).eval(SESSION_EVENT_LUA, {
      keys: [destinations, states, outbox, heartbeat, configKey(event.session.id), sessionPhoneIndexKey()],
      arguments: [operation, event.session.id, JSON.stringify(event), expectedObservedAt, `${Date.parse(event.occurred_at)}`],
    })
  }

  async saveConfig(phone: string, config: unknown, ttl: number): Promise<void> {
    const event = sessionEvent(phone, 'unavailable')
    const { destinations, states, outbox, heartbeat } = SESSION_WEBHOOK_KEYS
    await (await this.redis()).eval(SESSION_EVENT_LUA, {
      keys: [destinations, states, outbox, heartbeat, configKey(phone), sessionPhoneIndexKey()],
      arguments: ['save_config', phone, JSON.stringify(event), '', `${Date.parse(event.occurred_at)}`, JSON.stringify(config), `${ttl}`],
    })
  }

  async pending(cursor = 0): Promise<{ cursor: number; entries: { id: string; delivery: SessionWebhookDelivery }[] }> {
    const page = await (await this.redis()).hScan(SESSION_WEBHOOK_KEYS.outbox, cursor, { COUNT: 50 })
    return { cursor: Number(page.cursor), entries: page.tuples.map(row => ({ id: row.field, delivery: JSON.parse(row.value) })) }
  }

  async acknowledge(id: string): Promise<void> {
    await (await this.redis()).hDel(SESSION_WEBHOOK_KEYS.outbox, id)
  }
}

export function sessionEvent(phone: string, state: SessionLifecycleEvent['state']['current'], connection: Partial<SessionLifecycleEvent['connection']> = {}, now = new Date().toISOString()): SessionLifecycleEvent {
  return {
    schema_version: 1, event_id: randomUUID(), event: `session.${state}`, occurred_at: now, destination_id: '',
    session: { id: phone, label: null, provider: 'zapo', server: 'server_1' },
    state: { previous: null, current: state, changed_at: now, sequence: 1 },
    connection: { reason: null, code: null, is_logout: null, intentional: null, reconnect_expected: null, requires_pairing: null, ...connection },
    last_verified_at: state === 'unavailable' || state === 'removed' ? null : now, last_observed_at: now,
  }
}

export const sessionWebhookStore = new SessionWebhookStore()
