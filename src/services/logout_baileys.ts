import { Listener } from '../services/listener'
import { configs, getConfig } from '../services/config'
import { clients, getClient } from '../services/client'
import type { OnNewLogin } from '../services/login_types'
import { Logout } from './logout'
import logger from './logger'
import { stores } from './store'
import { dataStores } from './data_store'
import { mediaStores } from './media_store'
import { delConfig, delSessionStatus, delSessionTransientKeys, delZapoSessionRuntimeLease } from './redis'
import { resolveWhatsAppEngine } from './providers/provider_resolver'
import { clearZapoSession } from './zapo/zapo_session_cleanup'
import { zapoStoreRegistry, type ZapoStoreRegistry } from './zapo/zapo_store_registry'

export class LogoutBaileys implements Logout {
  private getClient: getClient
  private getConfig: getConfig
  private listener: Listener
  private onNewLogin: OnNewLogin

  constructor(
    getClient: getClient,
    getConfig: getConfig,
    listener: Listener,
    onNewLogin: OnNewLogin,
    private readonly zapoStores: ZapoStoreRegistry = zapoStoreRegistry,
  ) {
    this.getClient = getClient
    this.getConfig = getConfig
    this.listener = listener
    this.onNewLogin = onNewLogin
  }

  async run(phone: string) {
    const config = await this.getConfig(phone)
    if (config.mobilePrimaryDraftId) {
      // Generic logout jobs are never allowed to destroy a primary registration.
      logger.warn('Ignore destructive logout for mobile primary phone=%s; use integration suspension', phone)
      return
    }
    const provider = resolveWhatsAppEngine(config.provider)
    logger.debug('Logout provider session for phone %s (provider=%s)', phone, provider)
    const store = await config.getStore(phone, config)
    const { sessionStore, dataStore } = store
    const existingClient = clients.get(phone)
    const shouldForceLogout =
      !!existingClient ||
      await sessionStore.isStatusOnline(phone) ||
      await sessionStore.isStatusConnecting(phone) ||
      await sessionStore.isStatusRestartRequired(phone)

    if (shouldForceLogout) {
      try {
        const client = existingClient || await this.getClient({
          phone,
          listener: this.listener,
          getConfig: this.getConfig,
          onNewLogin: this.onNewLogin,
        })
        await client.logout()
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e))
        logger.warn(error, 'Ignore error while forcing %s logout for %s', provider, phone)
      }
    }
    if (provider === 'baileys') {
      await dataStore.cleanSession(true)
    } else {
      // Server logout is asynchronous and may not emit its final close event
      // before the socket disconnects. Always wipe the Zapo store locally so
      // deregistration cannot silently reconnect with stale credentials.
      const cleanup = await clearZapoSession(this.zapoStores.get(config).session(phone))
      for (const failure of cleanup.cacheFailures) {
        logger.warn(
          failure.error as any,
          'Ignore expiring Zapo cache cleanup failure for %s (%s)',
          phone,
          failure.domain,
        )
      }
      // Legacy DataStore owns Baileys auth and remains available for rollback.
      if (config.useRedis) {
        await delConfig(phone)
        await delSessionStatus(phone)
        await delSessionTransientKeys(phone)
        // Deregistration is an explicit destructive action. Dropping the lease
        // makes any orphaned worker lose ownership on its next renewal.
        await delZapoSessionRuntimeLease(phone)
      } else {
        await sessionStore.setStatus(phone, 'disconnected')
      }
    }
    clients.delete(phone)
    stores.delete(phone)
    dataStores.delete(phone)
    mediaStores.delete(phone)
    configs.delete(phone)
    if (config.useRedis && provider === 'baileys') {
      await delSessionStatus(phone)
    } else if (!config.useRedis && provider === 'baileys') {
      await sessionStore.setStatus(phone, 'disconnected')
    }
  }
}
