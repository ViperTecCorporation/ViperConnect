import { Incoming } from './incoming'
import { Client, getClient, clients } from './client'
import { getConfig } from './config'
import { OnNewLogin } from './socket'
import logger from './logger'
import { Listener } from './listener'

export class IncomingProvider implements Incoming {
  private service: Listener
  private getClient: getClient
  private getConfig: getConfig
  private onNewLogin: OnNewLogin

  constructor(service: Listener, getConfig: getConfig, getClient: getClient, onNewLogin: OnNewLogin) {
    this.service = service
    this.getConfig = getConfig
    this.getClient = getClient
    this.onNewLogin = onNewLogin
  }

  public async send(phone: string, payload: object, options: object) {
    const client: Client = await this.getClient({
      phone,
      listener: this.service,
      getConfig: this.getConfig,
      onNewLogin: this.onNewLogin,
    })
    logger.debug('Retrieved client for %s', phone)
    return client.send(payload, options)
  }

  private async client(phone: string): Promise<Client> {
    return this.getClient({
      phone,
      listener: this.service,
      getConfig: this.getConfig,
      onNewLogin: this.onNewLogin,
    })
  }

  public async recoverDelivery(phone: string, payload: object, options: object) {
    const client = await this.client(phone)
    if (typeof client.recoverDelivery !== 'function') {
      throw new Error(`Client ${phone} does not support delivery recovery`)
    }
    return client.recoverDelivery(payload, options)
  }

  public async contacts(phone: string, numbers: string[]) {
    return (await this.client(phone)).contacts(numbers)
  }

  public async requestPairingCode(phone: string) {
    const client = await this.client(phone)
    if (typeof client.requestPairingCode !== 'function') {
      throw new Error(`Client ${phone} does not support direct pairing-code requests`)
    }
    return client.requestPairingCode()
  }

  public async resyncAppState(phone: string, forceSnapshot = true) {
    const client = await this.client(phone)
    if (typeof client.resyncAppState !== 'function') throw new Error(`Client ${phone} does not support app-state resync`)
    return client.resyncAppState(forceSnapshot)
  }

  public async fetchPrivacyTokens(phone: string, jids: string[], timeoutMs?: number) {
    const client = await this.client(phone)
    if (typeof client.fetchPrivacyTokens !== 'function') throw new Error(`Client ${phone} does not support privacy token fetch`)
    return client.fetchPrivacyTokens(jids, timeoutMs)
  }

  public async fetchMessageHistory(phone: string, payload: object = {}) {
    const client = await this.client(phone)
    if (typeof client.fetchMessageHistory !== 'function') throw new Error(`Client ${phone} does not support history sync`)
    return client.fetchMessageHistory(payload)
  }

  public async groupCreate(phone: string, subject: string, participants: string[]) {
    return (await this.client(phone)).groupCreate!(subject, participants)
  }

  public async groupUpdateSubject(phone: string, jid: string, subject: string) {
    return (await this.client(phone)).groupUpdateSubject!(jid, subject)
  }

  public async groupUpdateDescription(phone: string, jid: string, description?: string) {
    return (await this.client(phone)).groupUpdateDescription!(jid, description)
  }

  public async groupUpdatePicture(phone: string, jid: string, pictureUrl: string) {
    return (await this.client(phone)).groupUpdatePicture!(jid, pictureUrl)
  }

  public async groupParticipantsUpdate(phone: string, jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') {
    return (await this.client(phone)).groupParticipantsUpdate!(jid, participants, action)
  }

  public async groupInviteCode(phone: string, jid: string) {
    return (await this.client(phone)).groupInviteCode!(jid)
  }

  public async groupRevokeInvite(phone: string, jid: string) {
    return (await this.client(phone)).groupRevokeInvite!(jid)
  }

  public async groupRequestParticipantsList(phone: string, jid: string) {
    return (await this.client(phone)).groupRequestParticipantsList!(jid)
  }

  public async groupRequestParticipantsUpdate(phone: string, jid: string, participants: string[], action: 'approve' | 'reject') {
    return (await this.client(phone)).groupRequestParticipantsUpdate!(jid, participants, action)
  }

  public async groupLeave(phone: string, jid: string) {
    return (await this.client(phone)).groupLeave!(jid)
  }

  public async groupSettingUpdate(phone: string, jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') {
    return (await this.client(phone)).groupSettingUpdate!(jid, setting)
  }

  public async groupJoinApprovalMode(phone: string, jid: string, mode: 'on' | 'off') {
    return (await this.client(phone)).groupJoinApprovalMode!(jid, mode)
  }

  public async groupMetadata(phone: string, jid: string) {
    const client = clients.get(phone)
    if (!client || typeof client.groupMetadata !== 'function') {
      throw new Error(`Client ${phone} is not ready to fetch group metadata`)
    }
    return client.groupMetadata(jid)
  }
}

/** @deprecated Use IncomingProvider. Kept for public import compatibility. */
export class IncomingBaileys extends IncomingProvider {}
