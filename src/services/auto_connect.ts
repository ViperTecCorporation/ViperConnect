import { getClient, ConnectionInProgress } from './client'
import { getConfig } from './config'
import { SessionStore } from './session_store'
import { Listener } from './listener'
import { OnNewLogin } from './socket'
import logger from './logger'
import { AUTO_CONNECT_CONCURRENCY, UNOAPI_SERVER_NAME } from '../defaults'
import { resolveWhatsAppEngine } from './providers/provider_resolver'
import { WhatsAppEngine } from './providers/provider_types'

const runWithConcurrency = async <T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) => {
  let next = 0
  const totalWorkers = Math.min(Math.max(1, concurrency), items.length || 1)
  await Promise.all(Array.from({ length: totalWorkers }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await worker(item)
    }
  }))
}

export const autoConnect = async (
  sessionStore: SessionStore,
  listener: Listener,
  getConfig: getConfig,
  getClient: getClient,
  onNewLogin: OnNewLogin,
  workerEngine?: WhatsAppEngine,
) => {
  try {
    const phones = await sessionStore.getPhones()
    logger.info(`${phones.length} phones to verify if is auto connect`)
    const connectablePhones: string[] = []
    for (let i = 0, j = phones.length; i < j; i++) {
      const phone = phones[i]
      try {
        const config = await getConfig(phone)
        if (workerEngine && resolveWhatsAppEngine(config.provider) !== workerEngine) {
          continue
        }
        if (config.server && config.server !== UNOAPI_SERVER_NAME) {
          continue
        }
        await sessionStore.setStatus(phone, 'offline')
      } catch (error) {
        logger.warn(error, `Error on reset session status ${phone}`)
      }
    }
    for (let i = 0, j = phones.length; i < j; i++) {
      const phone = phones[i]
      try {
        const config = await getConfig(phone)
        if (workerEngine && resolveWhatsAppEngine(config.provider) !== workerEngine) {
          logger.info(`Ignore connecting phone ${phone} provider ${config.provider}...`)
          continue;
        }
        if (config.server && config.server !== UNOAPI_SERVER_NAME) {
          logger.info(`Ignore connecting phone ${phone} server ${config.server} is not server current server ${UNOAPI_SERVER_NAME}...`)
          continue;
        }
        await sessionStore.syncConnection(phone)
        if (await sessionStore.isStatusStandBy(phone)) {
          logger.info(`Session standby ${phone}...`)
          continue;
        }
        connectablePhones.push(phone)
      } catch (error) {
        logger.error(error, `Error on prepare auto connect phone ${phone}`)
      }
    }
    logger.info(`Auto connecting ${connectablePhones.length} phone(s) with concurrency ${AUTO_CONNECT_CONCURRENCY}`)
    await runWithConcurrency(connectablePhones, AUTO_CONNECT_CONCURRENCY, async (phone) => {
      try {
        logger.info(`Auto connecting phone ${phone}...`)
        try {
          await getClient({ phone, listener, getConfig, onNewLogin })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          if (e instanceof ConnectionInProgress) {
            logger.info(`Connection already in progress ${phone}...`)
          } else {
            throw e
          }
        }
        logger.info(`Auto connected phone ${phone}!`)
      } catch (error) {
        logger.error(error, `Error on connect phone ${phone}`)
      }
    })
  } catch (error) {
    logger.error(error, 'Erro on auto connect')
    throw error
  }
}
