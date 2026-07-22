import { Outgoing } from './services/outgoing'
import { CommanderJob } from './jobs/commander'
import { BulkStatusJob } from './jobs/bulk_status'
import { BulkWebhookJob } from './jobs/bulk_webhook'
import { BulkParserJob } from './jobs/bulk_parser'
import { BulkSenderJob } from './jobs/bulk_sender'
import { BulkReportJob } from './jobs/bulk_report'
import { OutgoingCloudApi } from './services/outgoing_cloud_api'
import {
  UNOAPI_QUEUE_BULK_PARSER,
  UNOAPI_QUEUE_BULK_SENDER,
  UNOAPI_QUEUE_COMMANDER,
  UNOAPI_QUEUE_BULK_STATUS,
  UNOAPI_QUEUE_BULK_REPORT,
  UNOAPI_QUEUE_BULK_WEBHOOK,
  UNOAPI_EXCHANGE_BROKER_NAME,
} from './defaults'
import { amqpConsume } from './amqp'
import { IncomingAmqp } from './services/incoming_amqp'
import { getConfig } from './services/config'
import { getConfigRedis } from './services/config_redis'
import { Incoming } from './services/incoming'
import logger from './services/logger'
import { addToBlacklistRedis, isInBlacklistInRedis } from './services/blacklist'
import { version } from '../package.json'
import { ensureRequiredRedis } from './services/redis_runtime'

import * as Sentry from '@sentry/node'
import { isTransientBaileysError } from './services/error_utils'
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true,
  })
}

const getConfigLocal: getConfig = getConfigRedis
const incomingAmqp: Incoming = new IncomingAmqp(getConfigLocal)


const outgoingCloudApi: Outgoing = new OutgoingCloudApi(getConfigLocal, isInBlacklistInRedis, addToBlacklistRedis)
const commanderJob = new CommanderJob(outgoingCloudApi, getConfigRedis)
const bulkParserJob = new BulkParserJob(outgoingCloudApi, getConfigRedis)
const bulkSenderJob = new BulkSenderJob(incomingAmqp, outgoingCloudApi)
const bulkStatusJob = new BulkStatusJob()
const bulkReportJob = new BulkReportJob(outgoingCloudApi, getConfigRedis)
const bulkWebhookJob = new BulkWebhookJob(outgoingCloudApi)

const startBulker = async () => {
  await ensureRequiredRedis()
  logger.info('Unoapi Cloud version %s starting bulker...', version)

  logger.info('Starting commander consumer')
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_COMMANDER, '*', commanderJob.consume.bind(commanderJob), { type: 'topic' })

  logger.info('Starting bulk parser consumer')
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_PARSER, '*', bulkParserJob.consume.bind(bulkParserJob), { type: 'topic' })

  logger.info('Starting bulk sender consumer')
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_SENDER, '*', bulkSenderJob.consume.bind(bulkSenderJob), { type: 'topic' })

  logger.info('Starting bulk status consumer')
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_STATUS, '*', bulkStatusJob.consume.bind(bulkStatusJob), { type: 'topic' })

  logger.info('Starting bulk report consumer')
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_REPORT, '*', bulkReportJob.consume.bind(bulkReportJob), { type: 'topic' })

  logger.info('Starting bulk webhook consumer')
  await amqpConsume(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_WEBHOOK, '*', bulkWebhookJob.consume.bind(bulkWebhookJob), { type: 'topic' })
}
startBulker().catch((error) => {
  logger.error(error, 'Failed to start bulker: Redis is required')
  process.exit(1)
})

process.on('uncaughtException', (reason: any) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason)
  }
  if (isTransientBaileysError(reason)) {
    logger.warn('uncaughtException bulker (ignored transient): %s', (reason && (reason.message || reason)))
    return
  }
  logger.error('uncaughtException bulker: %s %s', reason, (reason && reason.stack))
  process.exit(1)
})

process.on('unhandledRejection', (reason: any, promise) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason)
  }
  if (isTransientBaileysError(reason)) {
    logger.warn('unhandledRejection bulker (ignored transient): %s', (reason && (reason.message || reason)))
    return
  }
  logger.error('unhandledRejection: %s', (reason && reason.stack))
  logger.error('promise: %s', promise)
  process.exit(1)
})
