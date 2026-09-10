/* eslint-disable @typescript-eslint/no-explicit-any */
import QRCode from 'qrcode'
import { PinoLogger, WaClient as ZapoWaClient, type WaClient as WaClientType, type WaStoreSession } from 'zapo-js'
import { voipPlugin, type CallInfo } from '@vipertec/zapo-voip'
import { v1 as uuid } from 'uuid'
import type { Client, Contact } from './client'
import { clients } from './client'
import type { Config, getConfig } from './config'
import { configs, defaultConfig } from './config'
import type { Listener } from './listener'
import logger from './logger'
import type { OnNewLogin } from './login_types'
import type { Store } from './store'
import { SendError } from './send_error'
import { zapoStoreRegistry, type ZapoStoreRegistry } from './zapo/zapo_store_registry'
import { ZapoGroups } from './zapo/zapo_groups'
import { ZapoPresenceHeartbeat } from './zapo/zapo_presence_heartbeat'
import { prepareZapoState } from './zapo/zapo_persistent_state'
import { normalizeZapoPhoneJid, resolveZapoPhoneJid } from './zapo/zapo_contact_resolver'
import { ZapoMessages } from './zapo/zapo_messages'
import { isEncryptedZapoAddonMessage, toUnoAddonEvent, toUnoMessageEvent, toUnoReceiptUpdates } from './zapo/zapo_events'
import { statusRecipients } from './status/status_recipients'
import { zapoUsernameIndex } from './zapo/zapo_username_index'
import { enrichZapoMessageUsername } from './zapo/zapo_username_enrichment'
import { normalizeMessageContent } from './transformer/message_type'
import { Template } from './template'
import {
  PASSKEY_BRIDGE_TTL_SECONDS,
  ZAPO_REDIS_MAINTENANCE_INTERVAL_MS,
  ZAPO_NETWORK_IP_FAMILY,
  ZAPO_CHAT_SOCKET_IP_FAMILY,
  ZAPO_MEDIA_UPLOAD_IP_FAMILY,
  ZAPO_MEDIA_DOWNLOAD_IP_FAMILY,
  ZAPO_LINK_PREVIEW_IP_FAMILY,
  ZAPO_SESSION_LEASE_RENEW_MS,
  ZAPO_SESSION_LEASE_TTL_MS,
  UNOAPI_SERVER_NAME,
  VOIP_BRIDGE_URL,
  VOIP_MAX_CONCURRENT_CALLS,
  VOIP_SERVICE_TOKEN,
  VOIP_SERVICE_URL,
} from '../defaults'
import { createPasskeyBridgeSession, updatePasskeyBridgeSession } from './passkey_bridge'
import { RedisLease } from './redis_lease'
import { zapoRedisMaintenance, type ZapoRedisMaintenance } from './zapo/zapo_redis_maintenance'
import { loadZapoHistoryMessages } from './zapo/zapo_history'
import { ZapoProfilePictures } from './zapo/zapo_profile_pictures'
import { createPairingCodeImageDataUrl } from './zapo/pairing_code_image'
import { resolveZapoPollVoteOptionNames } from './zapo/zapo_poll_votes'
import { decryptZapoPollVoteWithJidFallback } from './zapo/zapo_poll_addon_decrypt'
import { createZapoProxyOptions } from './zapo/zapo_proxy'
import { isZapoOwnershipConflict, zapoReconnectDelay } from './zapo/zapo_reconnect_policy'
import { reviveZapoMediaBinaryFields } from './zapo/zapo_media'
import { zapoMediaOptions } from './zapo/zapo_media_processor'
import { downloadZapoMediaBytes } from './zapo/zapo_media_reupload'
import { ZapoContactBook } from './zapo/zapo_contact_book'
import { ZapoContactIdentityResolver } from './zapo/zapo_contact_identity'
import type { SaveContactInput } from './contacts/contact_book_types'
import { ZapoCatalog } from './zapo/zapo_catalog'
import { createZapoUnavailableMessage } from './zapo/zapo_unavailable_message'
import { ZapoVoiceAdapter } from './zapo/voice/zapo_voice_adapter'
import { resolveZapoVoiceBridgeUrl, ZapoVoiceBridgeClient } from './zapo/voice/zapo_voice_bridge_client'
import { ZapoVoiceCallerIdentityResolver } from './zapo/voice/zapo_voice_caller_identity'
import { normalizeInteractiveMediaForWebhook } from './messages/interactive_media'
import { BoundedTtlSet } from '../utils/bounded_ttl_cache'
import { createYouTubeLinkPreviewResolverForTransport } from './messages/youtube_link_preview'
import { zapoOperationDeadline } from './zapo/zapo_operation_deadline'

type VoipCoordinator = ReturnType<ReturnType<typeof voipPlugin>['setup']>
type ZapoClient = WaClientType & {
  voip: VoipCoordinator
  on(event: 'voip_call_incoming', listener: (call: CallInfo) => void): ZapoClient
}
type ClientFactory = (options: ConstructorParameters<typeof ZapoWaClient>[0]) => ZapoClient
type LeaseFactory = (phone: string) => RedisLease

const defaultClientFactory: ClientFactory = (options) =>
  new ZapoWaClient(options, new PinoLogger(logger.child({ scope: 'zapo' }), 'error')) as ZapoClient
const mediaMessageKeys = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'] as const
const ZAPO_HISTORY_DEDUP_MAX_IDS = 100_000
const ZAPO_HISTORY_DEDUP_TTL_MS = 30 * 24 * 60 * 60 * 1_000

export class ClientZapo implements Client {
  private config: Config = defaultConfig
  private unoStore?: Store
  private zapoSession?: WaStoreSession
  private socket?: ZapoClient
  private messages?: ZapoMessages
  private groups?: ZapoGroups
  private profilePictures?: ZapoProfilePictures
  private catalog?: ZapoCatalog
  private connectTask?: Promise<void>
  private socketAbort = new AbortController()
  private connected = false
  private readonly pendingIncoming = new Map<string, any>()
  private readonly decryptedAddonIds = new Set<string>()
  private readonly forwardedHistoryIds = new BoundedTtlSet<string>({
    maxEntries: ZAPO_HISTORY_DEDUP_MAX_IDS,
    ttlMs: ZAPO_HISTORY_DEDUP_TTL_MS,
  })
  private historySyncTask: Promise<void> = Promise.resolve()
  private intentionalDisconnect = false
  private lease?: RedisLease
  private leaseRenewTimer?: NodeJS.Timeout
  private maintenanceTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private reconnectAttempts = 0
  private pendingPasskey?: {
    bridgeId: string
    resolve: (value: { credentialId: Uint8Array; webauthnAssertion: Uint8Array }) => void
    reject: (error: Error) => void
  }
  private activePasskeyBridgeId?: string
  private pairingCodeRequest?: Promise<string>
  private pairingCodeIssued = false
  private connectionGeneration = 0
  private voiceBridge?: ZapoVoiceBridgeClient
  private readonly presenceHeartbeat: ZapoPresenceHeartbeat

  constructor(
    private readonly phone: string,
    private readonly listener: Listener,
    private readonly getConfig: getConfig,
    private readonly onNewLogin: OnNewLogin,
    private readonly storeRegistry: ZapoStoreRegistry = zapoStoreRegistry,
    private readonly clientFactory: ClientFactory = defaultClientFactory,
    private readonly leaseFactory: LeaseFactory = (session) => new RedisLease(`zapo-session:${session}`, ZAPO_SESSION_LEASE_TTL_MS),
    private readonly maintenance: ZapoRedisMaintenance = zapoRedisMaintenance,
  ) {
    this.presenceHeartbeat = new ZapoPresenceHeartbeat(phone)
  }

  private async emitQr(value: string, isCurrent: () => boolean) {
    const imageUrl = await QRCode.toDataURL(value)
    if (!isCurrent()) return
    await this.listener.process(
      this.phone,
      [
        {
          key: { fromMe: true, remoteJid: `${this.phone.replace(/\D/g, '')}@s.whatsapp.net`, id: uuid() },
          message: { imageMessage: { url: imageUrl, mimetype: 'image/png', caption: 'Zapo pairing' } },
        },
      ],
      'qrcode',
    )
  }

  private async emitPairingCode(value: string, isCurrent: () => boolean) {
    const imageUrl = await createPairingCodeImageDataUrl(value)
    if (!isCurrent()) return
    await this.listener.process(
      this.phone,
      [
        {
          key: { fromMe: true, remoteJid: `${this.phone.replace(/\D/g, '')}@s.whatsapp.net`, id: uuid() },
          message: { imageMessage: { url: imageUrl, mimetype: 'image/svg+xml', caption: 'Zapo pairing code' } },
        },
      ],
      'qrcode',
    )
  }

  private async emitStatus(value: string) {
    await this.listener.process(
      this.phone,
      [
        {
          key: { fromMe: true, remoteJid: `${this.phone.replace(/\D/g, '')}@s.whatsapp.net`, id: uuid() },
          message: { conversation: value },
        },
      ],
      'status',
    )
  }

  private async syncGroupCache(client: ZapoClient, groupJid?: string) {
    if (!this.unoStore) return
    const groups = groupJid ? [await client.group.queryGroupMetadata(groupJid)] : [...(await client.group.queryAllGroups())]
    await Promise.all(
      groups.map(async (group: any) => {
        const jid = `${group?.id || group?.jid || group?.groupJid || ''}`
        if (jid) await this.unoStore!.dataStore.setGroupMetada(jid, group)
        await Promise.all(
          (group?.participants || []).map(async (participant: any) => {
            const lid = [participant?.lid, participant?.jid, participant?.id]
              .map((value) => `${value || ''}`.trim())
              .find((value) => value.endsWith('@lid'))
            const phoneJid = normalizeZapoPhoneJid(`${participant?.phoneNumber || participant?.phone_number || participant?.pn || ''}`)
            if (lid && phoneJid) {
              await this.unoStore?.dataStore.setJidMapping?.(this.phone, phoneJid, lid)
            }
          }),
        )
      }),
    )
  }

  private async enrichGroupMetadata<T>(message: T): Promise<T> {
    const payload: any = message
    const groupJid = `${payload?.key?.remoteJid || ''}`
    if (!groupJid.endsWith('@g.us') || !this.unoStore) return message

    let metadata = await this.unoStore.dataStore.getGroupMetada(groupJid)
    if (!metadata && this.socket) {
      try {
        metadata = (await this.socket.group.queryGroupMetadata(groupJid)) as any
        if (metadata) await this.unoStore.dataStore.setGroupMetada(groupJid, metadata)
      } catch (error) {
        logger.warn(error as any, 'Zapo group metadata lookup failed for %s', groupJid)
      }
    }
    if (metadata) payload.groupMetadata = { ...metadata, ...(payload.groupMetadata || {}) }
    return message
  }

  private async forwardStoredHistory(maxAgeDays = this.config.historyMaxAgeDays, forceReplay = false) {
    if (!this.zapoSession) throw new SendError(409, 'zapo_client_not_connected')
    if (forceReplay) this.forwardedHistoryIds.clear()
    const messages = await loadZapoHistoryMessages(this.zapoSession, maxAgeDays, this.forwardedHistoryIds)
    logger.info('Zapo forwarding history phone=%s days=%s messages=%s', this.phone, maxAgeDays, messages.length)
    if (messages.length) {
      await Promise.all(messages.map((message) => this.enrichMessageUsername(message)))
      await this.listener.process(this.phone, messages, 'history')
      for (const message of messages) {
        const id = `${message.key.id || ''}`.trim()
        if (id) this.forwardedHistoryIds.add(id)
      }
    }
    return messages.length
  }

  private async handleConnectionFailure(client: ZapoClient, error: unknown) {
    logger.error(error as any, 'Zapo connection failed for %s', this.phone)
    if (this.socket !== client) return
    this.connectionGeneration += 1
    this.connected = false
    this.voiceBridge?.stop('connection_failed')
    this.voiceBridge = undefined
    this.socket = undefined
    this.messages = undefined
    this.groups = undefined
    this.profilePictures = undefined
    this.catalog = undefined
    this.pendingPasskey?.reject(new SendError(502, 'zapo_passkey_connection_failed'))
    try {
      await this.unoStore?.sessionStore.setStatus(this.phone, 'offline')
    } catch (statusError) {
      logger.warn(statusError as any, 'Could not persist Zapo offline status after connection failure for %s', this.phone)
    } finally {
      await this.releaseRuntimeOwnership()
      if (!this.intentionalDisconnect) this.scheduleReconnect()
    }
  }

  private async enrichDirectPhoneAlias(message: any, event: any) {
    if (event.key.isGroup) return
    const recipientLid = `${event.key.remoteJid || ''}`
    if (!recipientLid.endsWith('@lid')) return

    const currentPhoneJid = normalizeZapoPhoneJid(`${message.key.remoteJidAlt || ''}`)
    const ownPhoneJid = normalizeZapoPhoneJid(this.phone)
    const canUseCurrentPhone = currentPhoneJid && (!event.key.fromMe || currentPhoneJid !== ownPhoneJid)
    const phoneJid = canUseCurrentPhone
      ? currentPhoneJid
      : await resolveZapoPhoneJid(this.zapoSession?.contacts, recipientLid, event.key.fromMe ? {} : { attempts: 4, delayMs: 100 })
    if (!phoneJid) return

    message.key.remoteJidAlt = phoneJid
    await this.unoStore?.dataStore.setJidMapping?.(this.phone, phoneJid, recipientLid)
  }

  private async forwardDecryptedAddon(client: ZapoClient, event: any) {
    if (!isEncryptedZapoAddonMessage(event.message)) return false
    const id = `${event.key?.id || ''}`.trim()
    if (!id) return false

    this.decryptedAddonIds.delete(id)
    let officialError: unknown
    try {
      await client.message.tryDecryptAddon(event)
    } catch (error) {
      officialError = error
    }

    if (this.decryptedAddonIds.delete(id)) {
      logger.info('ZAPO_ADDON_DECRYPT phone=%s id=%s path=official', this.phone, id)
      return true
    }

    try {
      const pollVote = await decryptZapoPollVoteWithJidFallback(event, this.zapoSession)
      if (pollVote) {
        logger.warn('ZAPO_ADDON_DECRYPT phone=%s id=%s path=legacy_poll_fallback', this.phone, id)
        await this.processAddonEvent(pollVote)
        return true
      }
    } catch (fallbackError) {
      logger.warn(fallbackError as any, 'Zapo legacy poll fallback failed phone=%s id=%s', this.phone, id)
    }

    if (officialError) {
      logger.warn(officialError as any, 'Zapo official addon decryption failed phone=%s id=%s', this.phone, id)
    }
    logger.warn('Zapo addon decryption produced no event phone=%s id=%s', this.phone, id)
    return false
  }

  private async processAddonEvent(event: any) {
    if (event.key.id) this.decryptedAddonIds.add(event.key.id)
    const resolved = await resolveZapoPollVoteOptionNames(event, this.zapoSession)
    if (resolved.decrypted.kind === 'poll_vote' && !resolved.decrypted.selectedOptionNames?.length) {
      logger.warn(
        'Zapo poll vote option names unresolved phone=%s id=%s parent=%s selected=%s',
        this.phone,
        event.key.id || '<none>',
        event.targetMessageId || '<none>',
        resolved.decrypted.pollVote.selectedOptions?.length || 0,
      )
    }
    const message = toUnoAddonEvent(resolved)
    await this.enrichMessageUsername(message)
    await this.listener.process(this.phone, [message], 'notify')
  }

  private enrichMessageUsername(message: { key?: object }) {
    return enrichZapoMessageUsername(this.phone, message, !this.config.useRedis)
  }

  private async learnMessageUsername(event: any) {
    if (event.key?.isNewsletter) return
    const isGroup = event.key?.isGroup || `${event.key?.remoteJid || ''}`.endsWith('@g.us')
    const username = `${(
      event.key?.fromMe && !isGroup
        ? event.key?.recipientUsername
        : event.key?.participantUsername || event.key?.senderUsername || event.key?.remoteJidUsername
    ) || ''}`.trim()
    if (!username) return
    const candidates = isGroup
      ? [event.key?.participant, event.key?.participantAlt]
      : [event.key?.remoteJid, event.key?.remoteJidAlt, event.key?.participant]
    const lid = candidates.map((value) => `${value || ''}`).find((value) => value.endsWith('@lid'))
    if (lid) await zapoUsernameIndex.touch(this.phone, username, lid)
  }

  private beginPairingCodeRequest(client: ZapoClient, forceRefresh = false) {
    if (this.pairingCodeRequest) return this.pairingCodeRequest
    if (this.pairingCodeIssued && !forceRefresh) return undefined

    this.pairingCodeIssued = true
    const request = zapoOperationDeadline(
      client.auth.requestPairingCode(this.phone.replace(/\D/g, '')),
      30_000, this.socketAbort.signal, 'zapo_pairing_code_timeout',
    )
    this.pairingCodeRequest = request
    void request.then(
      () => {
        if (this.pairingCodeRequest === request) this.pairingCodeRequest = undefined
      },
      () => {
        if (this.pairingCodeRequest === request) {
          this.pairingCodeRequest = undefined
          this.pairingCodeIssued = false
        }
      },
    )
    return request
  }

  private bindEvents(client: ZapoClient, resolvePrompt: () => void, generation: number) {
    const isCurrent = () => this.socket === client && this.connectionGeneration === generation && !this.intentionalDisconnect
    const onCurrent = (event: any, handler: (...args: any[]) => any) =>
      client.on(event, (...args: any[]) => {
        if (!isCurrent()) return
        return handler(...args)
      })

    onCurrent('auth_qr', ({ qr }) => {
      resolvePrompt()
      if (this.config.connectionType === 'pairing_code') {
        void this.beginPairingCodeRequest(client)?.catch((error) => {
          logger.warn(error as any, 'Could not request Zapo pairing code for %s', this.phone)
        })
        return
      }
      void this.emitQr(qr, isCurrent).catch((error) => logger.warn(error as any, 'Could not emit Zapo QR for %s', this.phone))
    })
    onCurrent('auth_pairing_required', ({ forceManual }) => {
      resolvePrompt()
      if (this.config.connectionType !== 'pairing_code') return
      void this.beginPairingCodeRequest(client, forceManual)?.catch((error) => {
        logger.warn(error as any, 'Could not request Zapo pairing code for %s', this.phone)
      })
    })
    onCurrent('auth_pairing_code', ({ code }) => {
      resolvePrompt()
      this.pairingCodeIssued = true
      void this.emitPairingCode(code, isCurrent).catch((error) => logger.warn(error as any, 'Could not emit Zapo pairing code for %s', this.phone))
    })
    onCurrent('auth_paired', async ({ credentials }) => {
      await Promise.resolve(this.zapoSession?.auth.save(credentials)).catch((error) => {
        logger.error(error as any, 'Could not persist paired Zapo credentials for %s', this.phone)
      })
      const bridgeId = this.activePasskeyBridgeId
      this.activePasskeyBridgeId = undefined
      if (bridgeId) {
        await updatePasskeyBridgeSession(bridgeId, { status: 'completed' }).catch((error) => {
          logger.warn(error as any, 'Could not complete Zapo passkey bridge %s', bridgeId)
        })
      }
    })
    onCurrent('auth_passkey_required', ({ hasSigner }) => {
      resolvePrompt()
      void Promise.resolve(
        this.listener.process(
          this.phone,
          [
            {
              key: { fromMe: true, remoteJid: `${this.phone.replace(/\D/g, '')}@s.whatsapp.net`, id: uuid() },
              message: { conversation: hasSigner ? 'zapo_passkey_signer_ready' : 'zapo_passkey_signer_required' },
            },
          ],
          'status',
        ),
      ).catch((error) => logger.warn(error as any, 'Could not emit Zapo passkey status for %s', this.phone))
    })
    onCurrent('connection', async (event) => {
      if (event.status === 'open') {
        const credentials = client.getCredentials()
        if (credentials) await this.zapoSession?.auth.save(credentials)
        if (!isCurrent()) return
        const registered = clients.get(this.phone)
        if (registered && registered !== this) {
          logger.warn('Discarding duplicate Zapo socket for %s after reconnect race', this.phone)
          await Promise.resolve(client.disconnect()).catch(() => undefined)
          await this.releaseRuntimeOwnership()
          return
        }
        clients.set(this.phone, this)
        this.connected = true
        this.presenceHeartbeat.start(client, this.config.markOnlineOnConnect, () => isCurrent() && this.connected)
        this.voiceBridge?.start()
        this.reconnectAttempts = 0
        await this.unoStore?.sessionStore.setStatus(this.phone, 'online')
        await this.emitStatus(`Connected with ${this.phone} using Zapo`).catch((error) => {
          logger.warn(error as any, 'Could not emit Zapo connected status for %s', this.phone)
        })
        void this.syncGroupCache(client).catch((error) => logger.warn(error as any, 'Zapo group cache sync failed for %s', this.phone))
        if (event.isNewLogin) await this.onNewLogin(this.phone)
        return
      }
      this.connected = false
      this.presenceHeartbeat.stop()
      this.voiceBridge?.stop(event.isLogout ? 'session_unlinked' : 'connection_closed')
      this.pendingPasskey?.reject(new SendError(502, event.isLogout ? 'zapo_passkey_session_unlinked' : 'zapo_passkey_connection_closed'))
      try {
        await this.unoStore?.sessionStore.setStatus(this.phone, event.isLogout ? 'disconnected' : 'offline')
      } finally {
        if (this.socket === client && !this.intentionalDisconnect) {
          this.connectionGeneration += 1
          this.socket = undefined
          this.messages = undefined
          this.groups = undefined
          this.profilePictures = undefined
          this.catalog = undefined
          this.pairingCodeRequest = undefined
          this.pairingCodeIssued = false
          this.socketAbort.abort()
          await this.releaseRuntimeOwnership()
          if (!event.isLogout) this.scheduleReconnect()
        }
      }
    })
    onCurrent('message', async (event) => {
      // Zapo emits the encrypted `message` before the decrypted `message_addon`.
      // Awaiting the documented manual path avoids the raw event winning Uno's
      // deduplication window and hiding the readable poll/reaction/edit payload.
      if (await this.forwardDecryptedAddon(client, event)) return

      const message = toUnoMessageEvent(event)
      await this.learnMessageUsername(event)
      await this.enrichMessageUsername(message)
      await this.enrichDirectPhoneAlias(message, event)
      if (event.key.isGroup || `${event.key.remoteJid || ''}`.endsWith('@g.us')) {
        logger.info(
          'ZAPO_GROUP_MESSAGE phone=%s id=%s chat=%s fromMe=%s participant=%s participantAlt=%s types=%s',
          this.phone,
          event.key.id || '<none>',
          event.key.remoteJid || '<none>',
          !!event.key.fromMe,
          event.key.participant || '<none>',
          event.key.participantAlt || '<none>',
          Object.keys(event.message || {}).join(',') || '<none>',
        )
      }
      if (event.key.isGroup && !message.key.participantAlt) {
        const senderLid = `${event.key.participant || ''}`
        if (senderLid.endsWith('@lid')) {
          const contact = await this.zapoSession?.contacts.getByJid(senderLid)
          const phoneNumber = `${contact?.phoneNumber || ''}`.trim()
          if (phoneNumber) {
            const participantPhoneJid = normalizeZapoPhoneJid(phoneNumber)
            if (participantPhoneJid) {
              message.key.participantAlt = participantPhoneJid
              await this.unoStore?.dataStore.setJidMapping?.(this.phone, participantPhoneJid, senderLid)
            }
          }
        }
      }
      if (message.key.id) this.pendingIncoming.set(message.key.id, event)
      if (!event.key.fromMe && !event.key.isNewsletter) {
        const recipientAliases = [message.key.participantAlt, message.key.participant, message.key.remoteJidAlt, message.key.remoteJid]
          .map((jid) => `${jid || ''}`)
          .filter((jid) => jid.endsWith('@s.whatsapp.net'))
        if (recipientAliases.length) {
          void statusRecipients.touch(this.phone, recipientAliases).catch((error) => {
            logger.warn(error as any, 'Zapo status recipient index update failed for %s', this.phone)
          })
        }
      }
      if (message.key.remoteJid && message.key.id) {
        await this.unoStore?.dataStore.setKey(message.key.id, message.key as never)
        await this.unoStore?.dataStore.setMessage(message.key.remoteJid, message as never)
      }
      try {
        await this.listener.process(this.phone, [message], 'notify')
        if (event.key.id) this.forwardedHistoryIds.add(event.key.id)
      } finally {
        if (message.key.id) this.pendingIncoming.delete(message.key.id)
      }
      if (this.config.readOnReceipt && !message.key.fromMe) {
        await Promise.resolve(client.message.sendReceipt(event, { type: 'read' })).catch((error) => {
          logger.warn(error as any, 'Ignore Zapo read-on-receipt error phone=%s message=%s', this.phone, message.key.id || '<none>')
        })
      }
    })
    onCurrent('message_send', async (event) => {
      if (!event.id) return
      const remoteJid = event.to
      const message = { key: { remoteJid, id: event.id, fromMe: true }, message: event.message }
      await this.unoStore?.dataStore.setKey(event.id, message.key as never)
      await this.unoStore?.dataStore.setMessage(remoteJid, message as never)
    })
    onCurrent('receipt', async (event) => {
      const isGroup = `${event.chatJid || ''}`.endsWith('@g.us')
      const receiptLid = [event.participantJid, event.chatJid].map((value) => `${value || ''}`).find((value) => value.endsWith('@lid'))
      if (event.participantUsername && receiptLid) {
        await zapoUsernameIndex.touch(this.phone, event.participantUsername, receiptLid)
      }
      if (isGroup && this.config.ignoreGroupIndividualReceipts && event.participantJid) return
      if (isGroup && this.config.groupOnlyDeliveredStatus && event.status !== 'delivered') return
      const contact = event.chatJid && this.zapoSession ? await this.zapoSession.contacts.getByJid(event.chatJid) : undefined
      const phoneJid = normalizeZapoPhoneJid(`${contact?.phoneNumber || ''}`)
      const receiptChatJid = `${event.chatJid || ''}`
      if (phoneJid && receiptChatJid.endsWith('@lid')) {
        await this.unoStore?.dataStore.setJidMapping?.(this.phone, phoneJid, receiptChatJid)
      }
      const updates = toUnoReceiptUpdates(event, phoneJid)
      if (updates.length) await this.listener.process(this.phone, updates, 'update')
    })
    onCurrent('message_addon', async (event) => {
      await this.processAddonEvent(event)
    })
    onCurrent('own_username', async (event) => {
      const ownLid = `${(await this.zapoSession?.auth.load())?.meLid || ''}`
      if (!ownLid.endsWith('@lid') || event.kind === 'modify') return
      if (event.kind === 'set' && event.username) {
        await zapoUsernameIndex.touch(this.phone, event.username, ownLid)
      } else if (event.kind === 'delete') {
        await zapoUsernameIndex.removeByLid(this.phone, ownLid)
      }
    })
    onCurrent('message_protocol', async (event) => {
      const message = toUnoMessageEvent(event)
      await this.enrichMessageUsername(message)
      if (message.key.remoteJid && message.key.id) {
        await this.unoStore?.dataStore.setKey(message.key.id, message.key as never)
        await this.unoStore?.dataStore.setMessage(message.key.remoteJid, message as never)
      }
      await this.listener.process(this.phone, [message], 'notify')
    })
    onCurrent('message_unavailable', async (event) => {
      logger.warn(
        'Zapo unavailable message phone=%s id=%s kind=%s resend_requested=%s',
        this.phone,
        event.key.id,
        event.kind,
        `${event.resendRequested === true}`,
      )
      // Zapo can recover a plain placeholder from the primary device. In
      // that case the real message arrives later with the same key, so emitting
      // a fallback now would create duplicate content in the integration.
      if (event.resendRequested === true) return

      const message = createZapoUnavailableMessage(event)
      await this.enrichMessageUsername(message)
      if (event.key.remoteJid && event.key.id) {
        await this.unoStore?.dataStore.setKey(event.key.id, event.key as never)
        await this.unoStore?.dataStore.setMessage(event.key.remoteJid, message as never)
      }
      await this.listener.process(this.phone, [message], 'notify')
    })
    onCurrent('debug_unhandled_stanza', (event) => {
      const from = `${event.rawNode?.attrs?.from || ''}`
      if (!from.endsWith('@g.us')) return
      logger.warn(
        'ZAPO_GROUP_UNHANDLED phone=%s id=%s from=%s type=%s reason=%s',
        this.phone,
        event.rawNode?.attrs?.id || '<none>',
        from,
        event.stanzaType || '<none>',
        event.reason,
      )
    })
    onCurrent('mex_notification', async (event) => {
      if (event.kind === 'username_set') {
        await zapoUsernameIndex.touch(this.phone, event.username, event.lidJid)
      } else if (event.kind === 'username_delete') {
        await zapoUsernameIndex.removeByLid(this.phone, event.lidJid)
      } else if (event.kind === 'own_username_sync' && event.username) {
        await zapoUsernameIndex.touch(this.phone, event.username, event.ownLidJid)
      } else if (event.kind === 'own_username_sync') {
        await zapoUsernameIndex.removeByLid(this.phone, event.ownLidJid)
      } else if (event.kind === 'lid_change') {
        const contact = await this.zapoSession?.contacts.getByJid(event.oldLidJid)
        if (contact) {
          await this.zapoSession?.contacts.upsert({
            ...contact,
            jid: event.newLidJid,
            lid: event.newLidJid,
            lastUpdatedMs: Date.now(),
          })
          await this.zapoSession?.contacts.deleteByJid(event.oldLidJid)
          const phoneJid = normalizeZapoPhoneJid(`${contact.phoneNumber || ''}`)
          if (phoneJid) {
            await this.unoStore?.dataStore.setJidMapping?.(this.phone, phoneJid, event.newLidJid)
          }
        }
        logger.info('Zapo LID rotation phone=%s old=%s new=%s', this.phone, event.oldLidJid, event.newLidJid)
      } else if (event.kind === 'message_capping') {
        logger.warn(
          'Zapo message capping phone=%s status=%s used=%s total=%s',
          this.phone,
          event.cappingStatus,
          `${event.usedQuota ?? '<unknown>'}`,
          `${event.totalQuota ?? '<unknown>'}`,
        )
      }
    })
    onCurrent('group', (event) => {
      const jid = event.groupJid || event.chatJid
      if (jid) void this.syncGroupCache(client, jid).catch((error) => logger.warn(error as any, 'Zapo group event sync failed for %s', jid))
      for (const participant of event.participants || []) {
        const lid = participant.lidJid || (participant.jid?.endsWith('@lid') ? participant.jid : undefined)
        if (participant.username && lid) void zapoUsernameIndex.touch(this.phone, participant.username, lid)
      }
    })
    onCurrent('picture', (event) => {
      void this.profilePictures?.handleEvent(event).catch((error) => {
        logger.warn(error as any, 'Zapo profile picture event failed for %s', this.phone)
      })
    })
    onCurrent('history_sync_chunk', async (event) => {
      logger.info(
        'Zapo history sync phone=%s progress=%s messages=%s conversations=%s',
        this.phone,
        `${event.progress ?? '<unknown>'}`,
        `${event.messagesCount}`,
        `${event.conversationsCount}`,
      )
      if (this.config.ignoreHistoryMessages || !this.zapoSession) return
      if (event.progress !== undefined && event.progress < 100) return
      this.historySyncTask = this.historySyncTask
        .then(async () => {
          await this.forwardStoredHistory()
        })
        .catch((error) => {
          logger.warn(error as any, 'Zapo history forwarding failed for %s', this.phone)
        })
      await this.historySyncTask
    })
    onCurrent('offline_resume', (event) => {
      logger.info(
        'Zapo offline resume phone=%s status=%s remaining=%s total=%s forced=%s',
        this.phone,
        event.status,
        event.remainingStanzas,
        event.totalStanzas,
        event.forced,
      )
    })
    onCurrent('debug_privacy_token', (event) => {
      logger.info(
        'Zapo privacy token cached phone=%s jid=%s type=%s source=%s timestamp=%s',
        this.phone,
        event.jid,
        event.type,
        event.source,
        event.timestampS,
      )
    })
    onCurrent('stream_failure', (event) => {
      logger.error(
        'Zapo stream failure phone=%s reason=%s code=%s message=%s',
        this.phone,
        `${event.failureReason ?? '<unknown>'}`,
        `${event.failureCode ?? '<unknown>'}`,
        `${event.failureMessage || '<none>'}`,
      )
    })
    onCurrent('stanza_error', (event) => {
      logger.error(
        'Zapo stanza error phone=%s stanza=%s chat=%s code=%s text=%s',
        this.phone,
        event.stanzaId || '<none>',
        event.chatJid || '<none>',
        `${event.code ?? '<unknown>'}`,
        event.text || '<none>',
      )
    })
    onCurrent('debug_client_error', ({ error }) => {
      logger.error(error as any, 'Zapo client error for %s', this.phone)
    })
    onCurrent('voip_call_incoming', (call: CallInfo) => {
      return this.handleIncomingCall(client, call).catch((error) => {
        logger.error(error as any, 'Zapo incoming call rejection failed for %s call %s', this.phone, call.callId)
      })
    })
    onCurrent('voip_call_state', (call: CallInfo) => {
      logger.info(
        'Zapo VoIP state phone=%s call=%s direction=%s state=%s endReason=%s peer=%s',
        this.phone,
        call.callId,
        call.direction,
        `${call.stateData?.state || 'unknown'}`,
        `${call.stateData?.endReason || '<none>'}`,
        call.peerJid,
      )
      this.voiceBridge?.publishState(call)
    })
    onCurrent('voip_call_ended', (call: CallInfo) => {
      logger.info(
        'Zapo VoIP ended phone=%s call=%s direction=%s state=%s endReason=%s peer=%s',
        this.phone,
        call.callId,
        call.direction,
        `${call.stateData?.state || 'unknown'}`,
        `${call.stateData?.endReason || 'ended'}`,
        call.peerJid,
      )
      this.voiceBridge?.publishEnded(call)
    })
    onCurrent('voip_call_inbound_audio', ({ call, pcm }: { call: CallInfo; pcm: Float32Array }) => {
      this.voiceBridge?.publishInboundAudio(call.callId, pcm)
    })
    onCurrent('voip_call_error', (error: Error) => {
      this.voiceBridge?.publishError(error)
    })
  }

  private async handleIncomingCall(client: ZapoClient, call: CallInfo) {
    const callerIdentity = await new ZapoVoiceCallerIdentityResolver(
      this.phone,
      this.zapoSession?.contacts,
      (session, lidJid) => zapoUsernameIndex.resolveByLid(
        session,
        lidJid,
        Date.now(),
        !this.config.useRedis,
      ),
      async (session, peerJid) => this.unoStore?.dataStore.getPnForLid?.(session, peerJid),
      { attempts: 4, delayMs: 100 },
    ).resolve(call.peerJid, call.callerPn)
    const callerJid = callerIdentity.callerPn
      ? `${callerIdentity.callerPn}@s.whatsapp.net`
      : normalizeZapoPhoneJid(`${call.callerPn || ''}`)
    const rejectionMessage = this.config.rejectCalls.trim()
    if (rejectionMessage) {
      await client.voip.rejectCall(call.callId)
      await client.message.send(callerJid || call.peerJid, {
        type: 'text',
        text: rejectionMessage,
      })
      logger.info('Zapo incoming call rejected phone=%s call=%s peer=%s', this.phone, call.callId, callerJid || call.peerJid)
      await this.emitCallWebhook(call, callerJid)
      return
    }
    if (this.voiceBridge?.publishIncoming(call, callerIdentity)) {
      await this.emitCallWebhook(call, callerJid)
      return
    }
    await this.emitCallWebhook(call, callerJid)
  }

  private async emitCallWebhook(call: CallInfo, resolvedCallerPn?: string) {
    const webhookMessage = (this.config.rejectCallsWebhook || this.config.messageCallsWebhook).trim()
    if (webhookMessage) {
      const callerPn = resolvedCallerPn || call.callerPn
      await this.listener.process(
        this.phone,
        [
          {
            key: {
              fromMe: false,
              id: uuid(),
              remoteJid: callerPn || call.peerJid,
              senderPn: callerPn,
              __unoapiSkipTypebot: true,
            },
            message: { conversation: webhookMessage },
          },
        ],
        'notify',
      )
    }
  }

  private scheduleReconnect() {
    if (this.intentionalDisconnect || this.reconnectTimer) return
    const attempt = this.reconnectAttempts++
    const delay = zapoReconnectDelay(attempt, this.config.retryRequestDelayMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.intentionalDisconnect) {
        void this.connect(2).catch((error) => {
          logger.error(error as any, 'Zapo reconnect attempt failed for %s', this.phone)
        })
      }
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private async acquireRuntimeOwnership() {
    if (!this.config.useRedis || this.lease) return
    const lease = this.leaseFactory(this.phone)
    if (!(await lease.acquire())) throw new SendError(409, `zapo_session_owned_by_another_worker: ${this.phone}`)
    this.lease = lease
    this.leaseRenewTimer = setInterval(
      () => {
        void lease
          .renew()
          .then(async (renewed) => {
            if (renewed) return
            await this.handleRuntimeOwnershipLoss('lease_lost')
          })
          .catch((error) => this.handleRuntimeOwnershipLoss('lease_renewal_failed', error))
      },
      Math.max(1_000, Math.min(ZAPO_SESSION_LEASE_RENEW_MS, Math.floor(ZAPO_SESSION_LEASE_TTL_MS / 2))),
    )
    this.leaseRenewTimer.unref?.()

    void this.maintenance.pruneMessageIndexBatch(this.phone).catch((error) => {
      logger.warn(error as any, 'Zapo Redis message index maintenance failed for %s', this.phone)
    })
    this.maintenanceTimer = setInterval(
      () => {
        void this.maintenance.pruneMessageIndexBatch(this.phone).catch((error) => {
          logger.warn(error as any, 'Zapo Redis message index maintenance failed for %s', this.phone)
        })
      },
      Math.max(60_000, ZAPO_REDIS_MAINTENANCE_INTERVAL_MS),
    )
    this.maintenanceTimer.unref?.()
  }

  private async handleRuntimeOwnershipLoss(reason: string, error?: unknown) {
    if (!this.lease) return
    this.presenceHeartbeat.stop()
    logger.error(error as any, 'Zapo session ownership lost for %s (%s); disconnecting socket', this.phone, reason)
    if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.leaseRenewTimer = undefined
    this.maintenanceTimer = undefined
    this.lease = undefined
    this.intentionalDisconnect = true
    this.connected = false
    const socket = this.socket
    this.connectionGeneration += 1
    this.socket = undefined
    this.messages = undefined
    this.groups = undefined
    this.profilePictures = undefined
    this.catalog = undefined
    await Promise.resolve(socket?.disconnect()).catch(() => undefined)
    await this.unoStore?.sessionStore.setStatus(this.phone, 'offline')
    this.intentionalDisconnect = false
    this.scheduleReconnect()
  }

  private async releaseRuntimeOwnership() {
    this.presenceHeartbeat.stop()
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
    this.activePasskeyBridgeId = bridgeId
    return new Promise<{ credentialId: Uint8Array; webauthnAssertion: Uint8Array }>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          if (this.pendingPasskey?.bridgeId !== bridgeId) return
          this.pendingPasskey = undefined
          this.activePasskeyBridgeId = undefined
          void updatePasskeyBridgeSession(bridgeId, { status: 'timeout' })
          reject(new SendError(408, 'zapo_passkey_assertion_timeout'))
        },
        Math.max(30, PASSKEY_BRIDGE_TTL_SECONDS || 120) * 1000,
      )
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
          this.activePasskeyBridgeId = undefined
          void updatePasskeyBridgeSession(bridgeId, { status: 'error', error: error.message })
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
      if (isZapoOwnershipConflict(error) && clients.get(this.phone) === this) {
        this.scheduleReconnect()
      }
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
    const preparationGeneration = this.connectionGeneration
    await prepareZapoState(zapoStore)
    if (this.intentionalDisconnect || preparationGeneration !== this.connectionGeneration) {
      throw new Error('zapo_operation_cancelled')
    }
    this.zapoSession = zapoStore.session(this.phone)
    this.pairingCodeRequest = undefined
    this.pairingCodeIssued = false
    const requiresPairing = !(await this.zapoSession.auth.load())?.meJid
    logger.info('Zapo session startup phone=%s mode=%s', this.phone, requiresPairing ? 'fresh-pairing' : 'stored-auth')
    if (this.config.useRedis) {
      await statusRecipients.loadOrBootstrap(this.phone).catch((error) => {
        logger.warn(error as any, 'Zapo status recipient bootstrap failed for %s', this.phone)
      })
    }

    const proxy = createZapoProxyOptions(this.config.proxyUrl, undefined, {
      network: ZAPO_NETWORK_IP_FAMILY,
      chatSocket: ZAPO_CHAT_SOCKET_IP_FAMILY,
      mediaUpload: ZAPO_MEDIA_UPLOAD_IP_FAMILY,
      mediaDownload: ZAPO_MEDIA_DOWNLOAD_IP_FAMILY,
      linkPreview: ZAPO_LINK_PREVIEW_IP_FAMILY,
    })
    const youtubeLinkPreviewResolver = createYouTubeLinkPreviewResolverForTransport(proxy?.linkPreview)
    const client = this.clientFactory({
      store: zapoStore,
      sessionId: this.phone,
      proxy,
      markOnlineOnConnect: this.config.markOnlineOnConnect,
      recoverFromClientTooOld: true,
      history: {
        // Zapo hydrates LID mappings, privacy tokens and nctSalt from history
        // even when Uno must not forward historical messages to webhooks.
        enabled: true,
        // WhatsApp only honors this flag during registration/pairing. Imported
        // credentials use the login payload and cannot request an initial sync.
        requireFullSync: requiresPairing,
      },
      addons: { autoDecrypt: false },
      media: zapoMediaOptions,
      signPasskeyAssertion: this.signPasskeyAssertion.bind(this),
      plugins: [voipPlugin({ maxConcurrentCalls: VOIP_MAX_CONCURRENT_CALLS, logLevel: 'debug' })],
    })
    const generation = ++this.connectionGeneration
    const voiceBridgeUrl = resolveZapoVoiceBridgeUrl(VOIP_SERVICE_URL, VOIP_BRIDGE_URL)
    this.voiceBridge =
      voiceBridgeUrl && VOIP_SERVICE_TOKEN
        ? new ZapoVoiceBridgeClient({
            session: this.phone.replace(/\D/g, ''),
            url: voiceBridgeUrl,
            token: VOIP_SERVICE_TOKEN,
            serverId: UNOAPI_SERVER_NAME,
            workerId: `${UNOAPI_SERVER_NAME}:${process.pid}`,
            generation,
            maxConcurrentCalls: VOIP_MAX_CONCURRENT_CALLS,
            adapter: new ZapoVoiceAdapter(client.voip),
          })
        : undefined
    this.socket = client
    this.socketAbort = new AbortController()
    this.messages = new ZapoMessages(client, this.unoStore.dataStore, {
      customMessageCharactersFunction: this.config.customMessageCharactersFunction,
      composingMessage: this.config.composingMessage,
      readOnReply: this.config.readOnReply,
      store: this.zapoSession,
      phone: this.phone,
      bindTemplate: (payload) => new Template(this.getConfig).bind(this.phone, payload.template.name, payload.template.components),
      youtubeLinkPreviewResolver,
    })
    this.groups = new ZapoGroups(client, this.zapoSession, this.phone)
    this.catalog = new ZapoCatalog(client, this.unoStore, this.phone)
    this.profilePictures = new ZapoProfilePictures({
      phone: this.phone,
      client,
      session: this.zapoSession,
      store: this.unoStore,
      enabled: this.config.sendProfilePicture,
    })
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
    this.bindEvents(client, resolvePrompt, generation)
    const socketConnect = client.connect().catch(async (error) => {
      await this.handleConnectionFailure(client, error)
      if (!promptResolved) throw error
    })
    try {
      await zapoOperationDeadline(
        Promise.race([socketConnect, prompt]), 60_000,
        this.socketAbort.signal, 'zapo_connection_prompt_timeout',
      )
    } catch (error) {
      if (this.socket === client && !this.intentionalDisconnect) {
        await this.handleConnectionFailure(client, error)
        // Invalidate callbacks before closing a timed-out library operation.
        void Promise.resolve(client.disconnect()).catch(() => undefined)
      }
      throw error
    }
  }

  async disconnect() {
    this.presenceHeartbeat.stop()
    this.intentionalDisconnect = true
    this.socketAbort.abort()
    const pendingConnect = this.connectTask
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectAttempts = 0
    this.connected = false
    this.voiceBridge?.stop('intentional_disconnect')
    this.voiceBridge = undefined
    this.pendingPasskey?.reject(new SendError(409, 'zapo_passkey_connection_disconnected'))
    const socket = this.socket
    this.connectionGeneration += 1
    this.socket = undefined
    this.messages = undefined
    this.groups = undefined
    this.profilePictures = undefined
    this.catalog = undefined
    this.pairingCodeRequest = undefined
    this.pairingCodeIssued = false
    this.pendingIncoming.clear()
    this.decryptedAddonIds.clear()
    this.forwardedHistoryIds.clear()
    try {
      if (socket) await zapoOperationDeadline(
        Promise.resolve(socket.disconnect()), 10_000,
        new AbortController().signal, 'zapo_disconnect_timeout',
      )
    } finally {
      await pendingConnect?.catch(() => undefined)
      clients.delete(this.phone)
      configs.delete(this.phone)
      try {
        await this.unoStore?.sessionStore.setStatus(this.phone, 'offline')
      } finally {
        await this.releaseRuntimeOwnership()
      }
    }
  }

  async logout() {
    this.presenceHeartbeat.stop()
    this.intentionalDisconnect = true
    const socket = this.socket
    try {
      if (socket) await socket.logout()
    } finally {
      await this.disconnect()
    }
  }

  async send(payload: any, options: any) {
    if (!this.messages || !this.connected) throw new SendError(409, 'zapo_client_not_connected')
    return this.messages.send(payload, options)
  }

  async recoverDelivery(payload: any, options: any = {}) {
    if (!this.messages || !this.connected) throw new SendError(409, 'zapo_client_not_connected')
    return this.messages.recoverDelivery(payload, options)
  }

  async sendPasskeyResponse(payload: { credentialId: Buffer; assertionJson: Buffer | string }) {
    const pending = this.pendingPasskey
    if (!pending) throw new SendError(409, 'zapo_passkey_assertion_not_pending')
    pending.resolve({
      credentialId: Uint8Array.from(payload.credentialId),
      webauthnAssertion: Uint8Array.from(Buffer.isBuffer(payload.assertionJson) ? payload.assertionJson : Buffer.from(payload.assertionJson)),
    })
    return { ok: { success: true, bridge_id: pending.bridgeId } }
  }

  async sendPasskeyConfirmation() {
    return { ok: { success: true, provider_managed_confirmation: true } }
  }

  async getMessageMetadata<T>(message: T) {
    const withGroupMetadata = await this.enrichGroupMetadata(message)
    const withCatalog = (await this.catalog?.enrich(withGroupMetadata)) ?? withGroupMetadata
    const enriched = (await this.profilePictures?.enrich(withCatalog)) ?? withCatalog
    if (!this.socket) return enriched
    const value: any = enriched
    const id = `${value?.key?.id || ''}`
    const event = this.pendingIncoming.get(id)
    reviveZapoMediaBinaryFields(value)
    if (this.unoStore?.mediaStore) {
      await normalizeInteractiveMediaForWebhook(this.phone, value, this.unoStore.mediaStore, {
        downloadBytes: async (content) =>
          downloadZapoMediaBytes(this.socket!.message, content, { phone: this.phone, retryContext: { key: value.key } }),
      })
    }
    const content: any = normalizeMessageContent(value?.message)
    const mediaKey = mediaMessageKeys.find((key) => content?.[key])
    if (!mediaKey) return enriched
    const media = content[mediaKey]
    if (`${media?.url || ''}`.startsWith('data:')) return enriched
    const bytes = await downloadZapoMediaBytes(this.socket.message, content, {
      phone: this.phone,
      retryContext: { key: event?.key || value.key },
    })
    value.__unoapiMediaBytes = Buffer.from(bytes)
    return enriched
  }

  async contacts(numbers: string[]): Promise<Contact[]> {
    if (!this.socket || !this.zapoSession) throw new SendError(409, 'zapo_client_not_connected')
    const output: Contact[] = new Array(numbers.length)
    const numeric = numbers.map((value, index) => ({ value: `${value || ''}`.trim(), index })).filter(({ value }) => !value.startsWith('@'))
    const usernames = numbers.map((value, index) => ({ value: `${value || ''}`.trim(), index })).filter(({ value }) => value.startsWith('@'))
    for (const { value, index } of usernames) {
      const normalizedUsername = value
        .replace(/^@/, '')
        .replace(/:\d{4}$/, '')
        .toLowerCase()
      let lid = await zapoUsernameIndex.resolve(this.phone, normalizedUsername)
      let resolvedUsername = normalizedUsername
      if (!lid) {
        try {
          const resolved = await this.socket.profile.resolveUsername({ username: value })
          if (resolved.status === 'found' && `${resolved.jid}`.endsWith('@lid')) {
            lid = resolved.jid
            resolvedUsername = `${resolved.username || normalizedUsername}`
            await zapoUsernameIndex.touch(this.phone, resolvedUsername, lid)
            const stored = await this.zapoSession.contacts.getByJid(lid)
            await this.zapoSession.contacts.upsert({
              ...(stored || { jid: lid }),
              jid: lid,
              lid,
              username: resolvedUsername,
              ...(resolved.pnJid ? { phoneNumber: resolved.pnJid.split('@')[0] } : {}),
              lastUpdatedMs: Date.now(),
            })
          }
        } catch (error) {
          logger.warn(error as any, 'Zapo username lookup failed phone=%s username=%s', this.phone, normalizedUsername)
        }
      }
      const stored = lid ? await this.zapoSession.contacts.getByJid(lid) : undefined
      output[index] = {
        input: numbers[index],
        wa_id: stored?.phoneNumber,
        user_id: lid,
        username: resolvedUsername,
        display_name: stored?.displayName,
        push_name: stored?.pushName,
        status: lid ? 'valid' : 'failed',
      }
    }
    const resolutions = numeric.length
      ? await new ZapoContactIdentityResolver(this.socket, this.zapoSession.contacts).resolveMany(numeric.map(({ value }) => value))
      : []
    for (let resultIndex = 0; resultIndex < resolutions.length; resultIndex += 1) {
      const result = resolutions[resultIndex]
      const index = numeric[resultIndex].index
      const stored = result.stored || (result.lid_jid ? await this.zapoSession.contacts.getByJid(result.lid_jid) : undefined)
      const username = `${(stored as any)?.username || ''}`.trim()
        || (result.lid_jid ? await zapoUsernameIndex.resolveByLid(this.phone, result.lid_jid, Date.now(), !this.config.useRedis) : undefined)
      output[index] = {
        input: numbers[index],
        wa_id: result.status === 'valid' ? result.public_phone_number : undefined,
        user_id: result.status === 'valid' ? result.lid_jid : undefined,
        display_name: stored?.displayName,
        push_name: stored?.pushName,
        username: username || undefined,
        status: result.status,
      }
    }
    return output
  }

  async saveContact(input: SaveContactInput) {
    if (!this.socket || !this.zapoSession) throw new SendError(409, 'zapo_client_not_connected')
    return new ZapoContactBook(
      this.socket,
      this.zapoSession,
      this.phone,
      async (phoneJid, lidJid) => {
        await this.unoStore?.dataStore.setJidMapping?.(this.phone, phoneJid, lidJid)
      },
      async (phoneJid, lidJid) => {
        await this.unoStore?.dataStore.removeJidMapping?.(this.phone, phoneJid, lidJid)
      },
    ).save(input)
  }

  async requestPairingCode() {
    if (!this.socket) throw new SendError(409, 'zapo_client_not_connected')
    const request = this.beginPairingCodeRequest(this.socket, true)
    if (!request) throw new SendError(409, 'zapo_pairing_code_request_unavailable')
    return request
  }

  groupCreate(subject: string, participants: string[]) {
    return this.requireGroups().create(subject, participants)
  }
  groupUpdateSubject(jid: string, subject: string) {
    return this.requireGroups().updateSubject(jid, subject)
  }
  groupUpdateDescription(jid: string, description?: string) {
    return this.requireGroups().updateDescription(jid, description)
  }
  groupUpdatePicture(jid: string, pictureUrl: string) {
    return this.requireGroups().updatePicture(jid, pictureUrl)
  }
  async groupParticipantsUpdate(jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') {
    return [...(await this.requireGroups().updateParticipants(jid, participants, action))] as any[]
  }
  groupInviteCode(jid: string) {
    return this.requireGroups().inviteCode(jid)
  }
  groupRevokeInvite(jid: string) {
    return this.requireGroups().revokeInvite(jid)
  }
  async groupRequestParticipantsList(jid: string) {
    return [...(await this.requireGroups().joinRequests(jid))] as any[]
  }
  groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject') {
    return this.requireGroups().updateJoinRequests(jid, participants, action)
  }
  groupLeave(jid: string) {
    return this.requireGroups().leave(jid)
  }
  groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') {
    return this.requireGroups().updateSetting(jid, setting)
  }
  groupJoinApprovalMode(jid: string, mode: 'on' | 'off') {
    return this.requireGroups().updateJoinApprovalMode(jid, mode)
  }
  groupMetadata(jid: string) {
    return this.requireGroups().metadata(jid)
  }
  async groupProfilePicture(jid: string, forceRefresh = false) {
    return this.profilePictures?.get(jid, forceRefresh)
  }

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
    if (!this.socket || !this.zapoSession) throw new SendError(409, 'zapo_client_not_connected')
    if (payload.replay_stored || payload.replayStored) {
      const forceReplay = !!(payload.force_replay || payload.forceReplay)
      const days = payload.days ?? this.config.historyMaxAgeDays
      const task = this.historySyncTask.then(() => this.forwardStoredHistory(days, forceReplay))
      this.historySyncTask = task.then(
        () => undefined,
        () => undefined,
      )
      return { forwarded: await task }
    }
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
