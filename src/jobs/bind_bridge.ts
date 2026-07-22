import { IncomingJob } from './incoming'
import { ListenerJob } from './listener'
import { Broadcast } from '../services/broadcast'
import {
  UNOAPI_QUEUE_INCOMING,
  UNOAPI_QUEUE_COMMANDER,
  UNOAPI_QUEUE_LISTENER,
  UNOAPI_SERVER_NAME,
  UNOAPI_EXCHANGE_BRIDGE_NAME,
  UNOAPI_WORKER_ENGINE,
} from '../defaults'
import { amqpConsume } from '../amqp'
import { getConfig } from '../services/config'
import { getConfigRedis } from '../services/config_redis'
import { getClientProvider } from '../services/providers/client_factory'
import { onNewLoginGenerateToken } from '../services/on_new_login_generate_token'
import { Outgoing } from '../services/outgoing'
import logger from '../services/logger'
import { Listener } from '../services/listener'
import { ProviderListener } from '../services/providers/listener_router'
import { OutgoingAmqp } from '../services/outgoing_amqp'
import { BroadcastAmqp } from '../services/broadcast_amqp'
import { addToBlacklistRedis, isInBlacklistInRedis } from '../services/blacklist'
import { ListenerAmqp } from '../services/listener_amqp'
import { OutgoingCloudApi } from '../services/outgoing_cloud_api'
import { IncomingProvider } from '../services/incoming_provider'
import { providerQueueName } from '../services/providers/provider_queue'
import { resolveWhatsAppEngine } from '../services/providers/provider_resolver'
import { WhatsAppEngine } from '../services/providers/provider_types'
import { shouldNotifyFailureByWhatsApp } from '../services/providers/failure_notification'

const getConfigLocal: getConfig = getConfigRedis
const outgoingAmqp: Outgoing = new OutgoingAmqp(getConfigLocal)
const listenerAmqp: Listener = new ListenerAmqp(resolveWhatsAppEngine(UNOAPI_WORKER_ENGINE))
const broadcastAmqp: Broadcast = new BroadcastAmqp()
const listenerBaileys: Listener = new ProviderListener(outgoingAmqp, broadcastAmqp, getConfigLocal)
const outgoingCloudApi: Outgoing = new OutgoingCloudApi(getConfigLocal, isInBlacklistInRedis, addToBlacklistRedis)
const onNewLogin = onNewLoginGenerateToken(outgoingCloudApi)
const incomingBaileys = new IncomingProvider(listenerAmqp, getConfigLocal, getClientProvider, onNewLogin)
const incomingJob = new IncomingJob(incomingBaileys, outgoingAmqp, getConfigLocal, UNOAPI_QUEUE_COMMANDER)
const listenerJob = new ListenerJob(listenerBaileys, outgoingCloudApi, getConfigLocal)

const processeds = new Map<string, boolean>()

export class BindBridgeJob {
  constructor(private readonly workerEngine: WhatsAppEngine = resolveWhatsAppEngine(UNOAPI_WORKER_ENGINE)) {}

  async consume(server: string, { routingKey }: { routingKey: string }) {
    const config = await getConfigLocal(routingKey)
    if (resolveWhatsAppEngine(config.provider) !== this.workerEngine) {
      logger.info(`Ignore connecting routingKey ${routingKey} provider ${config.provider} in ${this.workerEngine} worker...`)
      return
    }
    if (config.server !== UNOAPI_SERVER_NAME) {
      logger.info(`Ignore bing brigde ${routingKey} server ${config.server} is not server current server ${UNOAPI_SERVER_NAME}...`)
      return
    }
    const store = await config.getStore(routingKey, config)
    const { sessionStore } = store
    if (!(await sessionStore.isStatusOnline(routingKey)) && processeds.get(routingKey)) {
      return
    }
    processeds.set(routingKey, true)
    logger.info('Binding queues consumer bridge server %s routingKey %s', server, routingKey)

    const notifyFailedMessages = shouldNotifyFailureByWhatsApp(this.workerEngine, config.notifyFailedMessages)

    logger.info('Starting listener %s consumer %s', this.workerEngine, routingKey)
    await amqpConsume(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      providerQueueName(UNOAPI_QUEUE_LISTENER, UNOAPI_SERVER_NAME, this.workerEngine),
      routingKey,
      listenerJob.consume.bind(listenerJob),
      {
        notifyFailedMessages,
        priority: 5,
        prefetch: 1,
        type: 'direct'
      }
    )

    logger.info('Starting incoming consumer %s', routingKey)
    await amqpConsume(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      providerQueueName(UNOAPI_QUEUE_INCOMING, UNOAPI_SERVER_NAME, this.workerEngine),
      routingKey, 
      incomingJob.consume.bind(incomingJob), 
      {
        notifyFailedMessages,
        priority: 5,
        prefetch: 1 /* allways 1 */,
        type: 'direct'
      }
    )
  }
}
