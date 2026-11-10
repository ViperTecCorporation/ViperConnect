import { configs } from '../../src/services/config'
import { getRedis } from '../../src/services/redis'
import { OwnProfileCache } from '../../src/services/own_profile_cache'
import { OwnPrivacyCache } from '../../src/services/own_privacy_cache'
import { OwnProfileCover } from '../../src/services/own_profile_cover'
import { getSessionPrivateState, PRIVATE_REDIS_FENCE_LUA, rethrowSessionStateFence } from '../../src/services/session_storage/private_state'
import { SessionStorageError } from '../../src/services/session_storage/types'

jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: jest.fn() }))
const phone = '999123456789', configKey = `unoapi-config:${phone}`, profileKey = `unoapi-own-profile:v1:${phone}`
beforeEach(() => { configs.set(phone, { provider: 'zapo' } as any); jest.clearAllMocks() })
afterEach(() => { configs.delete(phone) })

/** Read-only config guard fixture; checks the exact script ordering/options passed to Redis. */
function fixture() {
  const values = new Map<string, string>([[configKey, JSON.stringify({ provider: 'zapo' })]])
  const sorted = new Map<string, Map<string, number>>()
  const redis = { get: jest.fn(async (key: string) => values.get(key) ?? null), set: jest.fn(async (key: string, value: string, options?: any) => {
    if (options?.NX && values.has(key)) return null; values.set(key, value); return 'OK'
  }), eval: jest.fn(async (script: string, { keys, arguments: args }: any) => {
    let ordinaryArgs = args
    if (script.startsWith(PRIVATE_REDIS_FENCE_LUA)) {
      expect(keys.at(-1)).toBe(configKey)
      const expected = JSON.parse(args.at(-1)), raw = values.get(configKey)
      if (!raw && expected.exists) throw Error('ERR session_storage_configuration_missing')
      let current: any; try { current = raw ? JSON.parse(raw) : {} } catch { throw Error('ERR session_storage_configuration_invalid') }
      const selected = expected.descriptor, actual = current.sessionStorage || null
      if (actual && ['migrating', 'restoring'].includes(actual.state)) throw Error('ERR session_storage_operation_in_progress')
      if (actual?.backend && actual.backend !== 'redis' || !selected && actual || selected && (!actual
        || ['backend', 'generation', 'storageId', 'owner'].some(field => actual[field] !== selected[field]))) throw Error('ERR session_storage_generation_changed')
      ordinaryArgs = args.slice(0, -1)
    }
    const method = /return redis.call\('([A-Z]+)',KEYS\[1\],unpack/.exec(script)?.[1], key = keys[0]
    if (method === 'GET') return values.get(key) ?? null
    if (method === 'ZSCORE') return sorted.get(key)?.get(ordinaryArgs[0])?.toString() ?? null
    if (method === 'ZADD') { const members = sorted.get(key) || new Map<string, number>(); sorted.set(key, members); let added = 0
      for (let i = 0; i < ordinaryArgs.length; i += 2) { if (!members.has(ordinaryArgs[i + 1])) added++; members.set(ordinaryArgs[i + 1], Number(ordinaryArgs[i])) } return added }
    if (method === 'ZREM') { let removed = 0; for (const member of ordinaryArgs) if (sorted.get(key)?.delete(member)) removed++; return removed }
    if (method === 'ZREMRANGEBYSCORE') { let removed = 0; for (const [member, score] of sorted.get(key) || []) if (score >= Number(ordinaryArgs[0]) && score <= Number(ordinaryArgs[1])) { sorted.get(key)!.delete(member); removed++ } return removed }
    if (method === 'EXPIRE') return 1
    if (keys.length === 3 && script.includes("redis.call('SET', KEYS[1]")) {
      if ((values.get(keys[1]) || '0') === ordinaryArgs[0]) { values.set(key, ordinaryArgs[1]); return 'OK' } return null
    }
    if (script.includes("redis.call('DEL', KEYS[1])") && values.get(key) === ordinaryArgs[0]) { values.delete(key); return 1 }
    return 0
  }) }
  ;(getRedis as jest.Mock).mockResolvedValue(redis)
  return { redis, values, sorted }
}

test('Redis private-cache port fences reads and each supported sorted-set operation without changing raw Redis', async () => {
  const f = fixture(), state = await getSessionPrivateState(phone), key = `unoapi-profile-picture-miss:${phone}`
  f.values.set(profileKey, 'snapshot'); expect(await state.get(profileKey)).toBe('snapshot')
  expect(await state.zScore(key, 'absent')).toBeNull()
  expect(await state.zAdd(key, [{ value: 'one', score: 2 }, { value: 'two', score: 4 }])).toBe(2)
  expect(await state.zScore(key, 'one')).toBe(2)
  expect(await state.zRem(key, 'two')).toBe(1)
  await state.zAdd(key, [{ value: 'two', score: 4 }]); expect(await state.zRem(key, ['two'])).toBe(1)
  expect(await state.zRemRangeByScore(key, 0, 3)).toBe(1); expect(await state.expire(key, 30)).toBe(1)
  f.values.set(configKey, JSON.stringify({ sessionStorage: { backend: 'sqlite', generation: 2 } }))
  await expect(state.get(profileKey)).rejects.toThrow('generation_changed')
  await expect(state.zAdd(key, [{ value: 'late', score: 5 }])).rejects.toThrow('generation_changed')
  expect(f.sorted.get(key)?.has('late')).toBe(false)
  expect(f.redis.get.mock.calls.every(([key]) => key === configKey)).toBe(true)
  expect(PRIVATE_REDIS_FENCE_LUA).toContain("redis.call('GET',KEYS[#KEYS])")
})

test.each(['profile', 'privacy'])('an inflight %s fetch cannot recreate Redis source after cutover and does not silently return cached success', async kind => {
  const f = fixture(); let release!: (value: any) => void
  const pending = kind === 'profile' ? new OwnProfileCache().read(phone, true, () => new Promise(resolve => { release = resolve }))
    : new OwnPrivacyCache().read(phone, () => new Promise(resolve => { release = resolve }))
  while (!release) await Promise.resolve()
  f.values.set(configKey, JSON.stringify({ sessionStorage: { backend: 'sqlite', generation: 2 } }))
  release(kind === 'profile' ? { name: 'late profile', warnings: [] } : { settings: {}, blocked: [], duration: 0, exceptions: {}, warnings: [] })
  await expect(pending).rejects.toThrow('session_storage_generation_changed')
  expect(f.values.has(kind === 'profile' ? profileKey : `unoapi-own-privacy:v1:${phone}`)).toBe(false)
})

test('Redis descriptors permit ordinary online/offline changes but reject a new storage generation', async () => {
  const f = fixture(), descriptor = { backend: 'redis', storageId: 'synthetic-storage', owner: 'server_1', generation: 1, state: 'offline' }
  f.values.set(configKey, JSON.stringify({ sessionStorage: descriptor })); f.values.set(profileKey, 'snapshot')
  const state = await getSessionPrivateState(phone)
  f.values.set(configKey, JSON.stringify({ sessionStorage: { ...descriptor, state: 'active' } }))
  expect(await state.get(profileKey)).toBe('snapshot')
  f.values.set(configKey, JSON.stringify({ sessionStorage: { ...descriptor, generation: 2 } }))
  await expect(state.get(profileKey)).rejects.toThrow('generation_changed')
})

test('migration/restore/config changes are explicit on queries and invalidation, while generic network errors remain optional', async () => {
  const f = fixture(), state = await getSessionPrivateState(phone)
  f.values.set(configKey, JSON.stringify({ sessionStorage: { backend: 'redis', state: 'migrating' } }))
  await expect(state.get(profileKey)).rejects.toThrow('operation_in_progress')
  await expect(new OwnProfileCache().invalidate(phone)).rejects.toThrow('operation_in_progress')
  f.values.set(configKey, JSON.stringify({ sessionStorage: { backend: 'redis', state: 'restoring' } }))
  await expect(new OwnPrivacyCache().read(phone, jest.fn())).rejects.toThrow('operation_in_progress')
  f.values.delete(configKey); await expect(state.get(profileKey)).rejects.toThrow('configuration_missing')
  f.values.set(configKey, 'invalid-json'); await expect(state.get(profileKey)).rejects.toThrow('configuration_invalid')
  await expect(getSessionPrivateState(phone)).rejects.toThrow('configuration_invalid')
  expect(() => rethrowSessionStateFence(new Error('network'))).not.toThrow()
  expect(() => rethrowSessionStateFence(new SessionStorageError(409, 'explicit'))).toThrow('explicit')
})

test('a cover upload confirmed remotely after cutover returns a warning without recreating metadata or resending', async () => {
  const f = fixture(), key = `unoapi-own-profile-cover:v1:${phone}`
  const media: any = { type: 's3', saveMediaBuffer: jest.fn().mockResolvedValue(true), removeMedia: jest.fn(), getFileUrl: jest.fn() }
  const send = jest.fn(async () => { f.values.set(configKey, JSON.stringify({ sessionStorage: { backend: 'sqlite', generation: 2 } })); return { id: 'confirmed' } })
  expect(await new OwnProfileCover(phone, media).upload(Buffer.from('synthetic'), send)).toEqual({ success: true, id: 'confirmed', warning: 'profile_cover_metadata_not_saved' })
  expect(send).toHaveBeenCalledTimes(1); expect(f.values.has(key)).toBe(false)
})
