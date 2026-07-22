import { eventType, Listener } from './listener'
import { PublishOption, amqpPublish } from '../amqp'
import { UNOAPI_EXCHANGE_BRIDGE_NAME, UNOAPI_QUEUE_LISTENER, UNOAPI_SERVER_NAME, UNOAPI_WORKER_ENGINE } from '../defaults'
import { providerQueueName } from './providers/provider_queue'
import { resolveWhatsAppEngine } from './providers/provider_resolver'
import type { WhatsAppEngine } from './providers/provider_types'
import { packWaMessage } from './wa_message_envelope'

const priorities = {
  'qrcode': 5,
  'status': 3,
  'history': 0,
  'append': 5,
  'notify': 5,
  'message': 5,
  'update': 3,
  'delete': 3,
}

const delay = new Map<string, number>()
const HISTORY_DELAY_TTL_MS = 5 * 60 * 1000

const pruneDelayMap = (now: number) => {
  for (const [key, ts] of delay) {
    if (now - ts > HISTORY_DELAY_TTL_MS) {
      delay.delete(key)
    }
  }
}

const delays = {
  'qrcode': _ => 0,
  'status': _ => 0,
  'history': (phone: string) => {
    pruneDelayMap(Date.now())
    const current = delay.get(phone)
    if (current) {
      delay.set(phone, current + 1000)
      return current
    } else {
      delay.set(phone, 1000)
      return 0
    }
  },
  'append': _ => 0,
  'notify': _ => 0,
  'message': _ => 0,
  'update': _ => 0,
  'delete': _ => 0,
}

export class ListenerAmqp implements Listener {
  constructor(private readonly workerEngine: WhatsAppEngine = resolveWhatsAppEngine(UNOAPI_WORKER_ENGINE)) {}

  public async process(phone: string, messages: object[], type: eventType) {
    const options: Partial<PublishOption> = {}
    options.priority = options.priority || priorities[type] || 5
    options.delay = options.delay || delays[type](phone) || 0
    options.type = 'direct'
    // Pack WAProto messages only for types that carry full WebMessageInfo
    const shouldPack = ['message', 'notify', 'qrcode', 'append', 'history'].includes(type as string)
    const packed = shouldPack
      ? messages.map(packWaMessage)
      : messages
    await amqpPublish(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      providerQueueName(UNOAPI_QUEUE_LISTENER, UNOAPI_SERVER_NAME, this.workerEngine),
      phone,
      { messages: packed, type }, 
      options
    )
  }
}
