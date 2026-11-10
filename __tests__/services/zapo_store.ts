import { join } from 'node:path'
import { createRedisStore } from '@zapo-js/store-redis'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { createStore } from 'zapo-js'
import { defaultConfig } from '../../src/services/config'
import { ZapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'
import * as sessionDatabase from '../../src/services/session_storage/database'
import {
  createZapoStore,
  redisOptionsFromUrl,
  resolveZapoRedisKeyPrefix,
  zapoSqlitePath,
} from '../../src/services/zapo/zapo_store'

jest.mock('@zapo-js/store-redis', () => ({ createRedisStore: jest.fn(() => ({ stores: {}, caches: {} })) }))
jest.mock('@zapo-js/store-sqlite', () => ({ createSqliteStore: jest.fn(() => ({ stores: {}, caches: {} })) }))
jest.mock('zapo-js', () => ({ createStore: jest.fn(() => ({ session: jest.fn(), destroy: jest.fn() })) }))

describe('zapo store', () => {
  beforeEach(() => jest.clearAllMocks())
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

  test('maps the legacy Redis prefix to the canonical safe prefix', () => {
    expect(resolveZapoRedisKeyPrefix('unoapi-zapo:')).toBe('unoapi:zapo:')
  })

  test('rejects unsafe custom Redis prefixes', () => {
    expect(() => resolveZapoRedisKeyPrefix('unoapi/zapo:')).toThrow('ZAPO_REDIS_KEY_PREFIX')
  })

  test('creates a durable Redis-backed Zapo store', () => {
    const store = createZapoStore({
      useRedis: true,
      baseStore: '/data',
      redisUrl: 'redis://redis:6379/0',
    })

    expect(createRedisStore).toHaveBeenCalledWith(expect.objectContaining({
      keyPrefix: 'unoapi:zapo:',
      storeTtlMs: expect.objectContaining({ contactsMs: expect.any(Number), messagesMs: expect.any(Number) }),
    }))
    expect(createStore).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ auth: 'redis', session: 'redis', messages: 'redis' }),
      cacheProviders: expect.objectContaining({ retry: 'redis', groupMetadata: 'redis', chatMetadata: 'redis' }),
    }))
    expect(store).toBeDefined()
    expect(createSqliteStore).not.toHaveBeenCalled()
    const options = jest.mocked(createRedisStore).mock.calls.at(-1)![0]
    expect(options.storeTtlMs).toEqual({
      contactsMs: expect.any(Number), messagesMs: expect.any(Number), threadsMs: expect.any(Number),
    })
  })

  test('a valid Redis-backed session without storage settings never creates a native SQLite session store', async () => {
    const oldEnvironment = { ...process.env }, open = jest.spyOn(sessionDatabase, 'openSessionDatabase')
    const registry = new ZapoStoreRegistry()
    try {
      for (const key of Object.keys(process.env)) if (key.startsWith('SESSION_STORAGE_')) delete process.env[key]
      process.env.REDIS_URL = 'redis://mock:6379/0'
      const config = { ...defaultConfig, provider: 'zapo' as const, useRedis: true, server: 'redis_owner' }
      expect(config.sessionStorage).toBeUndefined()
      const store = registry.get(config, '999123456789')
      expect(store).toBeDefined()
      expect(createRedisStore).toHaveBeenCalledTimes(1)
      expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ providers: expect.objectContaining({ auth: 'redis', messages: 'redis' }) }))
      expect(createSqliteStore).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
    } finally { await registry.destroy(); open.mockRestore(); process.env = oldEnvironment }
  })
})
