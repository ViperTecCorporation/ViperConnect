import { createClient } from '@redis/client'
import { ARCHIVE_WEBHOOKS_LUA, RESTORE_WEBHOOKS_LUA } from '../../src/services/webhook_history'
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), publishConfigUpdate: jest.fn() }))
const endpoint = process.env.WEBHOOK_HISTORY_TEST_REDIS_URL
const integration = endpoint ? describe : describe.skip
integration('webhook history Lua on disposable local Redis', () => {
  const redis = createClient({ url: endpoint, socket: { connectTimeout: 2000, reconnectStrategy: false } })
  beforeAll(async () => {
    const url = new URL(endpoint!)
    if (url.hostname !== '127.0.0.1' || url.port !== '16397' || url.pathname !== '/15') throw new Error('unsafe_test_redis')
    await redis.connect()
    const config = await redis.configGet('dir')
    if (config.dir !== '/tmp/unoapi-webhook-history-tests-20260919') throw new Error('not_disposable_test_redis')
  })
  afterAll(async () => { if (redis.isOpen) await redis.quit() })
  test('retains the latest 20 independent of deleted session configuration', async () => {
    const key = 'test:history:retention'
    for (let i = 0; i < 25; i++) await redis.eval(ARCHIVE_WEBHOOKS_LUA, { keys: [key], arguments: [JSON.stringify({ id: i })] })
    expect(await redis.lLen(key)).toBe(20)
    expect(JSON.parse((await redis.lIndex(key, 0))!).id).toBe(24)
    expect(JSON.parse((await redis.lIndex(key, -1))!).id).toBe(5)
    expect(await redis.ttl(key)).toBe(-1)
  })
  test('CAS preserves TTL, rejects stale snapshots and never recreates a deleted config', async () => {
    const key = 'test:config:cas'
    await redis.set(key, 'old', { EX: 120 })
    expect(await redis.eval(RESTORE_WEBHOOKS_LUA, { keys: [key], arguments: ['old', 'new'] })).toBe(1)
    expect(await redis.ttl(key)).toBeGreaterThan(110)
    expect(await redis.eval(RESTORE_WEBHOOKS_LUA, { keys: [key], arguments: ['old', 'overwrite'] })).toBe(0)
    expect(await redis.get(key)).toBe('new')
    await redis.del(key)
    expect(await redis.eval(RESTORE_WEBHOOKS_LUA, { keys: [key], arguments: ['new', 'resurrect'] })).toBe(0)
    expect(await redis.exists(key)).toBe(0)
  })
  test('competing restorations have one winner', async () => {
    const key = 'test:config:race'
    await redis.set(key, 'base')
    const results = await Promise.all(['one', 'two'].map(value => redis.eval(RESTORE_WEBHOOKS_LUA, { keys: [key], arguments: ['base', value] })))
    expect(results.sort()).toEqual([0, 1])
    expect(await redis.ttl(key)).toBe(-1)
  })
})
