import { OwnPrivacyCache } from '../../src/services/own_privacy_cache'
jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'test:', getRedis: jest.fn() }))
const data = { settings: { lastSeen: 'none' }, blocked: [], duration: 0, exceptions: { lastSeen: ['12345@lid'] }, warnings: [] }
function fixture() {
  const store = new Map<string, string>()
  const redis = { get: jest.fn(async k => store.get(k)), eval: jest.fn(async (script, { keys, arguments: args }) => {
    if (script.includes('DEL')) { store.set(keys[1], args[0]); store.delete(keys[0]); return }
    if ((store.get(keys[1]) || '0') === args[0]) store.set(keys[0], args[1])
  }) }
  return { cache: new OwnPrivacyCache(async () => redis), redis, store }
}
test('always reads live, isolates phones and caches only whitelisted data', async () => {
  const { cache, store } = fixture(); const fetch = jest.fn().mockResolvedValue({ ...data, secret: 'private' })
  await cache.read('111', fetch); await cache.read('111', fetch)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect([...store.values()].join()).not.toContain('private')
  const fail = async () => { throw new Error('offline') }
  expect((await cache.read('111', fail)).cache).toMatchObject({ source: 'cache', stale: true, refresh_failed: true })
  await expect(cache.read('222', fail)).rejects.toThrow('offline')
})
test('partial failure preserves known data/date without renewing stale snapshot', async () => {
  const { cache, redis } = fixture()
  const initial = await cache.read('111', async () => data)
  const result = await cache.read('111', async () => ({ ...data, duration: null, exceptions: { lastSeen: null }, warnings: ['timer', 'exceptions.lastSeen'] }))
  expect(result.duration).toBe(0); expect(result.exceptions.lastSeen).toEqual(['12345@lid'])
  expect(result.cache).toMatchObject({ source: 'mixed', updated_at: initial.cache.updated_at, stale: true })
  expect(redis.eval).toHaveBeenCalledTimes(1)
})
test('never falls back on authorization errors and invalidation fences old reads', async () => {
  const { cache, store } = fixture()
  await cache.read('111', async () => data)
  await expect(cache.read('111', async () => { throw Object.assign(new Error('forbidden'), { code: 403 }) })).rejects.toThrow('forbidden')
  let release!: (value: any) => void
  const pending = cache.read('111', () => new Promise(resolve => { release = resolve }))
  while (!release) await new Promise(resolve => setImmediate(resolve))
  await cache.invalidate('111'); release(data); await pending
  expect(store.get('test:own-privacy:v1:111')).toBeUndefined()
})
test('Redis outage does not break live reads or confirmed invalidation', async () => {
  const cache = new OwnPrivacyCache(async () => { throw new Error('redis down') })
  expect((await cache.read('111', async () => data)).cache.source).toBe('live')
  await expect(cache.invalidate('111')).resolves.toBeUndefined()
})
