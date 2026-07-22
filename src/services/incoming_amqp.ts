import { Incoming } from './incoming'
import { amqpPublish, amqpRpc } from '../amqp'
import { UNOAPI_EXCHANGE_BRIDGE_NAME, UNOAPI_QUEUE_INCOMING } from '../defaults'
import { v1 as uuid } from 'uuid'
import { jidToPhoneNumber, normalizeGroupId } from './transformer'
import { getConfig } from './config'
import { providerQueueName } from './providers/provider_queue'

type GroupManagementAction =
  | 'groupCreate'
  | 'groupUpdateSubject'
  | 'groupUpdateDescription'
  | 'groupUpdatePicture'
  | 'groupParticipantsUpdate'
  | 'groupInviteCode'
  | 'groupRevokeInvite'
  | 'groupRequestParticipantsList'
  | 'groupRequestParticipantsUpdate'
  | 'groupLeave'
  | 'groupSettingUpdate'
  | 'groupJoinApprovalMode'
  | 'groupMetadata'

export class IncomingAmqp implements Incoming {
  private getConfig: getConfig

  constructor(getConfig: getConfig) {
    this.getConfig = getConfig
  }

  private queue(config: Awaited<ReturnType<getConfig>>) {
    return providerQueueName(UNOAPI_QUEUE_INCOMING, config.server || 'server_1', config.provider)
  }

  private async groupManagementRpc<T>(phone: string, action: GroupManagementAction, args: unknown[] = []): Promise<T> {
    const config = await this.getConfig(phone)
    return amqpRpc<T>(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      this.queue(config),
      phone,
      {
        type: 'group_management',
        action,
        args,
      },
      {
        type: 'direct',
        priority: 5,
        maxRetries: 0,
      }
    )
  }

  public async contacts(phone: string, numbers: string[]) {
    const config = await this.getConfig(phone)
    return amqpRpc<any[]>(UNOAPI_EXCHANGE_BRIDGE_NAME, this.queue(config), phone, {
      type: 'provider_operation',
      action: 'contacts',
      args: [numbers],
    }, { type: 'direct', priority: 5, maxRetries: 0 })
  }

  public async requestPairingCode(phone: string) {
    const config = await this.getConfig(phone)
    return amqpRpc<string>(UNOAPI_EXCHANGE_BRIDGE_NAME, this.queue(config), phone, {
      type: 'provider_operation',
      action: 'requestPairingCode',
      args: [],
    }, { type: 'direct', priority: 5, maxRetries: 0 })
  }

  private async providerOperation<T>(phone: string, action: string, args: unknown[] = []): Promise<T> {
    const config = await this.getConfig(phone)
    return amqpRpc<T>(UNOAPI_EXCHANGE_BRIDGE_NAME, this.queue(config), phone, {
      type: 'provider_operation', action, args,
    }, { type: 'direct', priority: 5, maxRetries: 0 })
  }

  public resyncAppState(phone: string, forceSnapshot = true) {
    return this.providerOperation<void>(phone, 'resyncAppState', [forceSnapshot])
  }

  public fetchPrivacyTokens(phone: string, jids: string[], timeoutMs?: number) {
    return this.providerOperation<any>(phone, 'fetchPrivacyTokens', [jids, timeoutMs])
  }

  public fetchMessageHistory(phone: string, payload: object = {}) {
    return this.providerOperation<any>(phone, 'fetchMessageHistory', [payload])
  }

  public async send(phone: string, payload: object, options: object = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = payload as any
    const { status, type, to } = body
    const config = await this.getConfig(phone);
    if (status) {
      options['type'] = 'direct'
      options['priority'] = 3 // update status is always middle important
      await amqpPublish(
        UNOAPI_EXCHANGE_BRIDGE_NAME,
        this.queue(config),
        phone,
        { payload, options },
        options
      )
      return { ok: { success: true } }
    } else if (type) {
      const id = uuid()
      if (!options['priority']) {
        options['priority'] = 5 // send message without bulk is very important
      }
      options['type'] = 'direct'
      await amqpPublish(
        UNOAPI_EXCHANGE_BRIDGE_NAME,
        this.queue(config),
        phone,
        { payload, id, options }, 
        options
      )
      const isGroup = body?.recipient_type === 'group' || `${to || ''}`.trim().endsWith('@g.us')
      const target = isGroup ? normalizeGroupId(to) : `${to || ''}`
      const ok = {
        messaging_product: 'whatsapp',
        contacts: [
          {
            input: target,
            wa_id: isGroup ? target : jidToPhoneNumber(target, ''),
          },
        ],
        messages: [
          {
            id,
          },
        ],
      }
      return { ok }
    } else {
      throw `Unknown incoming message ${JSON.stringify(payload)}`
    }
  }

  public async recoverDelivery(phone: string, payload: object, options: object = {}) {
    const body = payload as any
    const config = await this.getConfig(phone)
    const id = `${body?.message_id || body?.messageId || body?.id || uuid()}`
    options['type'] = 'direct'
    options['priority'] = 5
    options['forceSessionRefresh'] = true
    options['forceDeliveryRecovery'] = true
    await amqpPublish(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      this.queue(config),
      phone,
      { payload, id, options, action: 'recover_delivery' },
      options
    )
    return {
      ok: {
        messaging_product: 'whatsapp',
        contacts: [
          {
            input: `${body?.to || ''}`,
            wa_id: jidToPhoneNumber(`${body?.to || ''}`, ''),
          },
        ],
        messages: [
          {
            id,
          },
        ],
        recovery: {
          queued: true,
        },
      },
    }
  }

  public async groupCreate(phone: string, subject: string, participants: string[]) {
    return this.groupManagementRpc<any>(phone, 'groupCreate', [subject, participants])
  }

  public async groupUpdateSubject(phone: string, jid: string, subject: string) {
    return this.groupManagementRpc<void>(phone, 'groupUpdateSubject', [jid, subject])
  }

  public async groupUpdateDescription(phone: string, jid: string, description?: string) {
    return this.groupManagementRpc<void>(phone, 'groupUpdateDescription', [jid, description])
  }

  public async groupUpdatePicture(phone: string, jid: string, pictureUrl: string) {
    return this.groupManagementRpc<void>(phone, 'groupUpdatePicture', [jid, pictureUrl])
  }

  public async groupParticipantsUpdate(phone: string, jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') {
    return this.groupManagementRpc<any[]>(phone, 'groupParticipantsUpdate', [jid, participants, action])
  }

  public async groupInviteCode(phone: string, jid: string) {
    return this.groupManagementRpc<string | undefined>(phone, 'groupInviteCode', [jid])
  }

  public async groupRevokeInvite(phone: string, jid: string) {
    return this.groupManagementRpc<string | undefined>(phone, 'groupRevokeInvite', [jid])
  }

  public async groupRequestParticipantsList(phone: string, jid: string) {
    return this.groupManagementRpc<any[]>(phone, 'groupRequestParticipantsList', [jid])
  }

  public async groupRequestParticipantsUpdate(phone: string, jid: string, participants: string[], action: 'approve' | 'reject') {
    return this.groupManagementRpc<any[]>(phone, 'groupRequestParticipantsUpdate', [jid, participants, action])
  }

  public async groupLeave(phone: string, jid: string) {
    return this.groupManagementRpc<void>(phone, 'groupLeave', [jid])
  }

  public async groupSettingUpdate(phone: string, jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') {
    return this.groupManagementRpc<void>(phone, 'groupSettingUpdate', [jid, setting])
  }

  public async groupJoinApprovalMode(phone: string, jid: string, mode: 'on' | 'off') {
    return this.groupManagementRpc<void>(phone, 'groupJoinApprovalMode', [jid, mode])
  }

  public async groupMetadata(phone: string, jid: string) {
    return this.groupManagementRpc<any>(phone, 'groupMetadata', [jid])
  }
}
