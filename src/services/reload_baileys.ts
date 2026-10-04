import { UNOAPI_SERVER_NAME } from '../defaults'
import { clients, getClient } from '../services/client'
import { getConfig, configs } from '../services/config'
import { Listener } from '../services/listener'
import type { OnNewLogin } from '../services/login_types'
import logger from './logger'
import { Reload } from './reload'
import { resolveWhatsAppEngine } from './providers/provider_resolver'
import { WhatsAppEngine } from './providers/provider_types'
import { BAILEYS_CONNECTION_POLICY } from './baileys_connection_policy'

export class ReloadBaileys extends Reload {
  private static readonly inFlightByPhone: Set<string> = new Set()
  private static readonly lastRunAtByPhone: Map<string, number> = new Map()
  private static readonly mobileTasks: Map<string, Promise<void>> = new Map()
  private getClient: getClient
  private getConfig: getConfig
  private listener: Listener
  private onNewLogin: OnNewLogin
  private workerEngine?: WhatsAppEngine

  constructor(getClient: getClient, getConfig: getConfig, listener: Listener, onNewLogin: OnNewLogin, workerEngine?: WhatsAppEngine) {
    super()
    this.getClient = getClient
    this.getConfig = getConfig
    this.listener = listener
    this.onNewLogin = onNewLogin
    this.workerEngine = workerEngine
  }

  async run(phone: string) {
    configs.delete(phone)
    const desired = await this.getConfig(phone)
    if (desired.mobilePrimaryDraftId) {
      // Serialize reconciliations, reading the latest desired state after waiting.
      // A queued old suspend must never log out a device resumed in the meantime.
      const previous = ReloadBaileys.mobileTasks.get(phone) || Promise.resolve()
      const task = previous.catch(() => undefined).then(() => this.reconcileMobile(phone))
      ReloadBaileys.mobileTasks.set(phone, task)
      try { await task } finally {
        if (ReloadBaileys.mobileTasks.get(phone) === task) ReloadBaileys.mobileTasks.delete(phone)
      }
      return
    }
    const now = Date.now()
    const lastRunAt = ReloadBaileys.lastRunAtByPhone.get(phone) || 0
    const debounceRemaining = Math.max(0, BAILEYS_CONNECTION_POLICY.reloadDebounceMs - (now - lastRunAt))
    if (ReloadBaileys.inFlightByPhone.has(phone) || debounceRemaining > 0) {
      logger.warn('Skip duplicated reload for %s (inFlight=%s debounceRemainingMs=%s)', phone, ReloadBaileys.inFlightByPhone.has(phone), debounceRemaining)
      return
    }
    ReloadBaileys.inFlightByPhone.add(phone)
    ReloadBaileys.lastRunAtByPhone.set(phone, now)
    try {
      logger.debug('Reload baileys run for phone %s', phone)
      const config = await this.getConfig(phone)
      if (this.workerEngine && resolveWhatsAppEngine(config.provider) !== this.workerEngine) {
        const currentClient = clients.get(phone)
        if (currentClient) {
          logger.info('Disconnect session %s from previous %s worker', phone, this.workerEngine)
          await currentClient.disconnect({ preserveStatus: true })
          clients.delete(phone)
        }
        return
      }
      if (config.server != UNOAPI_SERVER_NAME) {
        logger.debug('Reload broker for phone %s', phone)
        return super.run(phone)
      }
      const currentClient = await this.getClient({
        phone,
        listener: this.listener,
        getConfig: this.getConfig,
        onNewLogin: this.onNewLogin,
      })
      const store = await config.getStore(phone, config)
      const { sessionStore } = store
      const isConnecting = await sessionStore.isStatusConnecting(phone)
      const isRestartRequired = await sessionStore.isStatusRestartRequired(phone)
      const isZapo = resolveWhatsAppEngine(config.provider) === 'zapo'
      if (!isZapo && (isConnecting || isRestartRequired)) {
        logger.warn('Skip destructive reload for %s while status is transitional (connecting=%s restartRequired=%s)', phone, isConnecting, isRestartRequired)
        return
      }
      const isOnline = await sessionStore.isStatusOnline(phone)
      const isStandBy = await sessionStore.isStatusStandBy(phone)
      if (isZapo || isOnline || isStandBy) {
        logger.warn('Reload disconnect session %s!', phone)
        await currentClient.disconnect()
      }
      await super.run(phone)
      await this.getClient({
        phone,
        listener: this.listener,
        getConfig: this.getConfig,
        onNewLogin: this.onNewLogin,
      })
      logger.info('Reloaded session %s!', phone)
    } finally {
      ReloadBaileys.inFlightByPhone.delete(phone)
    }
  }

  private async reconcileMobile(phone: string) {
    configs.delete(phone)
    const config = await this.getConfig(phone)
    if (!config.mobilePrimaryDraftId || config.provider !== 'zapo' || (this.workerEngine && this.workerEngine !== 'zapo')) return
    if (config.server !== UNOAPI_SERVER_NAME) return
    const current = clients.get(phone)
    if (current) await current.disconnect()
    await super.run(phone)
    if (!config.autoConnect || config.mobilePrimaryDeleting) {
      const store = await config.getStore(phone, config)
      await store.sessionStore.setStatus(phone, 'offline')
      logger.info('Mobile primary suspended without logout phone=%s', phone)
      return
    }
    await this.getClient({ phone, listener: this.listener, getConfig: this.getConfig, onNewLogin: this.onNewLogin })
    logger.info('Mobile primary resume requested phone=%s', phone)
  }
}
