import { getConfig, Config, configs } from './config'
import { getConfig as getConfigCache, setBusinessAccountIdMapping, subscribeConfigUpdates } from './redis'
import { getStoreRedis } from './store_redis'
import logger from './logger'
import { getConfigByEnv } from './config_by_env'
import { MessageFilter } from './message_filter'
import { CONFIG_CACHE_TTL_MS } from '../defaults'
import { generateBusinessAccountId } from './meta_ids'
import { resolveSessionProvider } from './providers/provider_resolver'
import { normalizeWebhookConfig } from './webhook_config'
import { normalizeHistoryMaxAgeDays } from '../utils/history'
import { configLogSummary } from './config_log_summary'
import { stores } from './store'
import { dataStores } from './data_store'
import { markSessionConfigRegistration } from './session_storage/connection_registration'
import { storageRoot } from './session_storage/capability'

const SECRET_CONFIG_KEY = /(token|password|secret|api.?key)/i
const configForLog = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(configForLog)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SECRET_CONFIG_KEY.test(key) && item ? '[REDACTED]' : configForLog(item),
  ]))
}

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
      stores.delete(phone)
      dataStores.delete(phone)
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
    // Only publish fully resolved Redis configurations. A cached ENV template
    // could otherwise bypass registration/provider/storage guards mid-await.
    const config: Config = { ...(await getConfigByEnv(phone, false)) }

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
          const webhooks = value.map((webhook: any) => normalizeWebhookConfig(webhook, config.webhooks[0]))
          configRedis[key] = webhooks
        } else if (key === 'webhookForward') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            logger.debug('Ignore invalid webhookForward redis config in %s: expected object', phone)
            return
          }
          configRedis[key] = {
            ...config.webhookForward,
            ...value,
          }
        }
        const valueForLog = SECRET_CONFIG_KEY.test(key) && configRedis[key]
          ? '[REDACTED]'
          : configForLog(configRedis[key])
        logger.debug('Override env config by redis config in %s: %s => %s', phone, key, JSON.stringify(valueForLog))
        ;(config as any)[key] = configRedis[key]
      });
    }

    config.server = config.server || 'server_1'
    config.historyMaxAgeDays = normalizeHistoryMaxAgeDays(config.historyMaxAgeDays)
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
    if (config.sessionStorage?.backend === 'sqlite' && !config.sessionStorage.fixture) config.baseStore = storageRoot()

    const filter: MessageFilter = new MessageFilter(phone, config)
    config.shouldIgnoreJid = filter.isIgnoreJid.bind(filter)
    config.shouldIgnoreKey = filter.isIgnoreKey.bind(filter)
    config.getStore = getStoreRedis
    if (config.sessionStorage?.fixture) {
      // Environment/default webhook expansion must never re-enable fixture delivery.
      config.autoConnect = false
      config.webhooks = []
      config.sessionWebhook = ''
      config.rejectCallsWebhook = ''
    }
    if (previousGetMessageMetadata) {
      config.getMessageMetadata = previousGetMessageMetadata
    }
    markSessionConfigRegistration(config, hasStoredConfig)
    logger.info('Config redis: %s summary=%s', phone, JSON.stringify(configLogSummary(config)))
    configs.set(phone, config)
    configCacheTs.set(phone, Date.now())
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return configs.get(phone)!
}
