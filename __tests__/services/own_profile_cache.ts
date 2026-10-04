import { OwnProfileCache } from '../../src/services/own_profile_cache'
const setup = () => {
  const values = new Map<string, string>()
  const redis = { get: jest.fn(async (k: string) => values.get(k)), eval: jest.fn(async (script: string, options: any) => {
    const [key, version] = options.keys; const args = options.arguments
    if (script.startsWith("redis.call('SET', KEYS[2]")) { values.set(version, args[0]); return 1 }
    if ((values.get(version) || '0') === args[0]) values.set(key, args[1])
    return 'OK'
  }) }
  return { cache: new OwnProfileCache(async () => redis), values, redis }
}
const profile = { name: 'Ana', about: 'Olá', username: 'ana', warnings: [], business_account: false, picture: null, business: null }
test('miss reads live, hit avoids WhatsApp; refresh updates; only public fields persisted', async () => {
  const { cache, values } = setup(); const fetch = jest.fn().mockResolvedValue({ ...profile, pin: 'SECRET', credentials: 'SECRET' })
  expect((await cache.read('111', false, fetch)).cache.source).toBe('live')
  expect((await cache.read('111', false, fetch)).cache.source).toBe('cache')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect([...values.values()].join('')).not.toContain('SECRET')
  fetch.mockResolvedValue({ ...profile, name: 'Novo' })
  expect((await cache.read('111', true, fetch)).name).toBe('Novo')
  await cache.read('222', false, fetch); expect(fetch).toHaveBeenCalledTimes(3)
})
test('network and partial failures preserve prior data with stale metadata', async () => {
  const { cache } = setup()
  const first = await cache.read('111', false, async () => profile)
  const offline = await cache.read('111', true, async () => { throw Error('offline') })
  expect(offline).toMatchObject({ name: 'Ana', cache: { updated_at: first.cache.updated_at, stale: true, refresh_failed: true } })
  const partial = await cache.read('111', true, async () => ({ ...profile, about: null, warnings: ['about'] }))
  expect(partial).toMatchObject({ about: 'Olá', warnings: ['about'], cache: { stale: true } })
})
test('invalidation fences off a refresh begun before mutation', async () => {
  const { cache } = setup(); let resolve!: (v: any) => void
  const fetch = jest.fn(() => new Promise(r => { resolve = r }))
  const pending = cache.read('111', true, fetch)
  while (!resolve) await Promise.resolve()
  await cache.invalidate('111')
  await cache.read('111', true, async () => ({ ...profile, name: 'Updated' }))
  resolve(profile); await pending
  expect((await cache.read('111', false, async () => { throw Error('must use cache') })).name).toBe('Updated')
})
test('concurrent refreshes share RPC; Redis outage falls back to live', async () => {
  const { cache } = setup(); let resolve!: (v: any) => void
  const fetch = jest.fn(() => new Promise(r => { resolve = r }))
  const a = cache.read('111', true, fetch); const b = cache.read('111', true, fetch)
  while (!resolve) await Promise.resolve()
  resolve(profile); await Promise.all([a,b]); expect(fetch).toHaveBeenCalledTimes(1)
  const unavailable = new OwnProfileCache(async () => { throw Error('redis') })
  expect((await unavailable.read('111', false, async () => profile)).name).toBe('Ana')
  await expect(unavailable.invalidate('111')).resolves.toBeUndefined()
})
