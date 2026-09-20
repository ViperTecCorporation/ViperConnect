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
import { buildRestrictionNoticeWebhooks } from '../services/restriction_notice'
import { isChatwootWebhook } from '../services/webhook_config'
import { buildProviderSendFailureResponse, shouldReturnProviderSendFailure } from '../services/providers/send_failure'
import { resolveWhatsAppEngine } from '../services/providers/provider_resolver'
import { loadReplyWarning, completeReplyWarning, replyWarningStatus } from '../services/reply_warning_outbox'
import { interactiveForChatwootWebhook, withOrderDetailsPixCopyButton } from '../services/transformer/interactive'
import { resolveProfilePictureId } from '../services/profile_picture_identity'
import { UNOAPI_MEDIA_PUBLIC_URL, UNOAPI_MEDIA_SOURCE, UNOAPI_MEDIA_STORAGE_KEY } from '../services/messages/outgoing_media_input'

import { outgoingEditWebhook } from '../services/messages/outgoing_edit_webhook'

type RetryContext = {
  countRetries: number
  maxRetries: number
}

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
      'groupProfilePicture',
    ]
    if (!allowedActions.includes(action)) {
      throw new Error(`Unknown group management action ${action}`)
    }
    const fn = this.incoming[action]
    if (typeof fn !== 'function') {
      throw new Error(`Incoming provider does not support group management action ${action}`)
    }
    try {
      return await fn.call(this.incoming, phone, ...args)
    } catch (error) {
      if (this.isGroupInviteNotAuthorized(action, error)) {
        const err = error as any
        logger.warn(
          {
            errorCode: err?.data || err?.statusCode || err?.output?.statusCode || err?.output?.payload?.statusCode,
            errorMessage: err?.message || err?.output?.payload?.message || 'not-authorized',
            phone,
            groupJid: args[0],
            action,
          },
          'Group invite code unavailable: not authorized',
        )
        return undefined
      }
      throw error
    }
  }

  private isGroupInviteNotAuthorized(action: string, error: unknown) {
    if (action !== 'groupInviteCode' && action !== 'groupRevokeInvite') return false
    const err = error as any
    const statusCode = err?.data || err?.statusCode || err?.output?.statusCode || err?.output?.payload?.statusCode
    const message = `${err?.message || err?.output?.payload?.message || ''}`.toLowerCase()
    return statusCode === 401 || message.includes('not-authorized') || message.includes('not authorized')
  }

  private async consumeProviderOperation(phone: string, data: any) {
    const allowedActions = ['contacts', 'saveContact', 'requestPairingCode', 'resyncAppState', 'fetchPrivacyTokens', 'fetchMessageHistory']
    if (!allowedActions.includes(data.action)) throw new Error(`Unknown provider operation ${data.action}`)
    const fn = this.incoming[data.action]
    if (typeof fn !== 'function') throw new Error(`Incoming provider does not support operation ${data.action}`)
    return fn.call(this.incoming, phone, ...(Array.isArray(data.args) ? data.args : []))
  }

  private buildOutgoingWebhookMessage(phone: string, payload: any, idUno: string, timestamp: string, messagePayload: any) {
    const isGroup = typeof payload?.to === 'string' && payload.to.endsWith('@g.us')
    const groupId = isGroup ? payload.to : undefined
    const contactWaId = isGroup ? phone.replace('+', '') : normalizeUserOrGroupIdForWebhook(payload?.to)
    const message: any = {
      from: phone.replace('+', ''),
      id: idUno,
      timestamp,
      [payload.type]: messagePayload,
      type: payload.type,
      ...outgoingEditWebhook(payload, timestamp),
    }
    if (groupId) message.group_id = groupId
    const userId =
      `${payload?.to_user_id || payload?.toUserId || payload?.user_id || payload?.contact?.user_id || payload?.from_user_id || ''}`.trim()
    if (userId) message.from_user_id = userId

    const contact: any = {
      wa_id: contactWaId,
      ...(groupId ? { group_id: groupId } : {}),
      profile: {
        name: `${payload?.contact?.name || payload?.profile?.name || contactWaId || ''}`,
      },
    }
    const profilePicture = `${payload?.contact?.picture || payload?.profile?.picture || ''}`.trim()
    if (profilePicture) {
      contact.profile.picture = profilePicture
      const pictureId = resolveProfilePictureId(
        payload?.contact?.picture_id,
        payload?.profile?.picture_id,
        payload?.profile_picture_id,
        userId,
        contactWaId,
      )
      if (pictureId) contact.profile.picture_id = pictureId
    }
    const profilePictureMetadata = payload?.contact?.picture_metadata || payload?.profile?.picture_metadata || payload?.profile_picture_metadata
    if (profilePictureMetadata) contact.profile.picture_metadata = profilePictureMetadata
    if (payload?.group_subject) contact.group_subject = `${payload.group_subject}`
    const groupPicture = `${payload?.group_picture || ''}`.trim()
    if (groupPicture) contact.group_picture = groupPicture
    if (payload?.group_picture_metadata) contact.group_picture_metadata = payload.group_picture_metadata
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

  private paymentTextForChatwootEcho(payload: any) {
    if (`${payload?.type || ''}` !== 'interactive') return undefined
    const action = payload?.interactive?.action || {}
    if (`${payload?.interactive?.type || ''}` === 'order_details' || action?.name === 'review_and_pay') return undefined
    const buttonSettings = (Array.isArray(action.buttons) ? action.buttons : []).flatMap((button: any) => {
      if (button?.payment_setting) return [button.payment_setting]
      if (Array.isArray(button?.payment_request?.payment_settings)) return button.payment_request.payment_settings
      return []
    })
    const settings = [
      ...(Array.isArray(action?.parameters?.payment_settings) ? action.parameters.payment_settings : []),
      ...buttonSettings,
    ]
    const paymentSetting = settings.find((setting: any) => ['pix_static_code', 'pix_dynamic_code'].includes(`${setting?.type || ''}`))
    if (!paymentSetting) return undefined
    const payment = paymentSetting[paymentSetting.type] || {}
    if (!payment.merchant_name || !payment.key_type || !payment.key) return undefined
    return `*${payment.merchant_name}*\nChave PIX tipo *${payment.key_type}*: ${payment.key}`
  }

  private buildChatwootOutgoingEchoMessage(phone: string, payload: any, idUno: string, timestamp: string, messagePayload: any) {
    const recipient = normalizeUserOrGroupIdForWebhook(payload?.to)
    const paymentText = this.paymentTextForChatwootEcho(payload)
    const type = paymentText ? 'text' : payload.type
    const content = paymentText ? { body: paymentText } : messagePayload
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
                message_echoes: [
                  {
                    from: phone.replace('+', ''),
                    to: recipient,
                    id: idUno,
                    timestamp,
                    [type]: content,
                    type,
                    ...outgoingEditWebhook(payload, timestamp),
                  },
                ],
              },
              field: 'smb_message_echoes',
            },
          ],
        },
      ],
    }
  }

  private async sendOutgoingMessageWebhooks(
    phone: string,
    webhooks: any[],
    payload: any,
    idUno: string,
    timestamp: string,
    messagePayload: any,
  ) {
    const webhookMessagePayload = `${payload?.type || ''}` === 'interactive'
      ? { ...messagePayload, action: withOrderDetailsPixCopyButton(messagePayload?.action) }
      : messagePayload
    const standardMessage = this.buildOutgoingWebhookMessage(phone, payload, idUno, timestamp, webhookMessagePayload)
    const chatwootMessagePayload = `${payload?.type || ''}` === 'interactive'
      ? interactiveForChatwootWebhook(messagePayload)
      : messagePayload
    const chatwootEcho = this.buildChatwootOutgoingEchoMessage(phone, payload, idUno, timestamp, chatwootMessagePayload)
    const enabled = webhooks.filter((webhook) => webhook.sendNewMessages)
    logger.debug('%s webhooks with sendNewMessages', enabled.length)
    await Promise.all(enabled.map((webhook) => this.outgoing.sendHttp(
      phone,
      webhook,
      isChatwootWebhook(webhook) ? chatwootEcho : standardMessage,
      {},
    )))
  }

  async consume(phone: string, data: object, retry?: RetryContext) {
    const config = await this.getConfig(phone)
    if (config.server !== UNOAPI_SERVER_NAME) {
      logger.info(`Ignore incoming with ${phone} server ${config.server} is not server current server ${UNOAPI_SERVER_NAME}...`)
      return
    }
    // e se for atualização, onde pega o id?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = { ...(data as any) }
    if (a.type === 'group_management') {
      return this.consumeGroupManagement(phone, a)
    }
    if (a.type === 'provider_operation') {
      return this.consumeProviderOperation(phone, a)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = a.payload
    const idUno: string = a.id || payload?.message_id || payload?.messageId || uuid()
    const options: object = { ...(a.options || {}), unoMessageId: idUno }
    const waId = normalizeUserOrGroupIdForWebhook(payload?.to || payload?.recipient_id || phone)
    const timestamp = Math.floor(new Date().getTime() / 1000).toString()
    const provider = resolveWhatsAppEngine(config.provider)
    const messageType = `${payload?.type || (payload?.status ? `status_${payload.status}` : 'unknown')}`
    // const retries: number = a.retries ? a.retries + 1 : 1
    // Status operations target an existing message by definition. Their
    // idempotency is handled by the provider adapter using the requested state.
    const isStatusOperation = !!payload?.status
    // Idempotency guard: skip a new send if this UNO id looks already processed.
    let alreadyProcessed = false
    let successfulSend = false
    let previousStatus: string | undefined
    try {
      if (config.outgoingIdempotency && !isStatusOperation) {
        const store = await config.getStore(phone, config)
        const existingKey = await store.dataStore.loadKey(idUno)
        const existingStatus = await store.dataStore.loadStatus(idUno)
        if (existingKey || existingStatus) {
          logger.info('Skip send (idempotent) for %s — already processed (key/status present)', idUno)
          alreadyProcessed = true
          previousStatus = existingStatus
          successfulSend = existingStatus !== 'failed' && (!!existingKey || ['sent', 'delivered', 'read', 'deleted'].includes(existingStatus || ''))
        }
      }
    } catch (e) {
      // For replies, inability to verify a previous send must not cause a resend
      // while its warning publication may still be pending.
      if (payload?.context && !isStatusOperation) throw e
      logger.warn(e as any, 'Ignore error checking outgoing idempotency')
    }
    if (alreadyProcessed) {
      // Outside the guard catch: failure to replay a warning must never resend to WhatsApp.
      if (successfulSend && payload?.context) {
        const pending = await loadReplyWarning(phone, idUno)
        if (pending) {
          const statusPayload = replyWarningStatus(phone, idUno, {
            ...pending, recipientId: normalizeUserOrGroupIdForWebhook(pending.recipientId),
          }, previousStatus)
          await amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_STATUS, phone,
            { payload: statusPayload, type: 'whatsapp' }, { type: 'topic' })
          await Promise.all(config.webhooks.map(w => this.outgoing.sendHttp(phone, w, statusPayload, { delay: 0 })))
          await completeReplyWarning(phone, idUno)
        }
      }
      return { ok: { success: true, idempotent: true } }
    }
    let response
    try {
      response = await this.incoming.send(phone, payload, options)
    } catch (error) {
      if (!shouldReturnProviderSendFailure(provider, error, retry)) throw error
      logger.warn(
        error as any,
        'Provider send failed permanently; emitting failed status provider=%s phone=%s id=%s type=%s',
        provider,
        phone,
        idUno,
        messageType,
      )
      response = buildProviderSendFailureResponse({
        phone,
        recipientId: waId,
        messageId: idUno,
        messageType,
        provider,
        timestamp,
        error,
      })
    }
    logger.debug('%s response %s -> %s', config.provider, phone, JSON.stringify(response))
    const channelNumber = phone.replace('+', '')
    logger.debug('Compare to enqueue to commander %s == %s', channelNumber, payload?.to)
    if (channelNumber == payload?.to) {
      logger.debug(`Enqueue in commmander...`)
      await amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, this.queueCommander, phone, { payload }, { type: 'topic' })
    }
    const { ok, error } = response
    const optionsOutgoing: Partial<PublishOption> = { delay: 0 } // evitar que 'sent' chegue após delivered/read
    const rankStatus = (s: string) => ({ failed: 0, progress: 1, pending: 1, sent: 2, delivered: 3, read: 4, deleted: 5 })[`${s}`] ?? -1
    if (ok && ok.messages && ok.messages[0] && ok.messages[0].id) {
      const returnedId: string = ok.messages[0].id
      const { dataStore } = await config.getStore(phone, config)
      const idProvider: string = `${(await dataStore.loadProviderId?.(returnedId)) || returnedId}`
      logger.debug('%s id %s to Unoapi id %s', config.provider, idProvider, idUno)
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
        const stagedStorageKey = `${payload?.[payload.type]?.[UNOAPI_MEDIA_STORAGE_KEY] || ''}`.trim()
        const stagedPublicUrl = `${payload?.[payload.type]?.[UNOAPI_MEDIA_PUBLIC_URL] || link}`.trim()
        if (stagedStorageKey) {
          messagePayload = {
            filename: payload[payload.type].filename,
            caption: payload[payload.type].caption,
            id: mediaKey,
            mime_type: mimetype,
            url: stagedPublicUrl,
          }
          await dataStore.setMediaPayload(idUno, messagePayload)
        } else if (link && link.trim()) {
          const response: Response = await fetch(link, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'GET' })
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
        if (messagePayload && typeof messagePayload === 'object') {
          delete messagePayload[UNOAPI_MEDIA_STORAGE_KEY]
          delete messagePayload[UNOAPI_MEDIA_SOURCE]
          delete messagePayload[UNOAPI_MEDIA_PUBLIC_URL]
          delete messagePayload.base64
        }
      }
      await this.sendOutgoingMessageWebhooks(phone, config.webhooks, payload, idUno, timestamp, messagePayload)
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
                { type: 'topic' },
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
    } else if (error) {
      logger.warn('Provider returned error response for %s without ok message id; emitting failed status', idUno)
    } else if (!ok?.success) {
      throw `Unknow response ${JSON.stringify(response)}`
    } else if (ok.success) {
      // Fallback: provedor não retornou id da mensagem, ainda assim notificar "new message" no webhook
      await this.sendOutgoingMessageWebhooks(phone, config.webhooks, payload, idUno, timestamp, payload[payload.type])
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
                      ...(ok?.warnings?.length ? { warnings: ok.warnings } : {}),
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
        if (rankStatus(prev || '') >= 3 && !ok?.warnings?.length) {
          logger.info("Skip 'sent' webhook for %s (prev status %s)", idUno, prev)
          outgingPayload = null as any
        }
        if (rankStatus(prev || '') >= 3 && ok?.warnings?.length) {
          outgingPayload.entry[0].changes[0].value.statuses[0].status = prev
        }
      } catch {}
    }
    if (outgingPayload) {
      await amqpPublish(
        UNOAPI_EXCHANGE_BROKER_NAME,
        UNOAPI_QUEUE_BULK_STATUS,
        phone,
        { payload: outgingPayload, type: 'whatsapp' },
        { type: 'topic' },
      )
      await Promise.all(config.webhooks.map((w) => this.outgoing.sendHttp(phone, w, outgingPayload, optionsOutgoing)))
      if (ok?.warnings?.length || (provider === 'zapo' && error && payload?.context)) await completeReplyWarning(phone, idUno)
      if (error) {
        try {
          const notices = buildRestrictionNoticeWebhooks({
            phone,
            payload,
            unoMessageId: idUno,
            statusPayload: outgingPayload,
            timestamp,
          })
          const webhooks = config.webhooks
          if (notices.length && webhooks.length) {
            logger.warn('Sending %s restriction notice webhook(s) for %s to %s webhook(s)', notices.length, idUno, webhooks.length)
            await Promise.all(notices.flatMap((notice) => webhooks.map((w) => this.outgoing.sendHttp(phone, w, notice, {}))))
          }
        } catch (e) {
          logger.warn(e as any, 'Failed to send restriction notice webhooks for %s', idUno)
        }
      }
    }
    return response
  }
}
