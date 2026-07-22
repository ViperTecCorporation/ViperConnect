import * as dotenv from 'dotenv'
dotenv.config()
import process from 'node:process'

import { BindBridgeJob } from './jobs/bind_bridge'
import { SessionStoreRedis } from './services/session_store_redis'
import { SessionStore } from './services/session_store'
import { autoConnect } from './services/auto_connect'
import { 
  UNOAPI_QUEUE_BIND,
  UNOAPI_QUEUE_RELOAD,
  UNOAPI_QUEUE_LOGOUT,
  UNOAPI_SERVER_NAME,
  UNOAPI_EXCHANGE_BRIDGE_NAME,
  UNOAPI_WORKER_ENGINE,
} from './defaults'
import { amqpConsume } from './amqp'
import { ensureRequiredRedis } from './services/redis_runtime'
import { getConfig } from './services/config'
import { getConfigRedis } from './services/config_redis'
import { getClientProvider } from './services/providers/client_factory'
import { onNewLoginGenerateToken } from './services/on_new_login_generate_token'
import logger from './services/logger'
import { Listener } from './services/listener'
import { ListenerAmqp } from './services/listener_amqp'
import { OutgoingAmqp } from './services/outgoing_amqp'
import { Outgoing } from './services/outgoing'
import { version } from '../package.json'
import { ReloadBaileys } from './services/reload_baileys'
import { LogoutBaileys } from './services/logout_baileys'
import { ReloadJob } from './jobs/reload'
import { LogoutJob } from './jobs/logout'
import { providerQueueName } from './services/providers/provider_queue'
import { resolveWhatsAppEngine } from './services/providers/provider_resolver'

const getConfigLocal: getConfig = getConfigRedis
const outgoingAmqp: Outgoing = new OutgoingAmqp(getConfigLocal)
const workerEngine = resolveWhatsAppEngine(UNOAPI_WORKER_ENGINE)
const listenerAmqp: Listener = new ListenerAmqp(workerEngine)
const onNewLogin = onNewLoginGenerateToken(outgoingAmqp)
const bindJob = new BindBridgeJob(workerEngine)
const reload = new ReloadBaileys(getClientProvider, getConfigLocal, listenerAmqp, onNewLogin, workerEngine)
const reloadJob = new ReloadJob(reload)
const logout = new LogoutBaileys(getClientProvider, getConfigLocal, listenerAmqp, onNewLogin)
const logoutJob = new LogoutJob(logout)

import * as Sentry from '@sentry/node'
import { isTransientBaileysError } from './services/error_utils'
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true,
  })
}

const startBrigde = async () => {
  await ensureRequiredRedis()

  logger.info('Unoapi Cloud version %s starting bridge...', version)

  logger.info('Starting bind consumer')
  await amqpConsume(
    UNOAPI_EXCHANGE_BRIDGE_NAME, 
    providerQueueName(UNOAPI_QUEUE_BIND, UNOAPI_SERVER_NAME, workerEngine),
    '',
    bindJob.consume.bind(bindJob),
    {
      prefetch: 1,
      type: 'direct'
    }
  )

  logger.info('Starting reload consumer')
  await amqpConsume(
    UNOAPI_EXCHANGE_BRIDGE_NAME, 
    providerQueueName(UNOAPI_QUEUE_RELOAD, UNOAPI_SERVER_NAME, workerEngine),
    '', 
    reloadJob.consume.bind(reloadJob),
    {
      prefetch: 1,
      type: 'direct'
    }
  )

  logger.info('Starting logout consumer')
  await amqpConsume(
    UNOAPI_EXCHANGE_BRIDGE_NAME,
    providerQueueName(UNOAPI_QUEUE_LOGOUT, UNOAPI_SERVER_NAME, workerEngine),
    '', 
    logoutJob.consume.bind(logoutJob),
    {
      prefetch: 1,
      type: 'direct'
    }
  )

  const sessionStore: SessionStore = new SessionStoreRedis()

  logger.info('Unoapi Cloud version %s started brige!', version)

  await autoConnect(sessionStore, listenerAmqp, getConfigRedis, getClientProvider, onNewLogin, workerEngine)
}
startBrigde().catch((error) => {
  logger.error(error, 'Failed to start bridge: Redis is required')
  process.exit(1)
})

process.on('uncaughtException', (reason: any) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason)
  }
  if (isTransientBaileysError(reason)) {
    logger.warn('uncaughtException bridge (ignored transient): %s', (reason && (reason.message || reason)))
    return
  }
  logger.error('uncaughtException bridge: %s %s', reason, (reason && reason.stack))
  process.exit(1)
})

process.on('unhandledRejection', (reason: any, promise) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason)
  }
  if (isTransientBaileysError(reason)) {
    logger.warn('unhandledRejection bridge (ignored transient): %s', (reason && (reason.message || reason)))
    return
  }
  logger.error('unhandledRejection: %s', (reason && reason.stack))
  logger.error('promise: %s', promise)
  process.exit(1)
})
