import { getSessionStateRedis } from './state_redis'
import { SessionStorageError } from './types'
import { configs } from '../config'
import { assertFreshSqliteWriteSelection } from './write_fence'

/** Executed in the same Redis command as a private-cache read/write. */
export const PRIVATE_REDIS_FENCE_LUA = `
local expected=cjson.decode(ARGV[#ARGV]); local raw=redis.call('GET',KEYS[#KEYS])
if not raw and expected.exists then return {err='session_storage_configuration_missing'} end
local cfg={}; if raw then local ok,value=pcall(cjson.decode,raw); if not ok or type(value)~='table' then return {err='session_storage_configuration_invalid'} end; cfg=value end
local s=cfg.sessionStorage
if s==cjson.null then s=nil end
if s and type(s)~='table' then return {err='session_storage_configuration_invalid'} end
if s and (s.state=='migrating' or s.state=='restoring') then return {err='session_storage_operation_in_progress'} end
if s and s.backend~='redis' then return {err='session_storage_generation_changed'} end
if expected.descriptor==cjson.null then
 if s then return {err='session_storage_generation_changed'} end
else
 local d=expected.descriptor
 if not s or s.backend~=d.backend or s.generation~=d.generation or s.storageId~=d.storageId or s.owner~=d.owner then return {err='session_storage_generation_changed'} end
end
`

/** These errors must not be mistaken for an optional cache/network miss. */
export function rethrowSessionStateFence(error: unknown): void {
  const candidate = error as { message?: unknown; title?: unknown }
  const codes = [candidate?.title, candidate?.message].filter((value): value is string => typeof value === 'string')
  if (error instanceof SessionStorageError || codes.some(code => /^session_storage_[a-z_]+$/.test(code.replace(/^\d{3}:\s*/, '')))) throw error
}

/** Only private caches use this wrapper. Legacy raw Redis APIs remain unchanged. */
export async function getSessionPrivateState(phone: string): Promise<any> {
  const state = await getSessionStateRedis(phone)
  if (typeof state.snapshotSet === 'function') {
    const selected = configs.get(phone) || await module.require('../config_redis').getConfigRedis(phone)
    return new Proxy(state, { get(target, name) {
      const value = (target as any)[name]
      return typeof value !== 'function' ? value : async (...args: unknown[]) => {
        await assertFreshSqliteWriteSelection(phone, selected, false)
        return value.apply(target, args)
      }
    } })
  }
  const raw = state as any, configKey = `unoapi-config:${phone}`, stored = await raw.get(configKey)
  let config: any
  try { config = stored ? JSON.parse(stored) : {} }
  catch { throw new SessionStorageError(503, 'session_storage_configuration_invalid') }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new SessionStorageError(503, 'session_storage_configuration_invalid')
  const descriptor = config.sessionStorage || null
  if (descriptor && (typeof descriptor !== 'object' || Array.isArray(descriptor))) throw new SessionStorageError(503, 'session_storage_configuration_invalid')
  if (descriptor && ['migrating', 'restoring'].includes(descriptor.state)) throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  if (descriptor && descriptor.backend !== 'redis') throw new SessionStorageError(409, 'session_storage_generation_changed')
  const expected = JSON.stringify({ exists: !!stored, descriptor })
  const evaluate = async (script: string, options: { keys: string[]; arguments: string[] }) => {
    try { return await raw.eval(PRIVATE_REDIS_FENCE_LUA + script, { keys: [...options.keys, configKey], arguments: [...options.arguments, expected] }) }
    catch (error) {
      const code = String((error as Error)?.message || '').match(/session_storage_(?:generation_changed|operation_in_progress|configuration_missing|configuration_invalid)/)?.[0]
      if (code) throw new SessionStorageError(code === 'session_storage_configuration_invalid' ? 503 : 409, code)
      throw error
    }
  }
  const command = (name: string, key: string, args: string[]) => evaluate(`return redis.call('${name}',KEYS[1],unpack(ARGV,1,#ARGV-1))`, { keys: [key], arguments: args })
  return {
    get: (key: string) => command('GET', key, []),
    set: (key: string, value: string) => command('SET', key, [value]),
    mGet: (keys: string[]) => evaluate("return redis.call('MGET',unpack(KEYS,1,#KEYS-1))", { keys, arguments: [] }),
    eval: evaluate,
    evalPreservingArity: (script: string, options: { keys: string[]; arguments: string[] }) => evaluate('table.remove(KEYS,#KEYS);table.remove(ARGV,#ARGV)\n' + script, options),
    zScore: async (key: string, member: string) => { const value = await command('ZSCORE', key, [member]); return value === null || value === false ? null : Number(value) },
    zAdd: (key: string, members: { score: number; value: string }[]) => command('ZADD', key, members.flatMap(member => [String(member.score), member.value])),
    zRem: (key: string, members: string | string[]) => command('ZREM', key, Array.isArray(members) ? members : [members]),
    zRemRangeByScore: (key: string, minimum: number | string, maximum: number | string) => command('ZREMRANGEBYSCORE', key, [String(minimum), String(maximum)]),
    expire: (key: string, seconds: number) => command('EXPIRE', key, [String(seconds)]),
  }
}
