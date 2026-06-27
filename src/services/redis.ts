import { createClient } from '@redis/client'
import {
  REDIS_URL,
  DATA_TTL,
  SESSION_TTL,
  DATA_URL_TTL,
  JIDMAP_TTL_SECONDS,
  JIDMAP_STORED_LOOKUP_ENABLED,
  SIGNAL_PURGE_DEVICE_LIST_ENABLED,
  SIGNAL_PURGE_SESSION_ENABLED,
  SIGNAL_PURGE_SENDER_KEY_ENABLED,
  JIDMAP_ENRICH_PER_SWEEP,
  WATCHDOG_PURGE_SCAN_COUNT,
  WATCHDOG_TASK_MIN_INTERVAL_MS,
  JIDMAP_ENRICH_MIN_INTERVAL_MS,
  AUTH_CACHE_TTL_MS,
  SESSION_STATUS_CACHE_TTL_MS,
  CONNECT_COUNT_CACHE_TTL_MS,
} from '../defaults'
import logger from './logger'
import { GroupMetadata, proto } from '@whiskeysockets/baileys'
import { Webhook, configs } from './config' 
import { isTransientInfraError } from './error_utils'
import { version as appVersion } from '../../package.json'
import { mergeGroupMetadataForCache } from './groups/group_metadata_cache'
import { normalizeLidJid } from './transformer/jid'

export const BASE_KEY = 'unoapi-'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any
let subscriber: any
let configSubStarted = false
const configSubHandlers: Set<(phone: string) => void> = new Set()
const channelHandlers: Map<string, Set<(message: string) => void>> = new Map()
const subscribedChannels: Set<string> = new Set()
let subscriberStarting = false

const redisTaskQueues: Map<string, Promise<any>> = new Map()
const redisTaskLastRun: Map<string, number> = new Map()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const REDIS_CONNECT_MAX_RETRIES = parseInt(process.env.REDIS_CONNECT_MAX_RETRIES || '30')
const REDIS_CONNECT_RETRY_DELAY_MS = parseInt(process.env.REDIS_CONNECT_RETRY_DELAY_MS || '2000')
// Health-check flags/intervals
let redisHealthStarted = false
const REDIS_HEALTH_INTERVAL_MS = 15_000
const REDIS_PING_WARN_MS = 200
let startupMigrationsDone = false
const isCacheValid = (ts: number, ttlMs: number) => ttlMs <= 0 || (Date.now() - ts) <= ttlMs
const authCache: Map<string, { value: string | null, ts: number }> = new Map()
const sessionStatusCache: Map<string, { value: string | null, ts: number }> = new Map()
const connectCountCache: Map<string, { value: number, ts: number }> = new Map()
// Simple queue + throttle to avoid hammering Redis when the same task is triggered concurrently
const enqueueRedisTask = async <T>(name: string, fn: () => Promise<T>, minIntervalMs = 0): Promise<T> => {
  const previous = redisTaskQueues.get(name) || Promise.resolve()
  const next = previous.then(async () => {
    if (minIntervalMs > 0) {
      const last = redisTaskLastRun.get(name) || 0
      const elapsed = Date.now() - last
      if (elapsed < minIntervalMs) {
        await sleep(minIntervalMs - elapsed)
      }
    }
    const result = await fn()
    redisTaskLastRun.set(name, Date.now())
    return result
  }).catch((err) => {
    try { logger.warn(err as any, 'Redis task %s failed', name) } catch {}
    redisTaskLastRun.set(name, Date.now())
    throw err
  })
  // store a settled promise to keep the chain alive even after failures
  redisTaskQueues.set(name, next.then(() => undefined, () => undefined))
  return next
}

export const startRedis = async (redisUrl = REDIS_URL, retried = false) => {
  if (!client) {
    logger.info(`Starting redis....`)
    client = await redisConnect(redisUrl)
    client.on('error', async (error: string) => {
      logger.error(`Redis error: ${error}`)
      client = undefined
      if (!retried) {
        logger.info(`Redis retry connect`)
        try {
          await startRedis(redisUrl, true)
        } catch (error) {
          logger.error(`Redis error on retry connect: ${error}`)
        }
      }
    })
    logger.info(`Started redis!`)
    // Health check loop (detect latência/queda)
    if (!redisHealthStarted) {
      redisHealthStarted = true
      try {
        setInterval(async () => {
          const start = Date.now()
          try {
            await client.ping()
            const dur = Date.now() - start
            if (dur > REDIS_PING_WARN_MS) {
              logger.warn('Redis ping lento: %d ms', dur)
            }
          } catch (e) {
            logger.warn(e as any, 'Redis ping falhou')
          }
        }, REDIS_HEALTH_INTERVAL_MS)
      } catch {}
    }
  }
  if (client && !startupMigrationsDone) {
    startupMigrationsDone = true
    try {
      await runStartupRedisMigrations()
    } catch (e) {
      logger.warn(e as any, 'Redis startup migrations failed')
    }
  }
  return client
}

export const getRedis = async (redisUrl = REDIS_URL) => {
  return await startRedis(redisUrl)
}

const appVersionKey = () => `${BASE_KEY}app:version:last`
const appMigrationLockKey = (name: string) => `${BASE_KEY}app:migration:${name}:lock`
export const historySyncMarkerKey = (phone: string) => `${BASE_KEY}history-sync:${phone}:started`

const parseSemverLike = (raw?: string): [number, number, number] => {
  const cleaned = `${raw || ''}`.trim().replace(/^v/i, '').split('-')[0]
  const parts = cleaned.split('.').map((p) => parseInt(p, 10))
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ]
}

const isSemverLt = (a?: string, b?: string): boolean => {
  const av = parseSemverLike(a)
  const bv = parseSemverLike(b)
  for (let i = 0; i < 3; i += 1) {
    if (av[i] < bv[i]) return true
    if (av[i] > bv[i]) return false
  }
  return false
}

const clearGlobalJidMapOnLegacyUpgrade = async (): Promise<void> => {
  const currentVersion = `${appVersion || ''}`.trim()
  const previousVersion = `${await redisGet(appVersionKey()) || ''}`.trim()
  const targetVersion = '3.0.57'
  try {
    logger.info('Startup migration check: previous=%s current=%s target=%s', previousVersion || '<none>', currentVersion || '<none>', targetVersion)
  } catch {}
  if (!previousVersion) {
    try { await redisSet(appVersionKey(), currentVersion) } catch {}
    return
  }
  if (!isSemverLt(previousVersion, targetVersion)) {
    try { await redisSet(appVersionKey(), currentVersion) } catch {}
    return
  }
  const lockKey = appMigrationLockKey(`clear-global-jidmap-before-${targetVersion}`)
  const acquired = await redisSetIfNotExists(lockKey, currentVersion || '1', 600)
  if (!acquired) {
    try {
      await redisSet(appVersionKey(), currentVersion)
    } catch {}
    return
  }
  try {
    const keys = await redisScanSome(`${BASE_KEY}jidmap:global:*`, 100000)
    let deleted = 0
    for (const key of keys || []) {
      try {
        await redisDel(key)
        deleted += 1
      } catch {}
    }
    try {
      logger.warn('Startup migration: cleared %s global jidmap key(s) due to upgrade from %s to %s', deleted, previousVersion, currentVersion)
    } catch {}
  } finally {
    try { await redisSet(appVersionKey(), currentVersion) } catch {}
  }
}

const clearProfilePictureRefreshKeysOnLegacyUpgrade = async (): Promise<void> => {
  const currentVersion = `${appVersion || ''}`.trim()
  const previousVersion = `${await redisGet(appVersionKey()) || ''}`.trim()
  const targetVersion = '3.0.65'
  if (previousVersion && !isSemverLt(previousVersion, targetVersion)) return

  const lockKey = appMigrationLockKey(`clear-profile-picture-refresh-before-${targetVersion}`)
  const acquired = await redisSetIfNotExists(lockKey, currentVersion || '1', 600)
  if (!acquired) return

  const keys = await redisScanSome(`${BASE_KEY}profile-picture-refresh:*`, 100000)
  let deleted = 0
  for (const key of keys || []) {
    try {
      await redisDel(key)
      deleted += 1
    } catch {}
  }
  try {
    logger.warn(
      'Startup migration: cleared %s profile picture refresh key(s) due to upgrade from %s to %s',
      deleted,
      previousVersion || '<none>',
      currentVersion || '<none>'
    )
  } catch {}
}

export const getHistorySyncMarker = async (phone: string): Promise<boolean> => {
  try {
    return !!(await redisGet(historySyncMarkerKey(phone)))
  } catch (e) {
    logger.debug(e as any, 'Could not read history sync marker for %s', phone)
    return false
  }
}

export const setHistorySyncMarker = async (phone: string, value: any) => {
  try {
    return await redisSetAndExpire(historySyncMarkerKey(phone), JSON.stringify(value || {}), SESSION_TTL)
  } catch (e) {
    logger.debug(e as any, 'Could not set history sync marker for %s', phone)
  }
}

export const delHistorySyncMarker = async (phone: string) => {
  try {
    return await redisDel(historySyncMarkerKey(phone))
  } catch (e) {
    logger.debug(e as any, 'Could not delete history sync marker for %s', phone)
  }
}

const seedHistorySyncMarkersForExistingSessions = async (): Promise<void> => {
  const lockKey = appMigrationLockKey('seed-history-sync-markers-existing-sessions')
  const acquired = await redisSetIfNotExists(lockKey, `${Date.now()}`, 600)
  if (!acquired) return
  const keys = await redisScanSome(configKey('*'), 100000)
  let seeded = 0
  for (const key of keys || []) {
    const phone = `${key || ''}`.replace(configKey(''), '')
    if (!phone || phone === 'auth-token-index') continue
    try {
      if (await redisGet(historySyncMarkerKey(phone))) continue
      await setHistorySyncMarker(phone, {
        status: 'completed',
        seededAt: new Date().toISOString(),
        source: 'startup-existing-session',
      })
      seeded += 1
    } catch {}
  }
  try {
    logger.warn('Startup migration: seeded %s history sync marker(s) for existing sessions', seeded)
  } catch {}
}

const runStartupRedisMigrations = async (): Promise<void> => {
  await clearProfilePictureRefreshKeysOnLegacyUpgrade()
  await clearGlobalJidMapOnLegacyUpgrade()
  await seedHistorySyncMarkersForExistingSessions()
}

export const redisConnect = async (redisUrl = REDIS_URL) => {
  let attempt = 0
  let lastError: unknown

  while (attempt < REDIS_CONNECT_MAX_RETRIES) {
    attempt += 1
    try {
      logger.info(`Connecting redis at ${redisUrl}....`)
      const redisClient = await createClient({ url: redisUrl })
      await redisClient.connect()
      logger.info(`Connected redis!`)
      return redisClient
    } catch (error) {
      lastError = error
      if (!isTransientInfraError(error) || attempt >= REDIS_CONNECT_MAX_RETRIES) {
        throw error
      }
      logger.warn(
        error as any,
        'Transient redis connection failure on attempt %d/%d, retrying in %d ms',
        attempt,
        REDIS_CONNECT_MAX_RETRIES,
        REDIS_CONNECT_RETRY_DELAY_MS
      )
      await sleep(REDIS_CONNECT_RETRY_DELAY_MS)
    }
  }

  throw lastError
}

const CONFIG_UPDATE_CHANNEL = `${BASE_KEY}config:update`
const AUTH_UPDATE_CHANNEL = `${BASE_KEY}auth:update`
const SESSION_STATUS_UPDATE_CHANNEL = `${BASE_KEY}status:update`
const CONNECT_COUNT_UPDATE_CHANNEL = `${BASE_KEY}connect-count:update`

const ensureSubscriber = async () => {
  if (subscriber || subscriberStarting) return
  subscriberStarting = true
  try {
    subscriber = createClient({ url: REDIS_URL })
    await subscriber.connect()
  } catch (e) {
    logger.warn(e as any, 'Failed to connect redis subscriber')
    subscriber = undefined
  } finally {
    subscriberStarting = false
  }
}

const subscribeChannel = async (channel: string, handler: (message: string) => void) => {
  let handlers = channelHandlers.get(channel)
  if (!handlers) {
    handlers = new Set()
    channelHandlers.set(channel, handlers)
  }
  handlers.add(handler)
  await ensureSubscriber()
  if (!subscriber || subscribedChannels.has(channel)) return
  try {
    await subscriber.subscribe(channel, (message: string) => {
      const hs = channelHandlers.get(channel)
      if (!hs) return
      for (const h of hs) {
        try { h(message) } catch {}
      }
    })
    subscribedChannels.add(channel)
  } catch (e) {
    logger.warn(e as any, 'Failed to subscribe to channel %s', channel)
  }
}

export const publishConfigUpdate = async (phone: string) => {
  try {
    await getRedis()
    await client.publish(CONFIG_UPDATE_CHANNEL, phone)
  } catch (e) {
    logger.warn(e as any, 'Failed to publish config update for %s', phone)
  }
}

export const subscribeConfigUpdates = async (handler: (phone: string) => void) => {
  configSubHandlers.add(handler)
  if (configSubStarted) return
  configSubStarted = true
  await subscribeChannel(CONFIG_UPDATE_CHANNEL, (message: string) => {
    for (const h of configSubHandlers) {
      try { h(message) } catch {}
    }
  })
  if (subscriber) logger.info('Redis config update subscription active')
}

export const publishAuthUpdate = async (authKeyFull: string) => {
  try {
    await getRedis()
    await client.publish(AUTH_UPDATE_CHANNEL, authKeyFull)
  } catch (e) {
    logger.warn(e as any, 'Failed to publish auth update for %s', authKeyFull)
  }
}

export const publishSessionStatusUpdate = async (phone: string) => {
  try {
    await getRedis()
    await client.publish(SESSION_STATUS_UPDATE_CHANNEL, phone)
  } catch (e) {
    logger.warn(e as any, 'Failed to publish session status update for %s', phone)
  }
}

export const publishConnectCountUpdate = async (phone: string) => {
  try {
    await getRedis()
    await client.publish(CONNECT_COUNT_UPDATE_CHANNEL, phone)
  } catch (e) {
    logger.warn(e as any, 'Failed to publish connect-count update for %s', phone)
  }
}

const ensureAuthSub = async () => {
  await subscribeChannel(AUTH_UPDATE_CHANNEL, (message: string) => {
    authCache.delete(message)
  })
}

const ensureSessionStatusSub = async () => {
  await subscribeChannel(SESSION_STATUS_UPDATE_CHANNEL, (message: string) => {
    sessionStatusCache.delete(message)
  })
}

const ensureConnectCountSub = async () => {
  await subscribeChannel(CONNECT_COUNT_UPDATE_CHANNEL, (message: string) => {
    connectCountCache.delete(message)
  })
}

export const redisGet = async (key: string) => {
  logger.trace(`Getting ${key}`)
  try {
    return client.get(key)
  } catch (error) {
    try {
      const msg = (error as any)?.message || `${error || ''}`
      if (msg.includes('WRONGTYPE')) {
        logger.warn('Redis WRONGTYPE on GET %s', key)
        return null
      }
    } catch {}
    if (!client) {
      await getRedis()
      return client.get(key)
    } else {
      throw error
    }
  }
}

export const redisMGet = async (keys: string[]): Promise<(string | null | undefined)[]> => {
  if (!keys || keys.length === 0) return []
  logger.trace(`MGET ${keys.length} keys`)
  try {
    return await client.mGet(keys)
  } catch (error) {
    try {
      const msg = (error as any)?.message || `${error || ''}`
      if (msg.includes('WRONGTYPE')) {
        logger.warn('Redis WRONGTYPE on MGET (%s keys)', keys.length)
        return keys.map(() => null)
      }
    } catch {}
    throw error
  }
}

export const redisTtl = async (key: string) => {
  logger.trace(`Ttl ${key}`)
  try {
    return client.ttl(key)
  } catch (error) {
    if (!client) {
      await getRedis()
      return client.ttl(key)
    } else {
      throw error
    }
  }
}

const redisDel = async (key: string) => {
  logger.trace(`Deleting ${key}`)
  try {
    return client.del(key)
  } catch (error) {
    if (!client) {
      await getRedis()
      return client.del(key)
    } else {
      throw error
    }
  }
}

export const redisDelKey = async (key: string) => redisDel(key)

export const redisKeys = async (pattern: string) => {
  logger.trace(`Keys ${pattern}`)
  try {
    return await client.keys(pattern)
  } catch (error) {
    if (!client) {
      await getRedis()
      return await client.keys(pattern)
    } else {
      throw error
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const redisSet = async function (key: string, value: any) {
  logger.trace(`Setting ${key} => ${(value + '').substring(0, 10)}...`)
  try {
    return client.set(key, value)
  } catch (error) {
    if (!client) {
      await getRedis()
      return client.set(key, value)
    } else {
      throw error
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const redisSetAndExpire = async function (key: string, value: any, ttl: number) {
  logger.trace(`Setting ttl: ${ttl} ${key} -> ${(value + '').substring(0, 10)}...`)
  if (ttl < 0) {
    return redisSet(key, value)
  }
  try {
    return client.set(key, value, { EX: ttl })
  } catch (error) {
    if (!client) {
      await getRedis()
      return client.set(key, value, { EX: ttl })
    } else {
      throw error
    }
  }
}

// Helper: SCAN keys with pattern, returning up to `limit` keys (non-blocking vs KEYS)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const redisScanSome = async (pattern: string, limit: number): Promise<string[]> => {
  try {
    const c: any = await getRedis()
    let cursor = '0'
    const out: string[] = []
    const count = Math.max(10, limit || 100)
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await c.scan(cursor, { MATCH: pattern, COUNT: count })
      cursor = (typeof res.cursor !== 'undefined') ? `${res.cursor}` : `${res[0]}`
      const keys: string[] = Array.isArray(res.keys) ? res.keys : (res[1] || [])
      for (const k of keys || []) {
        out.push(k)
        if (out.length >= limit) return out
      }
    } while (cursor !== '0')
    return out
  } catch {
    try { const keys = await redisKeys(pattern); return (keys || []).slice(0, limit) } catch { return [] }
  }
}


// Atomic increment with TTL. Sets TTL on first increment (value === 1)
export const redisIncrWithTtl = async (key: string, ttlSec: number): Promise<number> => {
  logger.trace(`INCR ${key} with ttl ${ttlSec}s`)
  try {
    const v = await client.incr(key)
    if (v === 1 && ttlSec > 0) {
      try { await client.expire(key, ttlSec) } catch {}
    }
    return v
  } catch (error) {
    if (!client) {
      await getRedis()
      const v = await client.incr(key)
      if (v === 1 && ttlSec > 0) {
        try { await client.expire(key, ttlSec) } catch {}
      }
      return v
    }
    throw error
  }
}

// Set key with NX + TTL (seconds). Returns true if the lock was acquired.
export const redisSetIfNotExists = async (key: string, value: string, ttlSec: number): Promise<boolean> => {
  try {
    const c: any = await getRedis()
    const res = await c.set(key, value, { NX: true, EX: ttlSec })
    return res === 'OK'
  } catch {
    return false
  }
}

// Webhook circuit breaker keys
export const webhookCircuitOpenKey = (session: string, webhookId: string) =>
  `${BASE_KEY}webhook-cb:${session}:${webhookId}:open`
export const webhookCircuitFailKey = (session: string, webhookId: string) =>
  `${BASE_KEY}webhook-cb:${session}:${webhookId}:fail`

export const isWebhookCircuitOpen = async (session: string, webhookId: string): Promise<boolean> => {
  if (!process.env.REDIS_URL) return false
  const key = webhookCircuitOpenKey(session, webhookId)
  try {
    const v = await redisGet(key)
    return !!v
  } catch {
    return false
  }
}

export const openWebhookCircuit = async (session: string, webhookId: string, openMs: number): Promise<void> => {
  if (!process.env.REDIS_URL) return
  const ttlSec = Math.max(1, Math.ceil((openMs || 0) / 1000))
  try {
    await redisSetAndExpire(webhookCircuitOpenKey(session, webhookId), '1', ttlSec)
  } catch {}
}

export const closeWebhookCircuit = async (session: string, webhookId: string): Promise<void> => {
  if (!process.env.REDIS_URL) return
  try { await redisDel(webhookCircuitOpenKey(session, webhookId)) } catch {}
  try { await redisDel(webhookCircuitFailKey(session, webhookId)) } catch {}
}

export const bumpWebhookCircuitFailure = async (session: string, webhookId: string, ttlMs: number): Promise<number> => {
  if (!process.env.REDIS_URL) return 0
  const ttlSec = Math.max(1, Math.ceil((ttlMs || 0) / 1000))
  try {
    return await redisIncrWithTtl(webhookCircuitFailKey(session, webhookId), ttlSec)
  } catch {
    return 0
  }
}

export const authKey = (phone: string) => {
  return `${BASE_KEY}auth:${phone}`
}

const authIndexKey = (phone: string) => {
  return `${BASE_KEY}auth-index:${phone}`
}

const connectCountTotalKey = (phone: string) => {
  return `${BASE_KEY}connect-count:${phone}:total`
}

export const lastTimerKey = (from: string, to: string) => {
  return `${BASE_KEY}timer:${from}:${to}`
}

export const sessionStatusKey = (phone: string) => {
  return `${BASE_KEY}status:${phone}`
}

const messageStatusKey = (phone: string, id: string) => {
  return `${BASE_KEY}message-status:${phone}:${id}`
}

const mediaKey = (phone: string, id: string) => {
  return `${BASE_KEY}media:${phone}:${id}`
}

const bulkMessageKeyBase = (phone: string, bulkId: string) => {
  return `${BASE_KEY}bulk-message:${phone}:${bulkId}`
}

const bulkIndexKey = (phone: string, bulkId: string) => {
  return `${BASE_KEY}bulk-index:${phone}:${bulkId}`
}

const bulkMessageKey = (phone: string, bulkId: string, messageId: string, phoneNumber: string) => {
  return `${bulkMessageKeyBase(phone, bulkId)}:${messageId}:${phoneNumber}`
}

const messageKey = (phone: string, jid: string, id: string) => {
  return `${BASE_KEY}message:${phone}:${jid}:${id}`
}

// Última mensagem recebida (não-fromMe) por chat
const lastIncomingKeyKey = (phone: string, jid: string) => {
  return `${BASE_KEY}last-incoming:${phone}:${jid}`
}

// Contact names cache key
const contactNameKey = (phone: string, jid: string) => {
  return `${BASE_KEY}contact-name:${phone}:${jid}`
}
const contactInfoKey = (phone: string, jid: string) => {
  return `${BASE_KEY}contact-info:${phone}:${jid}`
}
const contactSyncPendingKey = (phone: string) => {
  return `${BASE_KEY}contact-sync:pending:${phone}`
}

const pollStateKey = (phone: string, jid: string, pollId: string) => {
  return `${BASE_KEY}poll-state:${phone}:${jid}:${pollId}`
}
const statusMediaKey = (phone: string, statusId: string) => {
  return `${BASE_KEY}status-media:${phone}:${statusId}`
}

export const configKey = (phone: string) => {
  return `${BASE_KEY}config:${phone}`
}

const configAuthTokenIndexKey = () => {
  return `${BASE_KEY}config:auth-token-index`
}

export const templateKey = (phone: string) => {
  return `${BASE_KEY}template:${phone}`
}

export const idKey = (phone: string, id: string) => {
  return `${BASE_KEY}key:${phone}:${id}`
}

export const unoIdKey = (phone: string, id: string) => {
  return `${BASE_KEY}id:${phone}:${id}`
}

export const providerIdKey = (phone: string, unoId: string) => {
  return `${BASE_KEY}id_rev:${phone}:${unoId}`
}

export const jidKey = (phone: string, jid: string) => {
  return `${BASE_KEY}jid:${phone}:${jid}`
}

export const profilePictureKey = (phone: string, jid: string) => {
  return `${BASE_KEY}profile-picture:${phone}:${jid}`
}

export const groupKey = (phone: string, jid: string) => {
  return `${BASE_KEY}group:${phone}:${jid}`
}

// JID mapping PN <-> LID keys
// New, clearer schema (human-friendly) — session scope e global scope:
//  Session scope:
//   - jidmap:<session>:pn_for_lid:<lidJid> => value = pnJid (@s.whatsapp.net)
//   - jidmap:<session>:lid_for_pn:<pnJid>  => value = lidJid (@lid)
//  Global scope (compartilhado entre sessões):
//   - jidmap:global:pn_for_lid:<lidJid> => value = pnJid
//   - jidmap:global:lid_for_pn:<pnJid>  => value = lidJid
// Backward-compat com chaves antigas por sessão:
//   - jidmap:<session>:pn:<lidJid>  => value = pnJid
//   - jidmap:<session>:lid:<pnJid>  => value = lidJid
const jidMapPnKeyNew   = (session: string, lidJid: string) => `${BASE_KEY}jidmap:${session}:pn_for_lid:${lidJid}`
const jidMapLidKeyNew  = (session: string, pnJid: string) => `${BASE_KEY}jidmap:${session}:lid_for_pn:${pnJid}`
const jidMapPnKeyGlob  = (lidJid: string) => `${BASE_KEY}jidmap:global:pn_for_lid:${lidJid}`
const jidMapLidKeyGlob = (pnJid: string)  => `${BASE_KEY}jidmap:global:lid_for_pn:${pnJid}`
const getAlternateBrPnJids = (pnJid: string): string[] => {
  const digits = `${pnJid || ''}`.split('@')[0].split(':')[0].replace(/\D/g, '')
  if (!digits.startsWith('55')) return []
  if (digits.length === 13 && digits.charAt(4) === '9') {
    return [`55${digits.slice(2, 4)}${digits.slice(5)}@s.whatsapp.net`]
  }
  if (digits.length === 12 && /[6-9]/.test(digits.charAt(4))) {
    return [`55${digits.slice(2, 4)}9${digits.slice(4)}@s.whatsapp.net`]
  }
  return []
}

export const getPnForLid = async (session: string, lidJid: string) => {
  if (!JIDMAP_STORED_LOOKUP_ENABLED) return undefined
  lidJid = normalizeLidJid(lidJid) || lidJid
  const vGlob = await redisGet(jidMapPnKeyGlob(lidJid))
  if (vGlob) return vGlob
  const vNew = await redisGet(jidMapPnKeyNew(session, lidJid))
  if (vNew) return vNew
  return undefined
}
export const getLidForPn = async (session: string, pnJid: string) => {
  if (!JIDMAP_STORED_LOOKUP_ENABLED) return undefined
  const vGlob = await redisGet(jidMapLidKeyGlob(pnJid))
  if (vGlob) return normalizeLidJid(vGlob) || vGlob
  const vNew = await redisGet(jidMapLidKeyNew(session, pnJid))
  if (vNew) return normalizeLidJid(vNew) || vNew
  return undefined
}
export const setJidMapping = async (session: string, pnJid: string, lidJid: string) => {
  if (!pnJid || !lidJid) return
  lidJid = normalizeLidJid(lidJid) || lidJid
  // Sanity check: ensure correct roles (pnJid is @s.whatsapp.net, lidJid is @lid)
  try {
    const pnIsPn = typeof pnJid === 'string' && pnJid.endsWith('@s.whatsapp.net')
    const lidIsLid = typeof lidJid === 'string' && lidJid.endsWith('@lid')
    const pnIsLid = typeof pnJid === 'string' && pnJid.endsWith('@lid')
    const lidIsPn = typeof lidJid === 'string' && lidJid.endsWith('@s.whatsapp.net')
    if (!pnIsPn || !lidIsLid) {
      if (pnIsLid && lidIsPn) {
        const tmp = pnJid; pnJid = lidJid; lidJid = tmp
        lidJid = normalizeLidJid(lidJid) || lidJid
      } else {
        return
      }
    }
  } catch { return }
  const ttlSec = Number.isFinite(JIDMAP_TTL_SECONDS) ? JIDMAP_TTL_SECONDS : 0
  const setMapping = async (key: string, value: string) => {
    if (ttlSec > 0) return redisSetAndExpire(key, value, ttlSec)
    return redisSet(key, value)
  }
  try {
    const alternates = getAlternateBrPnJids(pnJid).filter((alt) => alt && alt !== pnJid)
    for (const altPnJid of alternates) {
      try { await redisDel(jidMapLidKeyGlob(altPnJid)) } catch {}
      try { await redisDel(jidMapLidKeyNew(session, altPnJid)) } catch {}
    }
  } catch {}
  // Apenas escopo global (reduz chaves duplicadas por sess?o); leitura legacy continua via fallback
  try { await setMapping(jidMapPnKeyGlob(lidJid), pnJid) } catch {}
  try { await setMapping(jidMapLidKeyGlob(pnJid), lidJid) } catch {}
}

// Remove selective Signal sessions for a session phone & target JIDs (PN/LID variants)
// This forces Baileys to fetch sessions again on next assert.
export const delSignalSessionsForJids = async (session: string, jids: string[], opts?: { forceDeviceList?: boolean }) =>
  enqueueRedisTask('delivery-watch-purge', async () => {
    try {
      const base = `${BASE_KEY}auth:${session}:`
      let totalDeleted = 0
      for (const raw of (jids || [])) {
        const v = `${raw || ''}`
        if (!v) continue
        // Build variants: full JID, base without domain/suffix, and digits-only PN when available
        const variants = new Set<string>()
        variants.add(v)
        try {
          const baseId = v.split('@')[0] // remove domain
          if (baseId) variants.add(baseId)
          const noDevice = baseId.split(':')[0] // remove :device
          if (noDevice) variants.add(noDevice)
        } catch {}
        try {
          // digits PN variant (if possible)
          const digits = v.replace(/\D/g, '')
          if (digits) variants.add(digits)
        } catch {}
        // Known Signal state key families to purge for target address (try with all variants)
        const patterns: string[] = []
        const forceDeviceList = !!opts?.forceDeviceList
        for (const id of Array.from(variants)) {
          if (SIGNAL_PURGE_SESSION_ENABLED) patterns.push(`${base}session-${id}*`)
          if (SIGNAL_PURGE_SENDER_KEY_ENABLED) patterns.push(`${base}sender-key-${id}*`)
          // For device-list purge, allow opt-in per call (forceDeviceList) even when global default is false
          if (SIGNAL_PURGE_DEVICE_LIST_ENABLED || forceDeviceList) patterns.push(`${base}device-list-${id}*`)
        }
        for (const p of patterns) {
          try {
            const keys = await redisScanSome(p, Math.max(50, WATCHDOG_PURGE_SCAN_COUNT || 200))
            let deleted = 0
            for (const k of keys || []) {
              try { await redisDel(k); deleted += 1 } catch {}
            }
            if (deleted > 0) {
              totalDeleted += deleted
              try { logger.debug('DELIVERY_WATCH purge: %s deleted for pattern %s', deleted, p) } catch {}
            } else {
              try { logger.debug('DELIVERY_WATCH purge: no keys for pattern %s', p) } catch {}
            }
          } catch {}
        }
      }
      try { logger.info('DELIVERY_WATCH purge: total deleted=%s for %s target(s)', totalDeleted, (jids || []).length) } catch {}
    } catch (e) {
      try { logger.warn(e as any, 'Ignore error during session purge for %s', session) } catch {}
    }
  }, WATCHDOG_TASK_MIN_INTERVAL_MS)

// Light probe to count Signal session keys for target JIDs (debug/observability)
export const countSignalSessionsForJids = async (session: string, jids: string[]) =>
  enqueueRedisTask('delivery-watch-probe', async () => {
    try {
      const base = `${BASE_KEY}auth:${session}:`
      let total = 0
      for (const raw of (jids || [])) {
        const v = `${raw || ''}`
        if (!v) continue
        const variants = new Set<string>()
        variants.add(v)
        try {
          const baseId = v.split('@')[0]
          if (baseId) variants.add(baseId)
          const noDevice = baseId.split(':')[0]
          if (noDevice) variants.add(noDevice)
        } catch {}
        try {
          const digits = v.replace(/\D/g, '')
          if (digits) variants.add(digits)
        } catch {}
        for (const id of Array.from(variants)) {
          const patterns = [
            `${base}session-${id}*`,
            `${base}sender-key-${id}*`,
            `${base}device-list-${id}*`,
          ]
          for (const p of patterns) {
            try {
              const keys = await redisScanSome(p, Math.max(50, WATCHDOG_PURGE_SCAN_COUNT || 200))
              const count = (keys || []).length
              total += count
              try { logger.debug('ASSERT probe: %s keys (sample) for pattern %s', count, p) } catch {}
            } catch {}
          }
        }
      }
      try { logger.info('ASSERT probe: total keys=%s for %s target(s)', total, (jids || []).length) } catch {}
    } catch (e) {
      try { logger.warn(e as any, 'Ignore error during assert probe for %s', session) } catch {}
    }
  }, WATCHDOG_TASK_MIN_INTERVAL_MS)

export const blacklist = (from: string, webhookId: string, to: string) => {
  return `${BASE_KEY}blacklist:${from}:${webhookId}:${to}`
}

export const getJid = async (phone: string, jid: any) => {
  const key = jidKey(phone, jid)
  return redisGet(key)
}

export const setJid = async (phone: string, jid: string, validJid: string) => {
  const key = jidKey(phone, jid)
  await client.set(key, validJid)
}

export const setBlacklist = async (from: string, webhookId: string, to: string, ttl: number) => {
  const key = blacklist(from, webhookId, to)
  if (ttl > 0) {
    return client.set(key, '1', { EX: ttl })
  } else if (ttl == 0) {
    return client.del(key)
  } else {
    return client.set(key, '1')
  }
}

export const getSessionStatus = async (phone: string) => {
  await ensureSessionStatusSub()
  const cached = sessionStatusCache.get(phone)
  if (cached && isCacheValid(cached.ts, SESSION_STATUS_CACHE_TTL_MS)) {
    return cached.value || undefined
  }
  const key = sessionStatusKey(phone)
  const v = await redisGet(key)
  sessionStatusCache.set(phone, { value: v || null, ts: Date.now() })
  return v
}

export const setSessionStatus = async (phone: string, status: string) => {
  const key = sessionStatusKey(phone)
  await client.set(key, status)
  sessionStatusCache.set(phone, { value: status, ts: Date.now() })
  await publishSessionStatusUpdate(phone)
}

export const delSessionStatus = async (phone: string) => {
  const key = sessionStatusKey(phone)
  await redisDel(key)
  sessionStatusCache.delete(phone)
  await publishSessionStatusUpdate(phone)
}

export const delSessionTransientKeys = async (phone: string) => {
  const patterns = [
    `${BASE_KEY}contact-info:${phone}:*`,
    `${BASE_KEY}contact-name:${phone}:*`,
    `${BASE_KEY}last-incoming:${phone}:*`,
    `${BASE_KEY}profile-picture-refresh:${phone}:*`,
  ]
  let totalDeleted = 0
  for (const pattern of patterns) {
    try {
      const keys = await redisKeys(pattern)
      if (!keys || keys.length === 0) continue
      for (const key of keys) {
        try {
          await redisDel(key)
          totalDeleted += 1
        } catch {}
      }
    } catch (e) {
      logger.warn(e as any, 'Ignore error deleting transient keys for %s with pattern %s', phone, pattern)
    }
  }
  logger.info('Deleted %s transient redis keys for %s', totalDeleted, phone)
}

export const getMessageStatus = async (phone: string, id: string) => {
  const key = messageStatusKey(phone, id)
  return redisGet(key)
}

export const setMessageStatus = async (phone: string, id: string, status: string) => {
  const key = messageStatusKey(phone, id)
  await client.set(key, status, { EX: DATA_TTL })
}

export const getTemplates = async (phone: string) => {
  const key = templateKey(phone)
  const configString = await redisGet(key)
  if (configString) {
    const config = JSON.parse(configString)
    return config
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setTemplates = async (phone: string, value: any) => {
  const key = templateKey(phone)
  let config = value

  if (!Array.isArray(value)) {
    const { id } = value || {}
    if (!id) {
      throw new Error(`New template has no ID or an invalid format`)
    }
    const current = (await getTemplates(phone)) || []
    const currentList = Array.isArray(current) ? current : [current]
    config = currentList.filter((template: any) => template.id !== id)
    config.push(value)
  }

  await redisSetAndExpire(key, JSON.stringify(config), SESSION_TTL)
  return config
}

export const getConfig = async (phone: string) => {
  const key = configKey(phone)
  const configString = await redisGet(key)
  if (configString) {
    const config = JSON.parse(configString)
    return config
  }
}

export const getAllAuthTokens = async (): Promise<string[]> => {
  try {
    return await client.sMembers(configAuthTokenIndexKey())
  } catch {
    return []
  }
}

export const addAuthTokensToIndex = async (tokens: string[]) => {
  try {
    const vals = (tokens || []).filter((t) => !!t)
    if (vals.length === 0) return
    await client.sAdd(configAuthTokenIndexKey(), vals)
  } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setConfig = async (phone: string, value: any) => {
  const currentConfig = await getConfig(phone)
  const key = configKey(phone)
  const currentWebhooks: Webhook[] = currentConfig && currentConfig.webhooks || []
  const newWebhooks: Webhook[] = value && value.webhooks || []
  const updatedWebooks: Webhook[] = []
  const baseWebhook = value.overrideWebhooks || currentWebhooks.length == 0 ? newWebhooks : currentWebhooks
  const searchWebhooks = value.overrideWebhooks ? currentWebhooks : newWebhooks
  baseWebhook.forEach(n => {
    const c = searchWebhooks.find((c) => c.id === n.id)
    if (c) {
      updatedWebooks.push({ ...c, ...n })
    } else {
      updatedWebooks.push(n)
    }
  })
  value.webhooks = updatedWebooks
  const config = { ...currentConfig, ...value }
  try {
    const mode = `${(config as any).oneToOneAddressingMode || ''}`.trim().toLowerCase()
    if (mode === 'pn' || mode === 'lid') (config as any).oneToOneAddressingMode = mode
    else delete (config as any).oneToOneAddressingMode
  } catch {}
  // Enforce per-session storage flags to avoid false overrides via templates/UI
  // Since this setter persists to Redis, sessions using Redis must have useRedis/useS3 true
  try { (config as any).useRedis = true } catch {}
  try { (config as any).useS3 = true } catch {}
  delete config.overrideWebhooks
  await redisSetAndExpire(key, JSON.stringify(config), SESSION_TTL)
  try {
    const oldToken = (currentConfig as any)?.authToken
    const newToken = (config as any)?.authToken
    const indexKey = configAuthTokenIndexKey()
    if (oldToken && oldToken !== newToken) {
      await client.sRem(indexKey, oldToken)
    }
    if (newToken) {
      await client.sAdd(indexKey, newToken)
    }
  } catch {}
  await publishConfigUpdate(phone)
  try {
    const phoneNumberId = (config as any)?.webhookForward?.phoneNumberId
    if (phoneNumberId) {
      await setPhoneNumberIdMapping(phone, phoneNumberId)
    }
  } catch (e) { logger.debug(e as any, 'ignore setPhoneNumberIdMapping error') }
  try {
    const businessAccountId = (config as any)?.webhookForward?.businessAccountId
    if (businessAccountId) {
      await setBusinessAccountIdMapping(phone, businessAccountId)
    }
  } catch (e) { logger.debug(e as any, 'ignore setBusinessAccountIdMapping error') }
  configs.delete(phone)
  return config
}

export const delConfig = async (phone: string) => {
  const key = configKey(phone)
  try {
    const current = await getConfig(phone)
    const token = (current as any)?.authToken
    if (token) {
      await client.sRem(configAuthTokenIndexKey(), token)
    }
  } catch {}
  await redisDel(key)
  await delHistorySyncMarker(phone)
  await publishConfigUpdate(phone)
}

export const delAuth = async (phone: string) => {
  const key = authKey(phone)
  logger.trace(`Deleting key ${key}...`)
  await redisDel(key)
  authCache.delete(key)
  await publishAuthUpdate(key)
  logger.debug(`Deleted key ${key}!`)
  const indexKey = authIndexKey(phone)
  let keys = await client.sMembers(indexKey)
  if (!keys || keys.length === 0) {
    const pattern = authKey(`${phone}:*`)
    keys = await redisKeys(pattern)
  }
  logger.debug(`${keys.length} keys to delete auth for ${phone}`)
  for (let i = 0, j = keys.length; i < j; i++) {
    const key = keys[i]
    logger.trace(`Deleting key ${key}...`)
    await redisDel(key)
    authCache.delete(key)
    await publishAuthUpdate(key)
    logger.trace(`Deleted key ${key}!`)
  }
  await redisDel(indexKey)
  await delHistorySyncMarker(phone)
}

export const getAuth = async (phone: string, parse = (value: string) => JSON.parse(value)) => {
  await ensureAuthSub()
  const key = authKey(phone)
  const cached = authCache.get(key)
  if (cached && isCacheValid(cached.ts, AUTH_CACHE_TTL_MS)) {
    return cached.value ? parse(cached.value) : undefined
  }
  const authString = await redisGet(key)
  if (authString) {
    authCache.set(key, { value: authString, ts: Date.now() })
    const authJson = parse(authString)
    return authJson
  }
  authCache.set(key, { value: null, ts: Date.now() })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setAuth = async (phone: string, value: any, stringify = (value: string) => JSON.stringify(value, null, '\t')) => {
  const key = authKey(phone)
  const authValue = stringify(value)
  const res = await redisSetAndExpire(key, authValue, SESSION_TTL)
  try {
    const indexKey = authIndexKey(phone.split(':')[0])
    await client.sAdd(indexKey, key)
    await client.expire(indexKey, SESSION_TTL)
  } catch {}
  authCache.set(key, { value: authValue, ts: Date.now() })
  await publishAuthUpdate(key)
  return res
}

export const getAuthRaw = async (phone: string): Promise<string | undefined> => {
  await ensureAuthSub()
  const key = authKey(phone)
  const cached = authCache.get(key)
  if (cached && isCacheValid(cached.ts, AUTH_CACHE_TTL_MS)) {
    return cached.value ?? undefined
  }
  const authString = await redisGet(key)
  if (authString) {
    authCache.set(key, { value: authString, ts: Date.now() })
    return authString
  }
  authCache.set(key, { value: null, ts: Date.now() })
}

export const getAuthRawMany = async (phones: string[]): Promise<Record<string, string | undefined>> => {
  await ensureAuthSub()
  const out: Record<string, string | undefined> = {}
  if (!phones || phones.length === 0) return out
  const keys = phones.map((p) => authKey(p))
  const missing: { key: string; phone: string }[] = []
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    const cached = authCache.get(key)
    if (cached && isCacheValid(cached.ts, AUTH_CACHE_TTL_MS)) {
      out[phones[i]] = cached.value ?? undefined
    } else {
      missing.push({ key, phone: phones[i] })
    }
  }
  if (!missing.length) return out
  const values = await redisMGet(missing.map((m) => m.key))
  for (let i = 0; i < missing.length; i += 1) {
    const value = values?.[i]
    const phone = missing[i].phone
    const key = missing[i].key
    if (value) {
      authCache.set(key, { value, ts: Date.now() })
      out[phone] = value
    } else {
      authCache.set(key, { value: null, ts: Date.now() })
      out[phone] = undefined
    }
  }
  return out
}

export const getAuthIndexMembers = async (phone: string): Promise<string[]> => {
  const indexKey = authIndexKey(phone)
  try {
    return await client.sMembers(indexKey)
  } catch {
    return []
  }
}

export const addAuthKeysToIndex = async (phone: string, keys: string[]) => {
  try {
    if (!keys || keys.length === 0) return
    const indexKey = authIndexKey(phone)
    await client.sAdd(indexKey, keys)
    await client.expire(indexKey, SESSION_TTL)
  } catch {}
}

export const setbulkMessage = async (phone: string, bulkId: string, messageId: string, phoneNumber) => {
  const key = bulkMessageKey(phone, bulkId, messageId, phoneNumber)
  const indexKey = bulkIndexKey(phone, bulkId)
  await client.sAdd(indexKey, `${messageId}:${phoneNumber}`)
  await client.expire(indexKey, DATA_TTL)
  return redisSetAndExpire(key, 'scheduled', DATA_TTL)
}

export const getBulkReport = async (phone: string, id: string) => {
  const indexKey = bulkIndexKey(phone, id)
  const members: string[] = await client.sMembers(indexKey)
  const keys = members.map((member) => `${bulkMessageKeyBase(phone, id)}:${member}`)
  logger.debug(`keys: ${JSON.stringify(keys)}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report: any = await keys.reduce(async (accP: Promise<any>, key: string) => {
    const data = key.split(':')
    const messageId = data[3]
    const phoneNumber = data[4]
    const statusKey = messageStatusKey(phone, messageId)
    const acc = await accP
    acc[phoneNumber] = await redisGet(statusKey)
    return acc
  }, Promise.resolve({}))

  logger.debug(`Report: ${JSON.stringify(report)}`)

  const numbers = Object.keys(report)
  logger.debug(`numbers: ${JSON.stringify(numbers)}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = numbers.reduce((acc: any, number: string) => {
    const s = report[number]
    if (!acc[s]) {
      acc[s] = 0
    }
    acc[s] = acc[s] + 1
    return acc
  }, {})
  logger.debug(`status: ${JSON.stringify(status)}`)

  return { report, status }
}

export const getMessage = async <T>(phone: string, jid: string, id: string): Promise<T | undefined> => {
  const key = messageKey(phone, jid, id)
  const stored = await redisGet(key)
  if (!stored) return undefined
  // Detect JSON vs base64-encoded protobuf
  if (stored.trim().startsWith('{') || stored.trim().startsWith('[')) {
    try { return JSON.parse(stored) as T } catch { return undefined }
  }
  try {
    const bytes = Buffer.from(stored, 'base64')
    const msg = proto.WebMessageInfo.decode(bytes)
    // Return protobuf message instance (compatible at runtime with WAMessage usage)
    return msg as unknown as T
  } catch {
    // last resort: ignore corrupt entry
    return undefined
  }
}

export const getMessageWithSecretAnySession = async <T>(id: string): Promise<T | undefined> => {
  const messageId = `${id || ''}`.trim()
  if (!messageId) return undefined
  const keys = await redisScanSome(`${BASE_KEY}message:*:*:${messageId}`, 50)
  let fallback: T | undefined
  for (const key of keys) {
    try {
      const stored = await redisGet(key)
      if (!stored) continue
      let msg: any
      if (stored.trim().startsWith('{') || stored.trim().startsWith('[')) {
        msg = JSON.parse(stored)
      } else {
        msg = proto.WebMessageInfo.decode(Buffer.from(stored, 'base64'))
      }
      if (msg?.message?.messageContextInfo?.messageSecret) return msg as T
      if (msg && !fallback) fallback = msg as T
    } catch {}
  }
  return fallback
}

export const getUnoIdsForProviderAnySession = async (id: string): Promise<Array<{ phone: string; unoId: string }>> => {
  const providerId = `${id || ''}`.trim()
  if (!providerId) return []
  const keys = await redisScanSome(`${BASE_KEY}id:*:${providerId}`, 50)
  const mappings: Array<{ phone: string; unoId: string }> = []
  const seen = new Set<string>()
  for (const key of keys) {
    try {
      const unoId = `${await redisGet(key) || ''}`.trim()
      if (!unoId) continue
      const parts = key.split(':')
      const phone = `${parts[1] || ''}`.trim()
      if (!phone) continue
      const dedupKey = `${phone}:${unoId}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      mappings.push({ phone, unoId })
    } catch {}
  }
  return mappings
}

// Persistência de última mensagem recebida por chat
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getLastIncomingKey = async (phone: string, jid: string): Promise<any | undefined> => {
  const key = lastIncomingKeyKey(phone, jid)
  const stored = await redisGet(key)
  if (!stored) return undefined
  try { return JSON.parse(stored) } catch { return undefined }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setLastIncomingKey = async (phone: string, jid: string, value: any) => {
  const key = lastIncomingKeyKey(phone, jid)
  return redisSetAndExpire(key, JSON.stringify(value), DATA_TTL)
}

export const getContactName = async (phone: string, jid: string) => {
  const key = contactNameKey(phone, jid)
  return redisGet(key)
}
export const setContactName = async (phone: string, jid: string, name: string) => {
  const key = contactNameKey(phone, jid)
  return redisSetAndExpire(key, name, SESSION_TTL)
}
export const getContactInfo = async (phone: string, jid: string) => {
  const key = contactInfoKey(phone, jid)
  return redisGet(key)
}
export const setContactInfo = async (phone: string, jid: string, info: any) => {
  const key = contactInfoKey(phone, jid)
  return redisSetAndExpire(key, JSON.stringify(info || {}), SESSION_TTL)
}

export const setContactSyncPending = async (phone: string, ttlSec: number) => {
  if (!process.env.REDIS_URL) return undefined
  const key = contactSyncPendingKey(phone)
  return redisSetAndExpire(key, '1', ttlSec)
}

export const getPollState = async (phone: string, jid: string, pollId: string): Promise<any | undefined> => {
  const key = pollStateKey(phone, jid, pollId)
  const raw = await redisGet(key)
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

export const setPollState = async (phone: string, jid: string, pollId: string, value: any) => {
  const key = pollStateKey(phone, jid, pollId)
  return redisSetAndExpire(key, JSON.stringify(value || {}), DATA_TTL)
}

export const getStatusMediaState = async (phone: string, statusId: string): Promise<any | undefined> => {
  const key = statusMediaKey(phone, statusId)
  const raw = await redisGet(key)
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

export const setStatusMediaState = async (phone: string, statusId: string, value: any, ttlSec = 86400) => {
  const key = statusMediaKey(phone, statusId)
  return redisSetAndExpire(key, JSON.stringify(value || {}), ttlSec)
}

export const delContactSyncPending = async (phone: string) => {
  if (!process.env.REDIS_URL) return 0
  const key = contactSyncPendingKey(phone)
  try {
    const c: any = await getRedis()
    return c.del(key)
  } catch {
    return 0
  }
}

// Varre contact-info da sessão e enriquece o JIDMAP PN<->LID
export const getPnForLidFromAuthCache = async (session: string, lidJid: string): Promise<string | undefined> => {
  try {
    lidJid = normalizeLidJid(lidJid) || lidJid
    const digits = `${lidJid || ''}`.split('@')[0].split(':')[0].replace(/\D/g, '')
    if (!digits) return undefined
    const key = `${BASE_KEY}auth:${session}:lid-mapping-${digits}_reverse`
    const raw = await redisGet(key)
    if (!raw) return undefined
    const val = `${raw}`
    if (val.endsWith('@s.whatsapp.net')) return val
    const pnDigits = val.replace(/\D/g, '')
    return pnDigits ? `${pnDigits}@s.whatsapp.net` : undefined
  } catch { return undefined }
}

export const getLidForPnFromAuthCache = async (session: string, pnJid: string): Promise<string | undefined> => {
  try {
    const digits = `${pnJid || ''}`.split('@')[0].split(':')[0].replace(/\D/g, '')
    if (!digits) return undefined
    const key = `${BASE_KEY}auth:${session}:lid-mapping-${digits}`
    const raw = await redisGet(key)
    if (!raw) return undefined
    const val = `${raw}`
    const normalizedLid = normalizeLidJid(val)
    if (normalizedLid) return normalizedLid
    const lidDigits = val.replace(/\D/g, '')
    return lidDigits ? `${lidDigits}@lid` : undefined
  } catch { return undefined }
}

export const getDeviceJidsForPnFromAuthCache = async (session: string, pnJid: string, limit = 20): Promise<string[]> => {
  try {
    const digits = `${pnJid || ''}`.split('@')[0].split(':')[0].replace(/\D/g, '')
    if (!digits) return []
    const base = `${BASE_KEY}auth:${session}:session-`
    const keys = await redisScanSome(`${base}${digits}*`, Math.max(20, limit * 3))
    const out = new Set<string>()
    const addDevice = (device: string | undefined) => {
      if (!device || !/^\d+$/.test(device)) return
      out.add(`${digits}:${device}@s.whatsapp.net`)
    }
    for (const key of keys || []) {
      const suffix = `${key || ''}`.startsWith(base) ? `${key}`.slice(base.length) : `${key || ''}`
      // Baileys Signal ProtocolAddress serializes as "user.device"; older/local helpers may use "user:device".
      const match = suffix.match(new RegExp(`^${digits}(?:@s\\.whatsapp\\.net)?[.:](\\d+)(?:\\D|$)`))
      addDevice(match?.[1])
      if (out.size >= limit) break
    }
    return Array.from(out)
  } catch { return [] }
}

export const getConnectCount = async(phone: string) => {
  await ensureConnectCountSub()
  const cached = connectCountCache.get(phone)
  if (cached && isCacheValid(cached.ts, CONNECT_COUNT_CACHE_TTL_MS)) {
    return cached.value
  }
  const key = connectCountTotalKey(phone)
  const raw = await redisGet(key)
  const count = raw ? parseInt(`${raw}`, 10) || 0 : 0
  connectCountCache.set(phone, { value: count, ts: Date.now() })
  return count
}

export const clearConnectCount = async(phone: string) => {
  const key = connectCountTotalKey(phone)
  await redisDel(key)
  connectCountCache.delete(phone)
  await publishConnectCountUpdate(phone)
}

export const setConnectCount = async (phone: string, count: number, ttl: number) => {
  const key = connectCountTotalKey(phone)
  await redisSetAndExpire(key, count, ttl)
  connectCountCache.set(phone, { value: count, ts: Date.now() })
  await publishConnectCountUpdate(phone)
}

// One-time bootstrap: migrate all per-session JIDMAP pairs into the global JIDMAP namespace
export const enrichJidMapFromAuthLidCache = async (session: string): Promise<void> =>
  enqueueRedisTask('jidmap-enrich-auth', async () => {
    try {
      const base = `${BASE_KEY}auth:${session}:`
      const pattern = `${base}lid-mapping-*`
      const cursorKey = `${BASE_KEY}jidmap:cursor:${session}:auth-lid-cache`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = await getRedis()
      let cursor: string = (await redisGet(cursorKey)) || '0'
      let updated = 0
      let scanned = 0
      const limit = Math.max(50, JIDMAP_ENRICH_PER_SWEEP || 200)
      // Varre um pedaço por execução para reduzir custo (SCAN + COUNT)
      let res: any
      try { res = await c.scan(cursor, { MATCH: pattern, COUNT: limit }) } catch { res = undefined }
      if (res) {
        cursor = (typeof res.cursor !== 'undefined') ? `${res.cursor}` : `${res[0]}`
        const keys: string[] = Array.isArray(res.keys) ? res.keys : (res[1] || [])
        for (const k of keys || []) {
          if (scanned >= limit) break
          scanned += 1
          try {
            const v = await redisGet(k)
            if (!v) continue
            const sufIdx = k.indexOf('lid-mapping-')
            if (sufIdx < 0) continue
            const suffix = k.substring(sufIdx + 'lid-mapping-'.length)
            const rawVal = `${v}`
            const isReverse = suffix.endsWith('_reverse')
            if (isReverse) {
              const lidDigits = suffix.replace('_reverse', '').replace(/\D/g, '')
              const lidJid = lidDigits ? `${lidDigits}@lid` : undefined
              let pnJid: string | undefined
              if (rawVal.endsWith('@s.whatsapp.net')) pnJid = rawVal
              else {
                const pnDigits = rawVal.replace(/\D/g, '')
                if (pnDigits) pnJid = `${pnDigits}@s.whatsapp.net`
              }
              if (pnJid && lidJid) {
                try { await setJidMapping(session, pnJid, lidJid); updated += 1 } catch {}
              }
            } else {
              const pnDigits = suffix.replace(/\D/g, '')
              const pnJid = pnDigits ? `${pnDigits}@s.whatsapp.net` : undefined
              const lidJid = rawVal
              if (pnJid && typeof lidJid === 'string' && lidJid.endsWith('@lid')) {
                try { await setJidMapping(session, pnJid, lidJid); updated += 1 } catch {}
              }
            }
          } catch {}
        }
      }
      try { await redisSetAndExpire(cursorKey, cursor, 3600) } catch {}
      try { logger.info('JIDMAP enrich(auth): session=%s scanned=%s updated=%s', session, scanned, updated) } catch {}
    } catch (e) { try { logger.warn(e as any, 'JIDMAP enrich(auth) failed for session=%s', session) } catch {} }
  }, JIDMAP_ENRICH_MIN_INTERVAL_MS)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setMessage = async (phone: string, jid: string, id: string, value: any) => {
  const key = messageKey(phone, jid, id)
  // Prefer compact, robust protobuf encoding to avoid JSON Long/toObject pitfalls
  try {
    const bytes = proto.WebMessageInfo.encode(value as any).finish()
    const b64 = Buffer.from(bytes).toString('base64')
    return redisSetAndExpire(key, b64, DATA_TTL)
  } catch (e) {
    // Fallback: store a minimal JSON summary to avoid crashing
    try {
      const mt = (() => { try { return Object.keys(value?.message || {})[0] } catch { return undefined } })()
      const lite: any = {
        key: {
          id: value?.key?.id,
          remoteJid: value?.key?.remoteJid,
          fromMe: value?.key?.fromMe,
          participant: value?.key?.participant,
        },
        messageTimestamp: value?.messageTimestamp,
      }
      if (mt) lite.message = { [mt]: {} }
      return redisSetAndExpire(key, JSON.stringify(lite), DATA_TTL)
    } catch {
      return redisSetAndExpire(key, '{}', DATA_TTL)
    }
  }
}

export const getProfilePicture = async (phone: string, jid: string) => {
  const key = profilePictureKey(phone, jid)
  return redisGet(key)
}

export const setProfilePicture = async (phone: string, jid: string, url: string) => {
  const key = profilePictureKey(phone, jid)
  return redisSetAndExpire(key, url, DATA_URL_TTL)
}

export const getGroup = async (phone: string, jid: string) => {
  const key = groupKey(phone, jid)
  const group = await redisGet(key)
  if (group) {
    return JSON.parse(group) as GroupMetadata
  }
}

export const setGroup = async (phone: string, jid: string, data: GroupMetadata) => {
  const key = groupKey(phone, jid)
  const previous = await getGroup(phone, jid)
  return redisSetAndExpire(key, JSON.stringify(mergeGroupMetadataForCache(previous, data)), DATA_TTL)
}

export const setLastTimer = async (phone: string, to: string, current: Date) => {
  const key = lastTimerKey(phone, to)
  logger.debug('setLastTimer with key %s', key)
  return redisSet(key, current.toISOString())
}

export const getLastTimer = async (phone: string, to: string) => {
  const key = lastTimerKey(phone, to)
  logger.debug('getLastTimer with key %s', key)
  return redisGet(key)
}

export const delLastTimer = async (phone: string, to: string) => {
  const key = lastTimerKey(phone, to)
  logger.debug('delLastTimer with key %s', key)
  return redisDel(key)
}

export const setMedia = async (phone: string, id: string, payload: any) => {
  const key = mediaKey(phone, id)
  logger.debug('setMedia with key %s', key)
  return redisSetAndExpire(key, JSON.stringify(payload), DATA_TTL)
}

export const getMedia = async (phone: string, id: string) => {
  const key = mediaKey(phone, id)
  logger.debug('getMedia with key %s', key)
  const payload = await redisGet(key)
  return payload ? JSON.parse(payload) : undefined
}

export const getUnoId = async (phone: string, idBaileys: string) => {
  const key = unoIdKey(phone, idBaileys)
  return redisGet(key)
}

export const getProviderId = async (phone: string, idUno: string) => {
  const key = providerIdKey(phone, idUno)
  return redisGet(key)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setUnoId = async (phone: string, idBaileys: string, idUno: string) => {
  const key = unoIdKey(phone, idBaileys)
  const ttlSec = DATA_TTL
  const setIfAbsent = async (k: string, v: string, ttl: number): Promise<boolean> => {
    try {
      const c: any = await getRedis()
      const opts: any = { NX: true }
      if (ttl > 0) opts.EX = ttl
      const res = await c.set(k, v, opts)
      return res === 'OK'
    } catch {
      return false
    }
  }

  // Try to create the mapping only if it doesn't exist to avoid race duplicates.
  const created = await setIfAbsent(key, idUno, ttlSec)
  if (!created) {
    // Another worker created it; reuse the existing uno id.
    const existing = await redisGet(key)
    const chosen = existing || idUno
    const reverseKey = providerIdKey(phone, chosen)
    await redisSetAndExpire(reverseKey, idBaileys, ttlSec)
    return
  }

  const reverseKey = providerIdKey(phone, idUno)
  await redisSetAndExpire(reverseKey, idBaileys, ttlSec)
}

// Embedded/Meta Cloud mapping: phone_number_id -> phone session
const phoneNumberIdKey = (id: string) => `${BASE_KEY}meta:phone_number_id:${id}`
const businessAccountIdKey = (id: string) => `${BASE_KEY}meta:business_account_id:${id}`
export const setPhoneNumberIdMapping = async (phone: string, phoneNumberId: string) => {
  if (!phoneNumberId) return
  try {
    await redisSetAndExpire(phoneNumberIdKey(phoneNumberId), phone, SESSION_TTL >= 0 ? SESSION_TTL : DATA_TTL)
  } catch (e) {
    logger.warn(e as any, 'Failed to set phoneNumberId mapping')
  }
}
export const getPhoneByPhoneNumberId = async (phoneNumberId: string) => {
  if (!phoneNumberId) return undefined
  try {
    return await redisGet(phoneNumberIdKey(phoneNumberId))
  } catch (e) {
    logger.warn(e as any, 'Failed to get phone by phoneNumberId')
    return undefined
  }
}
export const setBusinessAccountIdMapping = async (phone: string, businessAccountId: string) => {
  if (!businessAccountId) return
  try {
    await redisSetAndExpire(businessAccountIdKey(businessAccountId), phone, SESSION_TTL >= 0 ? SESSION_TTL : DATA_TTL)
  } catch (e) {
    logger.warn(e as any, 'Failed to set businessAccountId mapping')
  }
}
export const getPhoneByBusinessAccountId = async (businessAccountId: string) => {
  if (!businessAccountId) return undefined
  try {
    return await redisGet(businessAccountIdKey(businessAccountId))
  } catch (e) {
    logger.warn(e as any, 'Failed to get phone by businessAccountId')
    return undefined
  }
}

// Rate limit keys
export const rateGlobalKey = (session: string) => `${BASE_KEY}ratelimit:${session}:global`
export const rateToKey = (session: string, to: string) => `${BASE_KEY}ratelimit:${session}:to:${to}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getKey = async (phone: string, id: string): Promise<any | undefined> => {
  const key = idKey(phone, id)
  const string = await redisGet(key)
  if (string) {
    const json = JSON.parse(string)
    return json
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setKey = async (phone: string, id: string, value: any) => {
  const key = idKey(phone, id)
  const string = JSON.stringify(value)
  return redisSetAndExpire(key, string, DATA_TTL)
}
