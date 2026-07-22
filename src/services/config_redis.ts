import { getConfig, Config, configs } from './config'
import { getConfig as getConfigCache, setBusinessAccountIdMapping, subscribeConfigUpdates } from './redis'
import { getStoreRedis } from './store_redis'
import { getStoreFile } from './store_file'
import logger from './logger'
import { getConfigByEnv } from './config_by_env'
import { MessageFilter } from './message_filter'
import { CONFIG_CACHE_TTL_MS } from '../defaults'
import { generateBusinessAccountId } from './meta_ids'
import { resolveSessionProvider } from './providers/provider_resolver'

const configCacheTs: Map<string, number> = new Map()
let configSubReady = false
let configSubStarting = false

const ensureConfigSub = async () => {
  if (configSubReady || configSubStarting) return
  configSubStarting = true
  try {
    await subscribeConfigUpdates((phone: string) => {
      configs.delete(phone)
      configCacheTs.delete(phone)
    })
    configSubReady = true
  } catch (e) {
    logger.warn(e as any, 'Config update subscription failed')
  } finally {
    configSubStarting = false
  }
}

export const getConfigRedis: getConfig = async (phone: string): Promise<Config> => {
  await ensureConfigSub()
  const previous = configs.get(phone)
  const previousGetMessageMetadata = previous?.getMessageMetadata
  if (configs.has(phone)) {
    const ts = configCacheTs.get(phone) || 0
    const ttlMs = CONFIG_CACHE_TTL_MS || 0
    if (ttlMs <= 0 || Date.now() - ts <= ttlMs) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return configs.get(phone)!
    }
    configs.delete(phone)
    configCacheTs.delete(phone)
  }
  if (!configs.has(phone)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storedConfig = await getConfigCache(phone)
    const hasStoredConfig = storedConfig !== null && storedConfig !== undefined
    const hasStoredProvider = hasStoredConfig
      && Object.prototype.hasOwnProperty.call(storedConfig, 'provider')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configRedis: any = { ...(storedConfig || {}) }
    logger.info('Retrieve config default for %s', phone)
    const config: Config = { ...(await getConfigByEnv(phone)) }

    if (configRedis) {
      Object.keys(configRedis).forEach((key) => {
        const value = configRedis[key]
        if (value === null || value === undefined) {
          logger.debug('Ignore null/undefined redis config in %s: %s', phone, key)
          return
        }
        if (!(key in config)) {
          logger.debug('Ignore unknown redis config in %s: %s', phone, key)
          return
        }
        if (key === 'webhooks') {
          if (!Array.isArray(value)) {
            logger.debug('Ignore invalid webhooks redis config in %s: expected array', phone)
            return
          }
          const webhooks: any[] = []
          value.forEach((webhook: any) => {
            Object.keys(config.webhooks[0]).forEach((keyWebhook) => {
              if (!(keyWebhook in webhook)) {
                // override by env, if not present in redis
                webhook[keyWebhook] = config.webhooks[0][keyWebhook]
              }
            })
            webhooks.push(webhook)
          })
          configRedis[key] = webhooks
        } else if (key === 'webhookForward'){
          const webhookForward = value
          Object.keys(value).forEach((k) => {
            if (!webhookForward[k]) {
              webhookForward[k] = (config as any)[key][k]
            }
          })
          configRedis[key] = webhookForward
        }
        logger.debug('Override env config by redis config in %s: %s => %s', phone, key, JSON.stringify(configRedis[key]))
        ;(config as any)[key] = configRedis[key]
      });
    }

    config.server = config.server || 'server_1'
    // Configs persisted before multi-provider support belong to Baileys. The
    // environment default is reserved for sessions that do not exist yet.
    config.provider = hasStoredConfig && !hasStoredProvider
      ? 'baileys'
      : resolveSessionProvider(config.provider)
    try {
      const fwd: any = (config as any).webhookForward || {}
      if (!`${fwd?.businessAccountId || ''}`.trim()) {
        fwd.businessAccountId = generateBusinessAccountId(phone, `${fwd?.phoneNumberId || phone}`)
        ;(config as any).webhookForward = fwd
        logger.info('Auto-generated businessAccountId for session %s', phone)
      }
      if (`${fwd?.businessAccountId || ''}`.trim()) {
        await setBusinessAccountIdMapping(phone, `${fwd.businessAccountId}`)
      }
    } catch {}
    // Enforce session-level storage flags when using Redis-backed config
    // Avoid sessions coming with useRedis/useS3=false due to stale values in unoapi-config
    config.useRedis = true
    config.useS3 = true

    const filter: MessageFilter = new MessageFilter(phone, config)
    config.shouldIgnoreJid = filter.isIgnoreJid.bind(filter)
    config.shouldIgnoreKey = filter.isIgnoreKey.bind(filter)
    if (config.useRedis) {
      config.getStore = getStoreRedis
    } else {
      config.getStore = getStoreFile
    }
    if (previousGetMessageMetadata) {
      config.getMessageMetadata = previousGetMessageMetadata
    }
    logger.info('Config redis: %s -> %s', phone, JSON.stringify(config))
    configs.set(phone, config)
    configCacheTs.set(phone, Date.now())
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return configs.get(phone)!
}
