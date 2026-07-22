import { Listener } from '../services/listener'
import { configs, getConfig } from '../services/config'
import { clients, getClient } from '../services/client'
import { OnNewLogin } from '../services/socket'
import { Logout } from './logout'
import logger from './logger'
import { stores } from './store'
import { dataStores } from './data_store'
import { mediaStores } from './media_store'
import { delConfig, delSessionStatus, delSessionTransientKeys } from './redis'
import { resolveWhatsAppEngine } from './providers/provider_resolver'

export class LogoutBaileys implements Logout {
  private getClient: getClient
  private getConfig: getConfig
  private listener: Listener
  private onNewLogin: OnNewLogin

  constructor(getClient: getClient, getConfig: getConfig, listener: Listener, onNewLogin: OnNewLogin) {
    this.getClient = getClient
    this.getConfig = getConfig
    this.listener = listener
    this.onNewLogin = onNewLogin
  }

  async run(phone: string) {
    const config = await this.getConfig(phone)
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
      const client = existingClient || await this.getClient({
        phone,
        listener: this.listener,
        getConfig: this.getConfig,
        onNewLogin: this.onNewLogin,
      })
      try {
        await client.logout()
      } catch (e) {
        logger.warn(e as any, 'Ignore error while forcing %s logout for %s', provider, phone)
      }
    }
    if (provider === 'baileys') {
      await dataStore.cleanSession(true)
    } else if (config.useRedis) {
      // Zapo clears its own persistent store after the server confirms logout.
      // Do not call the legacy DataStore cleanup here: it owns Baileys auth and
      // would destroy the rollback credentials during a Zapo deregistration.
      await delConfig(phone)
      await delSessionStatus(phone)
      await delSessionTransientKeys(phone)
    } else {
      await sessionStore.setStatus(phone, 'disconnected')
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
