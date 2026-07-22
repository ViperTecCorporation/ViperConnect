import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRedisStore } from '@zapo-js/store-redis'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { RedisOptions } from 'ioredis'
import { createStore, WaStore, WaStoreBackend } from 'zapo-js'
import {
  ZAPO_REDIS_CONTACTS_TTL_MS,
  ZAPO_REDIS_MESSAGES_TTL_MS,
  ZAPO_REDIS_PRIVACY_TOKEN_TTL_MS,
  ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
  ZAPO_REDIS_THREADS_TTL_MS,
} from '../../defaults'

const persistentDomains = (backend: string) => ({
  auth: backend,
  signal: backend,
  preKey: backend,
  session: backend,
  identity: backend,
  senderKey: backend,
  appState: backend,
  privacyToken: backend,
  messages: backend,
  threads: backend,
  contacts: backend,
} as const)

const cacheDomains = (backend: string) => ({
  retry: backend,
  groupMetadata: backend,
  deviceList: backend,
  messageSecret: backend,
} as const)

const DEFAULT_REDIS_KEY_PREFIX = 'unoapi:zapo:'
const LEGACY_REDIS_KEY_PREFIX = 'unoapi-zapo:'
const SAFE_REDIS_KEY_PREFIX = /^[A-Za-z0-9_:]*$/

export const resolveZapoRedisKeyPrefix = (value?: string) => {
  const prefix = value?.trim() || DEFAULT_REDIS_KEY_PREFIX
  if (prefix === LEGACY_REDIS_KEY_PREFIX) return DEFAULT_REDIS_KEY_PREFIX
  if (!SAFE_REDIS_KEY_PREFIX.test(prefix)) {
    throw new Error('ZAPO_REDIS_KEY_PREFIX must contain only letters, numbers, underscores, and colons')
  }
  return prefix
}

export const redisOptionsFromUrl = (redisUrl: string): RedisOptions => {
  const url = new URL(redisUrl)
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis protocol: ${url.protocol}`)
  }
  const database = url.pathname.replace(/^\//, '')
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: database ? Number(database) : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  }
}

export const zapoSqlitePath = (baseStore: string) => join(baseStore, 'zapo', 'sessions.sqlite')

export type ZapoStoreConfig = {
  useRedis: boolean
  baseStore: string
  redisUrl?: string
  redisKeyPrefix?: string
}

export const createZapoStore = (config: ZapoStoreConfig): WaStore => {
  const backendName = config.useRedis ? 'redis' : 'sqlite'
  let backend: WaStoreBackend
  if (config.useRedis) {
    if (!config.redisUrl) throw new Error('REDIS_URL is required for the Zapo Redis store')
    backend = createRedisStore({
      redis: redisOptionsFromUrl(config.redisUrl),
      keyPrefix: resolveZapoRedisKeyPrefix(config.redisKeyPrefix),
      storeTtlMs: {
        preKeyMs: ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
        sessionMs: ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
        identityMs: ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
        signalMs: ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
        senderKeyMs: ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
        appStateMs: ZAPO_REDIS_SESSION_CRYPTO_TTL_MS,
        messagesMs: ZAPO_REDIS_MESSAGES_TTL_MS,
        threadsMs: ZAPO_REDIS_THREADS_TTL_MS,
        contactsMs: ZAPO_REDIS_CONTACTS_TTL_MS,
        privacyTokenMs: ZAPO_REDIS_PRIVACY_TOKEN_TTL_MS,
      },
    })
  } else {
    const path = zapoSqlitePath(config.baseStore)
    mkdirSync(dirname(path), { recursive: true })
    backend = createSqliteStore({ path, driver: 'auto' })
  }

  return createStore({
    backends: { [backendName]: backend },
    providers: persistentDomains(backendName),
    cacheProviders: cacheDomains(backendName),
  })
}
