import { join } from 'node:path'
import { createRedisStore } from '@zapo-js/store-redis'
import { createStore } from 'zapo-js'
import { createZapoStore, redisOptionsFromUrl, zapoSqlitePath } from '../../src/services/zapo/zapo_store'

jest.mock('@zapo-js/store-redis', () => ({ createRedisStore: jest.fn(() => ({ stores: {}, caches: {} })) }))
jest.mock('@zapo-js/store-sqlite', () => ({ createSqliteStore: jest.fn(() => ({ stores: {}, caches: {} })) }))
jest.mock('zapo-js', () => ({ createStore: jest.fn(() => ({ session: jest.fn(), destroy: jest.fn() })) }))

describe('zapo store', () => {
  test('parses a Redis URL into ioredis options', () => {
    expect(redisOptionsFromUrl('rediss://user:p%40ss@redis.local:6380/4')).toEqual({
      host: 'redis.local',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 4,
      tls: {},
    })
  })

  test('rejects unsupported Redis protocols', () => {
    expect(() => redisOptionsFromUrl('http://redis.local')).toThrow('Unsupported Redis protocol')
  })

  test('keeps the Zapo SQLite database separate from Baileys files', () => {
    expect(zapoSqlitePath('/data')).toBe(join('/data', 'zapo', 'sessions.sqlite'))
  })

  test('creates a durable Redis-backed Zapo store', () => {
    const store = createZapoStore({
      useRedis: true,
      baseStore: '/data',
      redisUrl: 'redis://redis:6379/0',
    })

    expect(createRedisStore).toHaveBeenCalledWith(expect.objectContaining({
      keyPrefix: 'unoapi-zapo:',
      storeTtlMs: expect.objectContaining({ contactsMs: expect.any(Number), messagesMs: expect.any(Number) }),
    }))
    expect(createStore).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ auth: 'redis', session: 'redis', messages: 'redis' }),
      cacheProviders: expect.objectContaining({ retry: 'redis', groupMetadata: 'redis' }),
    }))
    expect(store).toBeDefined()
  })
})
