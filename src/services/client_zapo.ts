/* eslint-disable @typescript-eslint/no-explicit-any */
import QRCode from 'qrcode'
import { WaClient as ZapoWaClient, createNoopLogger, type WaClient as WaClientType, type WaStoreSession } from 'zapo-js'
import { voipPlugin, type CallInfo } from '@zapo-js/voip'
import { createMediaProcessor } from '@zapo-js/media-utils'
import { v1 as uuid } from 'uuid'
import type { Client, Contact } from './client'
import { clients } from './client'
import type { Config, getConfig } from './config'
import { configs, defaultConfig } from './config'
import type { Listener } from './listener'
import logger from './logger'
import type { OnNewLogin } from './socket'
import type { Store } from './store'
import { SendError } from './send_error'
import { ensureZapoSessionMigration } from './zapo/zapo_migration'
import { zapoStoreRegistry, type ZapoStoreRegistry } from './zapo/zapo_store_registry'
import { ZapoGroups } from './zapo/zapo_groups'
import { ZapoMessages } from './zapo/zapo_messages'
import { toUnoAddonEvent, toUnoMessageEvent, toUnoReceiptUpdates } from './zapo/zapo_events'
import { statusRecipients } from './status/status_recipients'
import { zapoUsernameIndex } from './zapo/zapo_username_index'
import { phoneNumberToJid } from './transformer/jid'
import { Template } from './template'
import {
  PASSKEY_BRIDGE_TTL_SECONDS,
  ZAPO_REDIS_MAINTENANCE_INTERVAL_MS,
  ZAPO_SESSION_LEASE_RENEW_MS,
  ZAPO_SESSION_LEASE_TTL_MS,
} from '../defaults'
import { createPasskeyBridgeSession, updatePasskeyBridgeSession } from './passkey_bridge'
import { RedisLease } from './redis_lease'
import { zapoRedisMaintenance, type ZapoRedisMaintenance } from './zapo/zapo_redis_maintenance'

type VoipCoordinator = ReturnType<ReturnType<typeof voipPlugin>['setup']>
type ZapoClient = WaClientType & {
  voip: VoipCoordinator
  on(event: 'voip_call_incoming', listener: (call: CallInfo) => void): ZapoClient
}
type ClientFactory = (options: ConstructorParameters<typeof ZapoWaClient>[0]) => ZapoClient
type LeaseFactory = (phone: string) => RedisLease

const defaultClientFactory: ClientFactory = (options) => new ZapoWaClient(options, createNoopLogger('info')) as ZapoClient
const zapoMediaProcessor = createMediaProcessor()
const mediaMessageKeys = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'] as const

export class ClientZapo implements Client {
  private config: Config = defaultConfig
  private unoStore?: Store
  private zapoSession?: WaStoreSession
  private socket?: ZapoClient
  private messages?: ZapoMessages
  private groups?: ZapoGroups
  private connectTask?: Promise<void>
  private readonly pendingIncoming = new Map<string, any>()
  private intentionalDisconnect = false
  private lease?: RedisLease
  private leaseRenewTimer?: NodeJS.Timeout
  private maintenanceTimer?: NodeJS.Timeout
  private pendingPasskey?: {
    bridgeId: string
    resolve: (value: { credentialId: Uint8Array; webauthnAssertion: Uint8Array }) => void
    reject: (error: Error) => void
  }

  constructor(
    private readonly phone: string,
    private readonly listener: Listener,
    private readonly getConfig: getConfig,
    private readonly onNewLogin: OnNewLogin,
    private readonly storeRegistry: ZapoStoreRegistry = zapoStoreRegistry,
    private readonly clientFactory: ClientFactory = defaultClientFactory,
    private readonly leaseFactory: LeaseFactory = (session) => new RedisLease(
      `zapo-session:${session}`,
      ZAPO_SESSION_LEASE_TTL_MS,
    ),
    private readonly maintenance: ZapoRedisMaintenance = zapoRedisMaintenance,
  ) {}

  private async emitQr(value: string) {
    const imageUrl = await QRCode.toDataURL(value)
    await this.listener.process(this.phone, [{
      key: { fromMe: true, remoteJid: `${this.phone.replace(/\D/g, '')}@s.whatsapp.net`, id: uuid() },
      message: { imageMessage: { url: imageUrl, mimetype: 'image/png', caption: 'Zapo pairing' } },
    }], 'qrcode')
  }

  private async syncGroupCache(client: ZapoClient, groupJid?: string) {
    if (!this.unoStore) return
    const groups = groupJid
      ? [await client.group.queryGroupMetadata(groupJid)]
      : [...await client.group.queryAllGroups()]
    await Promise.all(groups.map((group: any) => {
      const jid = `${group?.id || group?.jid || group?.groupJid || ''}`
      return jid ? this.unoStore!.dataStore.setGroupMetada(jid, group) : Promise.resolve()
    }))
  }

  private bindEvents(client: ZapoClient, resolvePrompt: () => void) {
    client.on('auth_qr', ({ qr }) => {
      resolvePrompt()
      void this.emitQr(qr)
    })
    client.on('auth_pairing_required', () => {
      resolvePrompt()
      if (this.config.connectionType !== 'pairing_code') return
      void client.auth.requestPairingCode(this.phone.replace(/\D/g, '')).then((code) => this.emitQr(code))
    })
    client.on('auth_pairing_code', ({ code }) => {
      resolvePrompt()
      void this.emitQr(code)
    })
    client.on('auth_passkey_required', ({ hasSigner }) => {
      void this.listener.process(this.phone, [{
        key: { fromMe: true, remoteJid: `${this.phone.replace(/\D/g, '')}@s.whatsapp.net`, id: uuid() },
        message: { conversation: hasSigner ? 'zapo_passkey_signer_ready' : 'zapo_passkey_signer_required' },
      }], 'status')
    })
    client.on('connection', (event) => {
      if (event.status === 'open') {
        void this.unoStore?.sessionStore.setStatus(this.phone, 'online')
        void this.syncGroupCache(client).catch((error) => logger.warn(error as any, 'Zapo group cache sync failed for %s', this.phone))
        if (event.isNewLogin) void this.onNewLogin(this.phone)
        return
      }
      void this.unoStore?.sessionStore.setStatus(this.phone, event.isLogout ? 'disconnected' : 'offline')
      if (!event.isLogout && !this.intentionalDisconnect) this.scheduleReconnect()
    })
    client.on('message', async (event) => {
      const message = toUnoMessageEvent(event)
      if (message.key.id) this.pendingIncoming.set(message.key.id, event)
      if (!event.key.fromMe && !event.key.isNewsletter) {
        const recipientAliases = [event.key.participantAlt, event.key.participant, event.key.remoteJidAlt, event.key.remoteJid]
          .map((jid) => `${jid || ''}`)
          .filter((jid) => jid.endsWith('@s.whatsapp.net'))
        if (recipientAliases.length) {
          void statusRecipients.touch(this.phone, recipientAliases).catch((error) => {
            logger.warn(error as any, 'Zapo status recipient index update failed for %s', this.phone)
          })
        }
        const senderLid = [event.key.participant, event.key.remoteJid]
          .map((jid) => `${jid || ''}`)
          .find((jid) => jid.endsWith('@lid'))
        if (event.key.senderUsername && senderLid) {
          void zapoUsernameIndex.touch(this.phone, event.key.senderUsername, senderLid)
        }
      }
      if (message.key.remoteJid && message.key.id) {
        await this.unoStore?.dataStore.setKey(message.key.id, message.key as never)
        await this.unoStore?.dataStore.setMessage(message.key.remoteJid, message as never)
      }
      try {
        await this.listener.process(this.phone, [message], 'notify')
      } finally {
        if (message.key.id) this.pendingIncoming.delete(message.key.id)
      }
      if (this.config.readOnReceipt && !message.key.fromMe) {
        await client.message.sendReceipt(event, { type: 'read' })
      }
    })
    client.on('message_send', async (event) => {
      if (!event.id) return
      const remoteJid = event.to
      const message = { key: { remoteJid, id: event.id, fromMe: true }, message: event.message }
      await this.unoStore?.dataStore.setKey(event.id, message.key as never)
      await this.unoStore?.dataStore.setMessage(remoteJid, message as never)
    })
    client.on('receipt', async (event) => {
      const contact = event.chatJid && this.zapoSession
        ? await this.zapoSession.contacts.getByJid(event.chatJid)
        : undefined
      const phoneJid = contact?.phoneNumber
        ? `${`${contact.phoneNumber}`.split('@')[0]}@s.whatsapp.net`
        : undefined
      const updates = toUnoReceiptUpdates(event, phoneJid)
      if (updates.length) await this.listener.process(this.phone, updates, 'update')
    })
    client.on('message_addon', async (event) => {
      await this.listener.process(this.phone, [toUnoAddonEvent(event)], 'notify')
    })
    client.on('message_unavailable', (event) => {
      logger.warn('Zapo unavailable message phone=%s id=%s kind=%s', this.phone, event.key.id, event.kind)
    })
    client.on('mex_notification', (event) => {
      if (event.kind === 'username_set') {
        void zapoUsernameIndex.touch(this.phone, event.username, event.lidJid)
      } else if (event.kind === 'username_delete') {
        void zapoUsernameIndex.removeByLid(this.phone, event.lidJid)
      } else if (event.kind === 'own_username_sync' && event.username) {
        void zapoUsernameIndex.touch(this.phone, event.username, event.ownLidJid)
      }
    })
    client.on('group', (event) => {
      const jid = event.groupJid || event.chatJid
      if (jid) void this.syncGroupCache(client, jid).catch((error) => logger.warn(error as any, 'Zapo group event sync failed for %s', jid))
      for (const participant of event.participants || []) {
        const lid = participant.lidJid || (participant.jid?.endsWith('@lid') ? participant.jid : undefined)
        if (participant.username && lid) void zapoUsernameIndex.touch(this.phone, participant.username, lid)
      }
    })
    client.on('history_sync_chunk', (event) => {
      logger.info(
        'Zapo history sync phone=%s progress=%s messages=%s conversations=%s',
        this.phone,
        `${event.progress ?? '<unknown>'}`,
        `${event.messagesCount}`,
        `${event.conversationsCount}`,
      )
    })
    client.on('stream_failure', (event) => {
      logger.error(
        'Zapo stream failure phone=%s reason=%s code=%s message=%s',
        this.phone,
        `${event.failureReason ?? '<unknown>'}`,
        `${event.failureCode ?? '<unknown>'}`,
        `${event.failureMessage || '<none>'}`,
      )
    })
    client.on('voip_call_incoming', (call: CallInfo) => {
      void this.handleIncomingCall(client, call).catch((error) => {
        logger.error(error as any, 'Zapo incoming call rejection failed for %s call %s', this.phone, call.callId)
      })
    })
  }

  private async handleIncomingCall(client: ZapoClient, call: CallInfo) {
    const rejectionMessage = this.config.rejectCalls.trim()
    if (rejectionMessage) {
      await client.voip.rejectCall(call.callId)
      await client.message.send(call.callerPn || call.peerJid, {
        type: 'text',
        text: rejectionMessage,
      })
    }
    const webhookMessage = (this.config.rejectCallsWebhook || this.config.messageCallsWebhook).trim()
    if (webhookMessage) {
      await this.listener.process(this.phone, [{
        key: {
          fromMe: false,
          id: uuid(),
          remoteJid: call.callerPn || call.peerJid,
          senderPn: call.callerPn,
        },
        message: { conversation: webhookMessage },
      }], 'notify')
    }
  }

  private scheduleReconnect() {
    const timer = setTimeout(() => {
      if (!this.intentionalDisconnect) void this.connect(2)
    }, Math.max(1000, this.config.retryRequestDelayMs))
    timer.unref?.()
  }

  private async acquireRuntimeOwnership() {
    if (!this.config.useRedis || this.lease) return
    const lease = this.leaseFactory(this.phone)
    if (!await lease.acquire()) throw new SendError(409, `zapo_session_owned_by_another_worker: ${this.phone}`)
    this.lease = lease
    this.leaseRenewTimer = setInterval(() => {
      void lease.renew().then(async (renewed) => {
        if (renewed) return
        await this.handleRuntimeOwnershipLoss('lease_lost')
      }).catch((error) => this.handleRuntimeOwnershipLoss('lease_renewal_failed', error))
    }, Math.max(1_000, Math.min(ZAPO_SESSION_LEASE_RENEW_MS, Math.floor(ZAPO_SESSION_LEASE_TTL_MS / 2))))
    this.leaseRenewTimer.unref?.()

    void this.maintenance.pruneMessageIndexBatch(this.phone).catch((error) => {
      logger.warn(error as any, 'Zapo Redis message index maintenance failed for %s', this.phone)
    })
    this.maintenanceTimer = setInterval(() => {
      void this.maintenance.pruneMessageIndexBatch(this.phone).catch((error) => {
        logger.warn(error as any, 'Zapo Redis message index maintenance failed for %s', this.phone)
      })
    }, Math.max(60_000, ZAPO_REDIS_MAINTENANCE_INTERVAL_MS))
    this.maintenanceTimer.unref?.()
  }

  private async handleRuntimeOwnershipLoss(reason: string, error?: unknown) {
    if (!this.lease) return
    logger.error(error as any, 'Zapo session ownership lost for %s (%s); disconnecting socket', this.phone, reason)
    if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.leaseRenewTimer = undefined
    this.maintenanceTimer = undefined
    this.lease = undefined
    this.intentionalDisconnect = true
    await Promise.resolve(this.socket?.disconnect()).catch(() => undefined)
    await this.unoStore?.sessionStore.setStatus(this.phone, 'offline')
  }

  private async releaseRuntimeOwnership() {
    if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.leaseRenewTimer = undefined
    this.maintenanceTimer = undefined
    const lease = this.lease
    this.lease = undefined
    if (lease) await lease.release().catch(() => false)
  }

  private async signPasskeyAssertion(requestOptions: Uint8Array) {
    if (this.pendingPasskey) throw new SendError(409, 'zapo_passkey_request_already_pending')
    const bridgeId = uuid()
    await createPasskeyBridgeSession(this.phone, bridgeId, Buffer.from(requestOptions))
    return new Promise<{ credentialId: Uint8Array; webauthnAssertion: Uint8Array }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingPasskey?.bridgeId !== bridgeId) return
        this.pendingPasskey = undefined
        void updatePasskeyBridgeSession(bridgeId, { status: 'timeout' })
        reject(new SendError(408, 'zapo_passkey_assertion_timeout'))
      }, Math.max(30, PASSKEY_BRIDGE_TTL_SECONDS || 120) * 1000)
      timeout.unref?.()
      this.pendingPasskey = {
        bridgeId,
        resolve: (value) => {
          clearTimeout(timeout)
          this.pendingPasskey = undefined
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          this.pendingPasskey = undefined
          reject(error)
        },
      }
    })
  }

  async connect(time: number) {
    void time
    if (this.connectTask) return this.connectTask
    this.connectTask = this.connectInternal()
    try {
      return await this.connectTask
    } catch (error) {
      await this.releaseRuntimeOwnership()
      throw error
    } finally {
      this.connectTask = undefined
    }
  }

  private async connectInternal() {
    this.intentionalDisconnect = false
    this.config = await this.getConfig(this.phone)
    this.unoStore = await this.config.getStore(this.phone, this.config)
    const sessionStore = this.unoStore.sessionStore
    await sessionStore.syncConnection(this.phone)
    if (this.socket && this.messages) return
    await this.acquireRuntimeOwnership()
    await sessionStore.setStatus(this.phone, 'connecting')

    const zapoStore = this.storeRegistry.get(this.config)
    this.zapoSession = zapoStore.session(this.phone)
    const migration = await ensureZapoSessionMigration(this.phone, this.config, this.zapoSession)
    logger.info('Zapo session migration %s -> %s (losses=%s)', this.phone, migration.status, migration.losses.length)
    if (this.config.useRedis) {
      await statusRecipients.loadOrBootstrap(this.phone).catch((error) => {
        logger.warn(error as any, 'Zapo status recipient bootstrap failed for %s', this.phone)
      })
    }

    const client = this.clientFactory({
      store: zapoStore,
      sessionId: this.phone,
      markOnlineOnConnect: this.config.markOnlineOnConnect,
      recoverFromClientTooOld: true,
      history: {
        enabled: !this.config.ignoreHistoryMessages,
        requireFullSync: this.config.allowFullHistorySync,
      },
      media: { processor: zapoMediaProcessor },
      signPasskeyAssertion: this.signPasskeyAssertion.bind(this),
      plugins: [voipPlugin()],
    })
    this.socket = client
    this.messages = new ZapoMessages(
      client,
      this.unoStore.dataStore,
      {
        customMessageCharactersFunction: this.config.customMessageCharactersFunction,
        composingMessage: this.config.composingMessage,
        store: this.zapoSession,
        phone: this.phone,
        bindTemplate: (payload) => new Template(this.getConfig).bind(
          this.phone,
          payload.template.name,
          payload.template.components,
        ),
      },
    )
    this.groups = new ZapoGroups(client, this.zapoSession, this.phone)
    this.config.getMessageMetadata = this.getMessageMetadata.bind(this)

    let promptResolved = false
    let resolvePrompt = () => undefined
    const prompt = new Promise<void>((resolve) => {
      resolvePrompt = () => {
        if (!promptResolved) {
          promptResolved = true
          resolve()
        }
      }
    })
    this.bindEvents(client, resolvePrompt)
    const socketConnect = client.connect()
    socketConnect.catch((error) => {
      logger.error(error as any, 'Zapo connection failed for %s', this.phone)
      void sessionStore.setStatus(this.phone, 'offline')
    })
    await Promise.race([socketConnect, prompt])
  }

  async disconnect() {
    this.intentionalDisconnect = true
    if (this.socket) await this.socket.disconnect()
    await this.unoStore?.sessionStore.setStatus(this.phone, 'offline')
    clients.delete(this.phone)
    configs.delete(this.phone)
    this.socket = undefined
    this.messages = undefined
    this.groups = undefined
    await this.releaseRuntimeOwnership()
  }

  async logout() {
    this.intentionalDisconnect = true
    if (!this.socket) throw new SendError(409, 'zapo_client_not_connected')
    await this.socket.logout()
    await this.disconnect()
  }

  async send(payload: any, options: any) {
    if (!this.messages) throw new SendError(409, 'zapo_client_not_connected')
    return this.messages.send(payload, options)
  }

  async recoverDelivery(payload: any, options: any = {}) {
    if (!this.messages) throw new SendError(409, 'zapo_client_not_connected')
    return this.messages.recoverDelivery(payload, options)
  }

  async sendPasskeyResponse(payload: { credentialId: Buffer; assertionJson: Buffer | string }) {
    const pending = this.pendingPasskey
    if (!pending) throw new SendError(409, 'zapo_passkey_assertion_not_pending')
    pending.resolve({
      credentialId: Uint8Array.from(payload.credentialId),
      webauthnAssertion: Uint8Array.from(Buffer.isBuffer(payload.assertionJson)
        ? payload.assertionJson
        : Buffer.from(payload.assertionJson)),
    })
    return { ok: { success: true, bridge_id: pending.bridgeId } }
  }

  async sendPasskeyConfirmation() {
    return { ok: { success: true, provider_managed_confirmation: true } }
  }

  async getMessageMetadata<T>(message: T) {
    if (!this.socket) return message
    const value: any = message
    const id = `${value?.key?.id || ''}`
    const event = this.pendingIncoming.get(id)
    if (!event) return message
    const mediaKey = mediaMessageKeys.find((key) => value?.message?.[key])
    if (!mediaKey) return message
    const media = value.message[mediaKey]
    if (`${media?.url || ''}`.startsWith('data:')) return message
    const bytes = await this.socket.message.downloadBytes(event)
    value.__unoapiMediaBytes = Buffer.from(bytes)
    return message
  }

  async contacts(numbers: string[]): Promise<Contact[]> {
    if (!this.socket || !this.zapoSession) throw new SendError(409, 'zapo_client_not_connected')
    const output: Contact[] = new Array(numbers.length)
    const numeric = numbers
      .map((value, index) => ({ value: `${value || ''}`.trim(), index }))
      .filter(({ value }) => !value.startsWith('@'))
    const usernames = numbers
      .map((value, index) => ({ value: `${value || ''}`.trim(), index }))
      .filter(({ value }) => value.startsWith('@'))
    for (const { value, index } of usernames) {
      const lid = await zapoUsernameIndex.resolve(this.phone, value)
      const stored = lid ? await this.zapoSession.contacts.getByJid(lid) : undefined
      output[index] = {
        input: numbers[index],
        wa_id: stored?.phoneNumber,
        user_id: lid,
        username: value.replace(/^@/, '').toLowerCase(),
        status: lid ? 'valid' : 'failed',
      }
    }
    const inputs = numeric.map(({ value }) => phoneNumberToJid(value))
    const results = inputs.length ? await this.socket.profile.getLidsByPhoneNumbers(inputs) : []
    const contacts = results.flatMap((result, index) => result.exists && result.lidJid ? [{
      jid: result.lidJid,
      lid: result.lidJid,
      phoneNumber: `${result.phoneJid || inputs[index]}`.split('@')[0],
      lastUpdatedMs: Date.now(),
    }] : [])
    if (contacts.length) await this.zapoSession.contacts.upsertBatch(contacts)
    results.forEach((result, resultIndex) => {
      const index = numeric[resultIndex].index
      output[index] = {
      input: numbers[index],
      wa_id: result.exists ? `${result.phoneJid || inputs[resultIndex]}`.split('@')[0] : undefined,
      user_id: result.exists ? (result.lidJid || undefined) : undefined,
      status: result.exists ? 'valid' : (result.invalid ? 'invalid' : 'failed'),
      }
    })
    return output
  }

  async requestPairingCode() {
    if (!this.socket) throw new SendError(409, 'zapo_client_not_connected')
    const code = await this.socket.auth.requestPairingCode(this.phone.replace(/\D/g, ''))
    await this.emitQr(code)
    return code
  }

  groupCreate(subject: string, participants: string[]) { return this.requireGroups().create(subject, participants) }
  groupUpdateSubject(jid: string, subject: string) { return this.requireGroups().updateSubject(jid, subject) }
  groupUpdateDescription(jid: string, description?: string) { return this.requireGroups().updateDescription(jid, description) }
  groupUpdatePicture(jid: string, pictureUrl: string) { return this.requireGroups().updatePicture(jid, pictureUrl) }
  async groupParticipantsUpdate(jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') { return [...await this.requireGroups().updateParticipants(jid, participants, action)] as any[] }
  groupInviteCode(jid: string) { return this.requireGroups().inviteCode(jid) }
  groupRevokeInvite(jid: string) { return this.requireGroups().revokeInvite(jid) }
  async groupRequestParticipantsList(jid: string) { return [...await this.requireGroups().joinRequests(jid)] as any[] }
  groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject') { return this.requireGroups().updateJoinRequests(jid, participants, action) }
  groupLeave(jid: string) { return this.requireGroups().leave(jid) }
  groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') { return this.requireGroups().updateSetting(jid, setting) }
  groupJoinApprovalMode(jid: string, mode: 'on' | 'off') { return this.requireGroups().updateJoinApprovalMode(jid, mode) }
  groupMetadata(jid: string) { return this.requireGroups().metadata(jid) }

  async resyncAppState() {
    if (!this.socket) throw new SendError(409, 'zapo_client_not_connected')
    await this.socket.chat.sync()
  }

  async fetchPrivacyTokens(jids: string[]) {
    if (!this.socket || !this.zapoSession) throw new SendError(409, 'zapo_client_not_connected')
    await this.socket.profile.getProfiles(jids)
    const records = await Promise.all(jids.map((jid) => this.zapoSession!.privacyToken.getByJid(jid)))
    return { targets: jids.map((jid, index) => ({ jid, stored: !!records[index] })), stored: records.filter(Boolean).length }
  }

  async fetchMessageHistory(payload: any = {}) {
    if (!this.socket) throw new SendError(409, 'zapo_client_not_connected')
    const result = await this.socket.message.requestHistorySync({
      chatJid: payload.chat_jid || payload.chatJid,
      oldestMsgId: payload.message_id || payload.messageId,
      oldestMsgFromMe: payload.from_me ?? payload.fromMe,
      oldestMsgTimestampMs: payload.timestamp ? Number(payload.timestamp) : undefined,
      count: payload.count,
    })
    return { request_id: result.messageId }
  }

  private requireGroups() {
    if (!this.groups) throw new SendError(409, 'zapo_client_not_connected')
    return this.groups
  }
}
