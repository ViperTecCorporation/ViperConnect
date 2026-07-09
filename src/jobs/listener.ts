import { amqpPublish } from '../amqp'
import { UNOAPI_EXCHANGE_BRIDGE_NAME, UNOAPI_QUEUE_LISTENER, UNOAPI_SERVER_NAME } from '../defaults'
import { Listener } from '../services/listener'
import logger from '../services/logger'
import { Outgoing } from '../services/outgoing'
import { DecryptError } from '../services/transformer'
import { getConfig } from '../services/config'
import { proto } from '@whiskeysockets/baileys'

const getUsernameMeta = (m: any): string | undefined => {
  const raw = `${m?.key?.participantUsername || m?.key?.remoteJidUsername || m?.key?.senderUsername || m?.participantUsername || m?.remoteJidUsername || m?.senderUsername || m?.contact?.username || m?.username || ''}`
    .replace(/^@/, '')
    .trim()
    .toLowerCase()
  return raw || undefined
}

const applyUsernameMeta = (m: any, username: string | undefined) => {
  const normalized = `${username || ''}`.replace(/^@/, '').trim().toLowerCase()
  if (!normalized || !m) return m
  if (!m.key) m.key = {}
  if (`${m.key?.remoteJid || ''}`.endsWith('@g.us')) {
    m.key.participantUsername = normalized
  } else {
    m.key.remoteJidUsername = normalized
    m.key.senderUsername = normalized
  }
  m.username = normalized
  m.contact = { ...(m.contact || {}), username: normalized }
  return m
}

export class ListenerJob {
  private listener: Listener
  private outgoing: Outgoing
  private getConfig: getConfig

  constructor(listener: Listener, outgoing: Outgoing, getConfig: getConfig) {
    this.listener = listener
    this.outgoing = outgoing
    this.getConfig = getConfig
  }

  async consume(phone: string, data: object, options?: { countRetries: number; maxRetries: number, priority: 0 }) {
    const config = await this.getConfig(phone)
    if (config.server !== UNOAPI_SERVER_NAME) {
      logger.info(`Ignore listener routing key ${phone} server ${config.server} is not server current server ${UNOAPI_SERVER_NAME}...`)
      return;
    }
    if (config.provider !== 'baileys') {
      logger.info(`Ignore listener routing key ${phone} is not provider baileys...`)
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = data as any
    const { messages, type } = a
    if (a.splited) {
      // Unpack base64-encoded WAProto messages
      try {
        a.messages = (a.messages || []).map((m: any) => {
          if (m && m.__wa_b64) {
            try {
              const bytes = Buffer.from(m.__wa_b64, 'base64')
              return applyUsernameMeta(proto.WebMessageInfo.decode(bytes), m.__unoapi_username)
            } catch {}
          }
          return m
        })
      } catch {}
      try {
        await this.listener.process(phone, a.messages, type)
      } catch (error) {
        if (error instanceof DecryptError && options && options?.countRetries >= options?.maxRetries) {
          // send message asking to open whatsapp to see
          await this.outgoing.send(phone, error.getContent())
        } else {
          throw error
        }
      }
    } else {
      if (type == 'delete' && messages.keys) {
        await Promise.all(
          messages.keys.map(async (m: object) => {
            return amqpPublish(
              UNOAPI_EXCHANGE_BRIDGE_NAME,
              `${UNOAPI_QUEUE_LISTENER}.${UNOAPI_SERVER_NAME}`,
              phone,
              { messages: { keys: [m] }, type, splited: true },
              { type: 'direct' }
            )
         })
        )
      } else {
        const shouldPack = ['message', 'notify', 'qrcode', 'append', 'history'].includes(type)
        await Promise.all(messages.
          map(async (m: any) => {
            // Pack WAProto messages as base64 only when appropriate
            let payloadMsg: any = m
            if (shouldPack) {
              try {
                if (m && (m.key || m.message)) {
                  const bytes = proto.WebMessageInfo.encode(m as any).finish()
                  const username = getUsernameMeta(m)
                  payloadMsg = {
                    __wa_b64: Buffer.from(bytes).toString('base64'),
                    ...(username ? { __unoapi_username: username } : {}),
                  }
                }
              } catch {}
            }
            return amqpPublish(
              UNOAPI_EXCHANGE_BRIDGE_NAME,
              `${UNOAPI_QUEUE_LISTENER}.${UNOAPI_SERVER_NAME}`,
              phone,
              { messages: [payloadMsg], type, splited: true },
              { type: 'direct' }
            )
          })
        )
      }
    }
  }
}
