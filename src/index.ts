import dotenv from 'dotenv'
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' })

import { App } from './app'
import { IncomingProvider } from './services/incoming_provider'
import { Incoming } from './services/incoming'
import { Outgoing } from './services/outgoing'
import { OutgoingCloudApi } from './services/outgoing_cloud_api'
import { OutgoingAmqp } from './services/outgoing_amqp'
import { SessionStoreFile } from './services/session_store_file'
import { SessionStore } from './services/session_store'
import { autoConnect } from './services/auto_connect'
import { getConfigByEnv } from './services/config_by_env'
import { getClientProvider } from './services/providers/client_factory'
import { onNewLoginAlert } from './services/on_new_login_alert'
import ContactBaileys from './services/contact_baileys'
import { Broadcast } from './services/broadcast'
import { isInBlacklistInMemory, addToBlacklistInMemory, addToBlacklistRedis } from './services/blacklist'
import { version } from '../package.json'

import logger from './services/logger'
import { Listener } from './services/listener'
import { ProviderListener } from './services/providers/listener_router'

import {
  AMQP_URL,
  BASE_URL,
  NOTIFY_FAILED_MESSAGES,
  PORT,
  UNOAPI_EXCHANGE_BROKER_NAME,
  UNOAPI_QUEUE_OUTGOING,
  UNOAPI_QUEUE_OUTGOING_PREFETCH,
  WEBHOOK_ASYNC_MODE
} from './defaults'
import { ReloadBaileys } from './services/reload_baileys'
import { LogoutBaileys } from './services/logout_baileys'
import { amqpConnect, amqpConsume } from './amqp'
import { OutgoingJob } from './jobs/outgoing'
import { startContactSyncScheduler } from './jobs/contact_sync'

import * as Sentry from '@sentry/node'
import { isTransientBaileysError } from './services/error_utils'
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true,
  })
}

const outgoingCloudApi: Outgoing = new OutgoingCloudApi(getConfigByEnv, isInBlacklistInMemory, addToBlacklistRedis)
let outgoing: Outgoing = outgoingCloudApi

const webhookAsyncAmqp = WEBHOOK_ASYNC_MODE === 'amqp'
if (webhookAsyncAmqp) {
  const amqpUrl = process.env.AMQP_URL || ''
  if (!amqpUrl) {
    logger.warn('WEBHOOK_ASYNC_MODE=amqp set but AMQP_URL is not configured; falling back to direct webhooks')
  } else {
    outgoing = new OutgoingAmqp(getConfigByEnv)
    amqpConnect(AMQP_URL).catch((error) => {
      logger.error(error, 'Erro on start rabbitmq for webhook async mode')
      process.exit(1)
    })
    const notifyFailedMessages = NOTIFY_FAILED_MESSAGES
    const prefetch = UNOAPI_QUEUE_OUTGOING_PREFETCH
    const outgoingJob = new OutgoingJob(getConfigByEnv, outgoingCloudApi)
    amqpConsume(
      UNOAPI_EXCHANGE_BROKER_NAME,
      UNOAPI_QUEUE_OUTGOING,
      '*',
      outgoingJob.consume.bind(outgoingJob),
      { notifyFailedMessages, prefetch, type: 'topic' }
    )
  }
}

const broadcast: Broadcast = new Broadcast()
const listenerBaileys: Listener = new ProviderListener(outgoing, broadcast, getConfigByEnv)
const onNewLoginn = onNewLoginAlert(listenerBaileys)
const incomingBaileys: Incoming = new IncomingProvider(listenerBaileys, getConfigByEnv, getClientProvider, onNewLoginn)
const sessionStore: SessionStore = new SessionStoreFile()
const contact = new ContactBaileys(listenerBaileys, getConfigByEnv, getClientProvider, onNewLoginn)

const reload = new ReloadBaileys(getClientProvider, getConfigByEnv, listenerBaileys, onNewLoginn)
const logout = new LogoutBaileys(getClientProvider, getConfigByEnv, listenerBaileys, onNewLoginn)

const app: App = new App(incomingBaileys, outgoing, BASE_URL, getConfigByEnv, sessionStore, onNewLoginn, addToBlacklistInMemory, reload, logout, undefined, undefined, contact)
broadcast.setSever(app.socket)

app.server.listen(PORT, '0.0.0.0', async () => {
  logger.info('Unoapi Cloud version: %s, listening on port: %s', version, PORT)
  autoConnect(sessionStore, listenerBaileys, getConfigByEnv, getClientProvider, onNewLoginn)
  startContactSyncScheduler(outgoing)
})

export default app

process.on('uncaughtException', (reason: any) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason)
  }
  // Ignore transient Baileys/libsignal socket errors that are expected to recover
  if (isTransientBaileysError(reason)) {
    logger.warn('uncaughtException (ignored transient): %s', (reason && (reason.message || reason)))
    return
  }
  logger.error('uncaughtException index: %s %s', reason, (reason && reason.stack))
  process.exit(1)
})

process.on('unhandledRejection', (reason: any, promise) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason)
  }
  // Ignore transient Baileys/libsignal socket errors that are expected to recover
  if (isTransientBaileysError(reason)) {
    logger.warn('unhandledRejection (ignored transient): %s', (reason && (reason.message || reason)))
    return
  }
  logger.error('unhandledRejection: %s', (reason && reason.stack))
  logger.error('promise: %s', promise)
  process.exit(1)
})
