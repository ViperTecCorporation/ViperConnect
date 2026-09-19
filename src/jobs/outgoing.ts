import { Webhook } from '../services/config'
import { Outgoing } from '../services/outgoing'
import { amqpPublish } from '../amqp'
import {
  STATUS_FAILED_WEBHOOK_URL,
  UNOAPI_DELAY_AFTER_FIRST_MESSAGE_WEBHOOK_MS,
  UNOAPI_EXCHANGE_BROKER_NAME,
  UNOAPI_QUEUE_OUTGOING,
  UNOAPI_QUEUE_HISTORY_OUTGOING,
  UNOAPI_QUEUE_HISTORY_TRANSCRIBER,
  UNOAPI_QUEUE_TRANSCRIBER,
  UNOAPI_QUEUE_WEBHOOK_STATUS_FAILED
} from '../defaults'
import { extractDestinyPhone, isAudioMessage, isIncomingMessage, TYPE_MESSAGES_MEDIA, normalizeUserOrGroupIdForWebhook } from '../services/transformer'
import logger from '../services/logger'
import { getConfig } from '../services/config'
import { isUpdateMessage, isFailedStatus } from '../services/transformer'
import { getConfig as getRedisConfig } from '../services/redis'

const  dUntil: Map<string, number> = new Map()
const  dVerified: Map<string, number> = new Map()
const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const cleanDelayState = (now: number) => {
  for (const [key, ts] of dVerified) {
    if (now - ts > VERIFIED_TTL_MS) {
      dVerified.delete(key)
    }
  }
  for (const [key, next] of dUntil) {
    if (now - next > VERIFIED_TTL_MS) {
      dUntil.delete(key)
    }
  }
}

const delayFunc = UNOAPI_DELAY_AFTER_FIRST_MESSAGE_WEBHOOK_MS ? async (phone, payload) => {
  const to = extractDestinyPhone(payload, false)
 
  if (to) {
    const key = `${phone}:${to}`
    const now = Date.now()
    cleanDelayState(now)
    if (!dVerified.get(key)) {
      let nextMessageTime = dUntil.get(key)
      const epochMS: number = Math.floor(Date.now());
      if (nextMessageTime === undefined) {
        nextMessageTime = epochMS + UNOAPI_DELAY_AFTER_FIRST_MESSAGE_WEBHOOK_MS
        dUntil.set(key, nextMessageTime);
        logger.debug('Key %s First message', key)
      } else {
        const thisMessageDelay: number = Math.floor(nextMessageTime - epochMS)
        if (thisMessageDelay > 0) {
          logger.debug('Key %s Message delayed by %s ms', key, thisMessageDelay)
          await sleep(thisMessageDelay)
        } else {
          logger.debug('Key %s doesn\'t need more delays', key)
          dVerified.set(key, now);
          dUntil.delete(key);
        }
      } 
    }
  }
} :  async (_phone, _payload) => {}

export class OutgoingJob {
  private service: Outgoing
  private getConfig: getConfig

  constructor(getConfig: getConfig, service: Outgoing, private readonly queue = UNOAPI_QUEUE_OUTGOING) {
    this.service = service
    this.getConfig = getConfig
  }

  async consume(phone: string, data: object) {
    const persistedConfig = await getRedisConfig(phone)
    if (!persistedConfig) {
      logger.warn('Dropping outgoing job for %s because session config was not found in redis', phone)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = { ...data as any }
    const payload: any = a.payload
    if (a.webhooks) {
      const webhooks: Webhook[] = a.webhooks
      if (isFailedStatus(payload) && STATUS_FAILED_WEBHOOK_URL) {
        await amqpPublish(
          UNOAPI_EXCHANGE_BROKER_NAME,
          UNOAPI_QUEUE_WEBHOOK_STATUS_FAILED,
          phone,
          { payload }, 
          { type: 'topic' }
        )
      }
      await Promise.all(
        webhooks.map(async (webhook) => {
          return amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, this.queue, phone, { payload, webhook })
        }),
      )
      if (isAudioMessage(payload)) {
        const webhooks = a.webhooks.filter(w => {
          if (w.sendTranscribeAudio) {
            logger.debug('Session phone %s webhook %s configured to send transcribe audio message for this webhook', phone, w.id)
            return true
          }
        })
        if (webhooks.length > 0) {
          await amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME,
            this.queue === UNOAPI_QUEUE_HISTORY_OUTGOING ? UNOAPI_QUEUE_HISTORY_TRANSCRIBER : UNOAPI_QUEUE_TRANSCRIBER,
            phone, { payload, webhooks }, { type: 'topic' })
        }
      }
    } else if (a.webhook) {
      await delayFunc(phone, payload)
      const config = await this.getConfig(phone)
      if (config.provider == 'forwarder') {
        const store = await config.getStore(phone, config)
        payload.entry[0].changes[0].value.metadata.phone_number_id = phone
        const { dataStore } = store
        if (isUpdateMessage(payload)) {
          payload.entry[0].changes[0].value.statuses = await Promise.all(
            payload.entry[0].changes[0].value.statuses.map(async status => {
              const currentId = status.id
              const unoId = await dataStore.loadUnoId(currentId)
              if (unoId) {
                status.id = unoId
              }
              return status
            })
          )
        } else {
          payload.entry[0].changes[0].value.contacts = await Promise.all(
            payload.entry[0].changes[0].value.contacts.map(async contact => {
              contact.wa_id = normalizeUserOrGroupIdForWebhook(contact.wa_id)
              return contact
            })
          )
          const isIncoming = isIncomingMessage(payload)
          payload.entry[0].changes[0].value.messages = await Promise.all(
            payload.entry[0].changes[0].value.messages.map(async message => {
              if (TYPE_MESSAGES_MEDIA.includes(message.type) && isIncoming) {
                const { mediaStore } = store
                message = await mediaStore.saveMediaForwarder(message)
              }
              if (message.context && message.context.id) {
                const unoId = await dataStore.loadUnoId(message.context.id)
                if (unoId) {
                  message.context.id = unoId
                }
              }
              if (message.reaction && message.reaction.message_id) {
                const unoId = await dataStore.loadUnoId(message.reaction.message_id)
                if (unoId) {
                  message.reaction.id = unoId
                }
              }
              message.from = normalizeUserOrGroupIdForWebhook(message.from)
              return message
            })
          )
        }
      }
      await this.service.sendHttp(phone, a.webhook, payload, {})
    }
  }
}
