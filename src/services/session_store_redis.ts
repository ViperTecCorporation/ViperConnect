import { SessionStore, sessionStatus } from './session_store'
import { configKey, authKey, redisKeys, getSessionStatus, setSessionStatus, sessionStatusKey, redisGet, getConnectCount, setConnectCount, delAuth, clearConnectCount, getAllAuthTokens, addAuthTokensToIndex, getAuthKeyCount } from './redis'
import logger from './logger'
import { MAX_CONNECT_RETRY, MAX_CONNECT_TIME } from '../defaults'

const toReplaceConfig = configKey('')
const toReplaceStatus = sessionStatusKey('')

export class SessionStoreRedis extends SessionStore {
  async getPhones(): Promise<string[]> {
    try {
      const pattern = configKey('*')
      const keys = await redisKeys(pattern)
      return keys
        .map((key: string) => key.replace(toReplaceConfig, ''))
        .filter((phone: string) => phone !== 'auth-token-index')
    } catch (error) {
      logger.error(error, 'Erro on get phones')
      throw error
    }
  }

  async getTokens(phone: string): Promise<string[]> {
    try {
      if (phone.includes('*')) {
        const tokens = await getAllAuthTokens()
        if (tokens && tokens.length > 0) return tokens
        const pattern = configKey(phone)
        const keys = await redisKeys(pattern)
        const found = await Promise.all(keys.map(async (k: string) => JSON.parse(await redisGet(k) || '{}')?.authToken))
        try { await addAuthTokensToIndex(found.filter((t) => !!t)) } catch {}
        return found
      }
      const config = await redisGet(configKey(phone))
      if (!config) return []
      const token = JSON.parse(config)?.authToken
      if (token) {
        try { await addAuthTokensToIndex([token]) } catch {}
        return [token]
      }
      return []
    } catch (error) {
      logger.error(error, 'Erro on get tokens')
      throw error
    }
  }

  async getStatus(phone: string) {
    return await getSessionStatus(phone) || 'disconnected'
  }

  async setStatus(phone: string, status: sessionStatus) {
    logger.info(`Session status ${phone} change from ${await this.getStatus(phone)} to ${status}`)
    if (['online', 'restart_required'].includes(status)) {
      await this.clearConnectCount(phone)
    }
    return setSessionStatus(phone, status)
  }

  async getConnectCount(phone: string) {
    return getConnectCount(phone)
  }

  async setConnectCount(phone: string, count) {
    await setConnectCount(phone, count, MAX_CONNECT_TIME)
  }

  async clearConnectCount(phone: string) {
    logger.info('Cleaning count connect for %s..', phone)
    await clearConnectCount(phone)
    logger.info('Cleaned count connect for %s!', phone)
  }

  async syncConnections() {
    logger.info(`Syncing lost and standby connections...`)
    try {
      const pattern = sessionStatusKey('*')
      const keys = await redisKeys(pattern)
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const phone = key.replace(toReplaceStatus, '')
        await this.syncConnection(phone)
      }
      logger.info(`Synced lost and standby connections!`)
    } catch (error) {
      logger.error(error, 'Error on sync lost connecting')
      throw error
    }
  }

  async syncConnection(phone: string) {
    logger.info(`Syncing ${phone} lost connection`)
    const currentStatus = await this.getStatus(phone)
    if (['restart_required', 'connecting', 'online'].includes(currentStatus)) {
      logger.info(`Is not lost connection, status is ${currentStatus} for ${phone}`)
      return
    }
    const authCount = await getAuthKeyCount(phone)
    logger.info(`Found auth ${authCount.exact ? '' : 'at least '}${authCount.count} keys for session ${phone}`)
    if (authCount.exact && authCount.count == 1 && await redisGet(authKey(`${phone}:creds`))) {
      await delAuth(phone)
      await this.setStatus(phone, 'disconnected')
    }
    if (await getSessionStatus(phone) == 'standby' && await this.getConnectCount(phone) < MAX_CONNECT_RETRY) {
      logger.info(`Sync ${phone} standby!`)
      await this.setStatus(phone, 'offline')
    }
  }
}
