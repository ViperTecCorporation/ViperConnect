import { Incoming } from '../services/incoming'
import { Outgoing } from '../services/outgoing'
import { UNOAPI_QUEUE_COMMANDER, UNOAPI_QUEUE_BULK_STATUS, FETCH_TIMEOUT_MS, UNOAPI_SERVER_NAME, UNOAPI_EXCHANGE_BROKER_NAME } from '../defaults'
import { PublishOption, amqpPublish } from '../amqp'
import { getConfig } from '../services/config'
import { normalizeUserOrGroupIdForWebhook, getMimetype, toBuffer, TYPE_MESSAGES_MEDIA } from '../services/transformer'
import logger from '../services/logger'
import fetch, { Response } from 'node-fetch'
import mime from 'mime-types'
import { v1 as uuid } from 'uuid'

export class IncomingJob {
  private incoming: Incoming
  private outgoing: Outgoing
  private getConfig: getConfig
  private queueCommander: string

  constructor(incoming: Incoming, outgoing: Outgoing, getConfig: getConfig, queueCommander = UNOAPI_QUEUE_COMMANDER) {
    this.incoming = incoming
    this.outgoing = outgoing
    this.getConfig = getConfig
    this.queueCommander = queueCommander
  }

  private async consumeGroupManagement(phone: string, data: any) {
    const action = data.action
    const args = Array.isArray(data.args) ? data.args : []
    const allowedActions = [
      'groupCreate',
      'groupUpdateSubject',
      'groupUpdateDescription',
      'groupUpdatePicture',
      'groupParticipantsUpdate',
      'groupInviteCode',
      'groupRevokeInvite',
      'groupRequestParticipantsList',
      'groupRequestParticipantsUpdate',
      'groupLeave',
      'groupSettingUpdate',
      'groupJoinApprovalMode',
      'groupMetadata',
    ]
    if (!allowedActions.includes(action)) {
      throw new Error(`Unknown group management action ${action}`)
    }
    const fn = this.incoming[action]
    if (typeof fn !== 'function') {
      throw new Error(`Incoming provider does not support group management action ${action}`)
    }
    return fn.call(this.incoming, phone, ...args)
  }

  private buildOutgoingWebhookMessage(
    phone: string,
    payload: any,
    idUno: string,
    timestamp: string,
    messagePayload: any,
  ) {
    const isGroup = typeof payload?.to === 'string' && payload.to.endsWith('@g.us')
    const groupId = isGroup ? payload.to : undefined
    const contactWaId = isGroup ? phone.replace('+', '') : normalizeUserOrGroupIdForWebhook(payload?.to)
    const message: any = {
      from: phone.replace('+', ''),
      id: idUno,
      timestamp,
      [payload.type]: messagePayload,
      type: payload.type,
    }
    if (groupId) message.group_id = groupId
    const userId = `${payload?.from_user_id || payload?.user_id || payload?.contact?.user_id || ''}`.trim()
    if (userId) message.from_user_id = userId

    const contact: any = {
      wa_id: contactWaId,
      ...(groupId ? { group_id: groupId } : {}),
      profile: {
        name: `${payload?.contact?.name || payload?.profile?.name || contactWaId || ''}`,
      },
    }
    const profilePicture = `${payload?.contact?.picture || payload?.profile?.picture || ''}`.trim()
    if (profilePicture) contact.profile.picture = profilePicture
    if (payload?.group_subject) contact.group_subject = `${payload.group_subject}`
    const groupPicture = `${payload?.group_picture || ''}`.trim()
    if (groupPicture) contact.group_picture = groupPicture
    if (userId) contact.user_id = userId
    const username = `${payload?.username || payload?.contact?.username || payload?.profile?.username || ''}`.trim()
    if (username) contact.profile.username = username

    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phone,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: phone,
                  phone_number_id: phone,
                },
                contacts: [contact],
                messages: [message],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
  }

  async consume(phone: string, data: object) {
    const config = await this.getConfig(phone)
    if (config.server !== UNOAPI_SERVER_NAME) {
      logger.info(`Ignore incoming with ${phone} server ${config.server} is not server current server ${UNOAPI_SERVER_NAME}...`)
      return;
    }
    // e se for atualização, onde pega o id?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = { ...data as any }
    if (a.type === 'group_management') {
      return this.consumeGroupManagement(phone, a)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = a.payload
    const options: object = a.options
    const idUno: string = a.id || uuid()
    const waId = normalizeUserOrGroupIdForWebhook(payload.to)
    const timestamp = Math.floor(new Date().getTime() / 1000).toString()
    // const retries: number = a.retries ? a.retries + 1 : 1
    // Idempotency guard: skip send if this UNO id looks already processed
    try {
      if (config.outgoingIdempotency) {
        const store = await config.getStore(phone, config)
        const existingKey = await store.dataStore.loadKey(idUno)
        const existingStatus = await store.dataStore.loadStatus(idUno)
        if (existingKey || existingStatus) {
          logger.info('Skip send (idempotent) for %s — already processed (key/status present)', idUno)
          return { ok: { success: true, idempotent: true } }
        }
      }
    } catch (e) {
      logger.warn(e as any, 'Ignore error checking outgoing idempotency')
    }
    const response = await this.incoming.send(phone, payload, options)
    logger.debug('%s response %s -> %s', config.provider, phone, JSON.stringify(response))
    const channelNumber = phone.replace('+', '')
    logger.debug('Compare to enqueue to commander %s == %s', channelNumber, payload?.to)
    if (channelNumber == payload?.to) {
      logger.debug(`Enqueue in commmander...`)
      await amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, this.queueCommander, phone, { payload }, { type: 'topic' })
    }
    const { ok, error } = response
    const optionsOutgoing: Partial<PublishOption>  =  { delay: 0 } // evitar que 'sent' chegue após delivered/read
    const rankStatus = (s: string) => ({ failed:0, progress:1, pending:1, sent:2, delivered:3, read:4, deleted:5 }[`${s}`] ?? -1)
    if (ok && ok.messages && ok.messages[0] && ok.messages[0].id) {
      const idProvider: string = ok.messages[0].id
      logger.debug('%s id %s to Unoapi id %s', config.provider, idProvider, idUno)
      const { dataStore } = await config.getStore(phone, config)
      const prevProviderStatus = await dataStore.loadStatus(idProvider)
      const prevUnoStatus = await dataStore.loadStatus(idUno)
      await dataStore.setUnoId(idProvider, idUno)
      const key = await dataStore.loadKey(idProvider)
      if (key) {
        dataStore.setKey(idUno, key)
      }
      let messagePayload = payload[payload.type]
      if (TYPE_MESSAGES_MEDIA.includes(payload.type)) {
        const { mediaStore } = await config.getStore(phone, config)
        const mediaKey = `${phone}/${idUno}`
        const link = (payload?.[payload.type]?.link || '').toString()
        const mimetype = getMimetype(payload)
        const extension = mime.extension(mimetype)
        const fileName = `${mediaKey}.${extension}`
        if (link && link.trim()) {
          const response: Response = await fetch(link, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'GET'})
          const buffer = toBuffer(await response.arrayBuffer())
          await mediaStore.saveMediaBuffer(fileName, buffer)
          messagePayload = {
            filename: payload[payload.type].filename,
            caption: payload[payload.type].caption,
            id: mediaKey,
            mime_type: mimetype,
          }
          delete messagePayload['link']
          await dataStore.setMediaPayload(idUno, messagePayload)
        } else {
          logger.warn('Incoming media without link for %s type=%s; skipping media download/cache', idUno, payload.type)
        }
      }
      const webhookMessage = this.buildOutgoingWebhookMessage(phone, payload, idUno, timestamp, messagePayload)
      const webhooks = config.webhooks.filter((w) => w.sendNewMessages)
      logger.debug('%s webhooks with sendNewMessages', webhooks.length)
      await Promise.all(webhooks.map((w) => this.outgoing.sendHttp(phone, w, webhookMessage, {})))
      // Reconcile early status updates that arrived before UNO<->provider mapping
      try {
        if (prevProviderStatus && rankStatus(prevProviderStatus) > rankStatus(prevUnoStatus || '')) {
          const shouldReplay = prevProviderStatus === 'delivered' || prevProviderStatus === 'read'
          if (shouldReplay) {
            const buildStatusPayload = (status: string) => ({
              object: 'whatsapp_business_account',
              entry: [
                {
                  id: phone,
                  changes: [
                    {
                      value: {
                        messaging_product: 'whatsapp',
                        metadata: {
                          display_phone_number: phone,
                          phone_number_id: phone,
                        },
                        contacts: [
                          {
                            wa_id: waId,
                            profile: {
                              name: '',
                            },
                          },
                        ],
                        statuses: [
                          {
                            id: idUno,
                            recipient_id: waId,
                            status,
                            timestamp,
                          },
                        ],
                      },
                      field: 'messages',
                    },
                  ],
                },
              ],
            })
            const sendStatus = async (status: string) => {
              const statusPayload = buildStatusPayload(status)
              await amqpPublish(
                UNOAPI_EXCHANGE_BROKER_NAME,
                UNOAPI_QUEUE_BULK_STATUS,
                phone,
                { payload: statusPayload, type: 'whatsapp' },
                { type: 'topic' }
              )
              await Promise.all(config.webhooks.map((w) => this.outgoing.sendHttp(phone, w, statusPayload, optionsOutgoing)))
              await dataStore.setStatus(idUno, status as any)
            }
            if (prevProviderStatus === 'read' && rankStatus(prevUnoStatus || '') < rankStatus('delivered')) {
              await sendStatus('delivered')
            }
            await sendStatus(prevProviderStatus)
          }
        }
      } catch (e) {
        logger.warn(e as any, 'Ignore error reconciling status after id mapping')
      }
    } else if (!ok.success) {
      throw `Unknow response ${JSON.stringify(response)}`
    } else if (ok.success) {
      // Fallback: provedor não retornou id da mensagem, ainda assim notificar "new message" no webhook
      const webhookMessage = this.buildOutgoingWebhookMessage(phone, payload, idUno, timestamp, payload[payload.type])
      const webhooks = config.webhooks.filter((w) => w.sendNewMessages)
      logger.debug('%s webhooks with sendNewMessages (fallback)', webhooks.length)
      await Promise.all(webhooks.map((w) => this.outgoing.sendHttp(phone, w, webhookMessage, {})))
      logger.debug('Message id %s update to status %s (fallback notified)', payload?.message_id, payload?.status)
      // não retorna aqui; continua fluxo de status abaixo
    }
    let outgingPayload
    if (error) {
      if (idUno) {
        error.entry[0].changes[0].value.statuses[0].id = idUno
      }
      outgingPayload = error
      optionsOutgoing.priority = 1
      // const status = error.entry[0].changes[0].value.statuses[0]
      // const code = status?.errors[0]?.code
      // retry when error: 5 - Wait a moment, connecting process
      // if (retries < UNOAPI_MESSAGE_RETRY_LIMIT && ['5', 5].includes(code)) {
      //   await amqpPublish(UNOAPI_QUEUE_INCOMING, phone, { ...data, retries }, options)
      // }
    } else {
      outgingPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: phone,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: phone,
                    phone_number_id: phone,
                  },
                  contacts: [
                    {
                      wa_id: waId,
                      profile: {
                        name: '',
                      },
                    },
                  ],
                  statuses: [
                    {
                      id: idUno,
                      // Normalize recipient_id sempre como PN (sem '+')
                      recipient_id: waId,
                      status: 'sent',
                      timestamp,
                    },
                  ],
                },
                field: 'messages',
              },
            ],
          },
        ], 
      }
      // Se já houver status mais avançado (delivered/read), não enviar 'sent'
      try {
        const { dataStore } = await config.getStore(phone, config)
        const prev = await dataStore.loadStatus(idUno)
        if (rankStatus(prev || '') >= 3) {
          logger.info("Skip 'sent' webhook for %s (prev status %s)", idUno, prev)
          outgingPayload = null as any
        }
      } catch {}
    }
    if (outgingPayload) {
      await amqpPublish(
        UNOAPI_EXCHANGE_BROKER_NAME,
        UNOAPI_QUEUE_BULK_STATUS,
        phone,
        { payload: outgingPayload, type: 'whatsapp' },
        { type: 'topic' }
      )
      await Promise.all(config.webhooks.map((w) => this.outgoing.sendHttp(phone, w, outgingPayload, optionsOutgoing)))
    }
    return response
  }
}
