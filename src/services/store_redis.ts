import { store, Store } from './store'
import { DataStore } from './data_store'
import { getDataStoreRedis } from './data_store_redis'
import { enrichJidMapFromAuthLidCache } from './redis'
import { getStore, stores } from './store'
import { getMediaStoreS3 } from './media_store_s3'
import { MediaStore } from './media_store'
import { Config } from './config'
import logger from './logger'
import { SessionStoreRedis } from './session_store_redis'
import { getMediaStoreFile } from './media_store_file'
import { BAILEYS_AUTH_POLICY } from './baileys_auth_policy'
import { resolveSessionProvider } from './providers/provider_resolver'
import type { ProviderAuthState } from './whatsapp_types'
import { isSqliteSession, isStorageWorker, storageOwner } from './session_storage/routing'
import { remoteSessionDataStore } from './session_storage/rpc'

const LEGACY_AUTH_STATE_MODULE = './auth_state.js'
const LEGACY_SESSION_REDIS_MODULE = './session_redis.js'

export const getStoreRedis: getStore = async (phone: string, config: Config): Promise<Store> => {
  if (!stores.has(phone)) {
    logger.debug('Creating redis store %s', phone)
    if (
      resolveSessionProvider(config.provider) !== 'zapo'
      && BAILEYS_AUTH_POLICY.jidMapEnrichOnStoreEnabled
    ) {
      const enrichmentTimer = setTimeout(() => {
        enrichJidMapFromAuthLidCache(phone).catch((error) => logger.debug(error as any, 'JIDMAP enrich on store failed for %s', phone))
      }, 1_000)
      enrichmentTimer.unref?.()
    }
    const fstore: Store = await storeRedis(phone, config)
    stores.set(phone, fstore)
  } else {
    logger.debug('Retrieving redis store %s', phone)
  }
  return stores.get(phone) as Store
}

const storeRedis: store = async (phone: string, config: Config): Promise<Store> => {
  logger.info(`Store session: ${phone}`)
  let state: ProviderAuthState = {}
  let saveCreds = async () => undefined
  if (resolveSessionProvider(config.provider) !== 'zapo') {
    const { authState } = module.require(LEGACY_AUTH_STATE_MODULE)
    const { sessionRedis } = module.require(LEGACY_SESSION_REDIS_MODULE)
    const legacy = await authState(sessionRedis, phone)
    state = legacy.state
    saveCreds = legacy.saveCreds
  }
  const dataStoreFactory = async (phone: string, config: Config) => {
    if (!isSqliteSession(config)) return getDataStoreRedis(phone, config)
    if (!isStorageWorker() || config.sessionStorage!.owner !== storageOwner()) return remoteSessionDataStore(phone, config)
    return (await import('./session_storage/data_store_sqlite.js')).getDataStoreSqlite(phone, config)
  }
  const dataStore: DataStore = await dataStoreFactory(phone, config)
  let mediaStore: MediaStore
  if (config.useS3) {
    mediaStore = getMediaStoreS3(phone, config, dataStoreFactory) as MediaStore
    logger.info(`Store media in s3`)
  } else {
    mediaStore = getMediaStoreFile(phone, config, dataStoreFactory) as MediaStore
    logger.info(`Store media in system file`)
  }
  logger.info(`Store data in redis`)
  const sessionStore = new SessionStoreRedis()
  return { state, saveCreds, dataStore, mediaStore, sessionStore }
}
