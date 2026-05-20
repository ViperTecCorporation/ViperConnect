import { GroupMetadata, WAMessage, proto, delay, isJidGroup, jidNormalizedUser, AnyMessageContent, isLidUser, WAMessageAddressingMode, isPnUser, encodeBinaryNode, decodeBinaryNode } from '@whiskeysockets/baileys'
import type { BinaryNode } from '@whiskeysockets/baileys'
import fetch, { Response as FetchResponse } from 'node-fetch'
import { Listener } from './listener'
import { Store } from './store'
import {
  connect,
  sendMessage,
  readMessages,
  rejectCall,
  sendCallNode,
  fetchTcToken,
  decryptVoipEnc,
  groupCreate,
  groupUpdateSubject,
  groupUpdateDescription,
  groupUpdatePicture,
  groupParticipantsUpdate,
  groupInviteCode,
  groupRequestParticipantsList,
  groupRequestParticipantsUpdate,
  groupLeave,
  groupSettingUpdate,
  groupJoinApprovalMode,
  groupMetadata,
  OnQrCode,
  OnNotification,
  OnNewLogin,
  fetchImageUrl,
  fetchGroupMetadata,
  exists,
  logout,
  close,
  OnReconnect,
} from './socket'
import { Client, getClient, clients, Contact } from './client'
import { Config, configs, defaultConfig, getConfig, getMessageMetadataDefault } from './config'
import { toBaileysMessageContent, phoneNumberToJid, jidToPhoneNumber, getMessageType, TYPE_MESSAGES_TO_READ, TYPE_MESSAGES_MEDIA, ensurePn, jidToRawPhoneNumber, normalizeTransportJid, normalizeMessageContent, normalizeGroupId } from './transformer'
import { v1 as uuid } from 'uuid'
import { Response } from './response'
import QRCode from 'qrcode'
import { Template } from './template'
import logger from './logger'
import { FETCH_TIMEOUT_MS, VALIDATE_MEDIA_LINK_BEFORE_SEND, CONVERT_AUDIO_MESSAGE_TO_OGG, HISTORY_MAX_AGE_DAYS, GROUP_SEND_MEMBERSHIP_CHECK, GROUP_SEND_ADDRESSING_MODE, GROUP_LARGE_THRESHOLD, ONE_TO_ONE_ADDRESSING_MODE, MEDIA_RETRY_ENABLED, MEDIA_RETRY_DELAYS_MS, UNOAPI_DEBUG_BAILEYS_LIST_DUMP, CONTACT_SYNC_PENDING_TTL_SEC, GROUP_METADATA_EVENT_REFRESH_ENABLED, GROUP_METADATA_EVENT_REFRESH_DEBOUNCE_MS, GROUP_METADATA_EVENT_REFRESH_MIN_INTERVAL_MS } from '../defaults'
import { setContactSyncPending, getPnForLidFromAuthCache, getLidForPnFromAuthCache } from './redis'
import { normalizeLidJid } from './transformer/jid'
import { convertToOggPtt } from '../utils/audio_convert'
import { convertToWebpSticker } from '../utils/sticker_convert'
import { t } from '../i18n'
import { ClientForward } from './client_forward'
import { ClientCoexistence } from './client_coexistence'
import { SendError } from './send_error'
import { getRetryableStaleSendPayload, isRetryableStaleSendError } from './error_utils'
import { drainVoipCommands, extractVoipCommands, mapBaileysCallStatusToVoipEvent, sendVoipCallEvent, sendVoipSignaling, VoipCommand } from './client_voip'
import { binaryNodeToXml, decompressWapFrameIfRequired, extractFirstChildDecompressedWapSlice, getBinaryNodeChildrenSafe, parseVoipXmlFragment, parseVoipXmlNode } from './voip_xml'

const attempts = 3
const pendingClients: Map<string, Promise<Client>> = new Map()

export const normalizeOutgoingVoipCallChild = (node: BinaryNode, targetJid: string): BinaryNode => {
  if (!node?.attrs || !targetJid.endsWith('@lid')) return node
  const targetPnJid = targetJid.replace(/@lid$/i, '@s.whatsapp.net')
  let changed = false
  const attrs = Object.fromEntries(Object.entries(node.attrs).map(([key, value]) => {
    const normalizedValue = `${value || ''}`.trim() === targetPnJid ? targetJid : value
    if (normalizedValue !== value) changed = true
    return [key, normalizedValue]
  }))
  if (!changed) return node
  return {
    ...node,
    attrs,
  }
}

const sanitizeMessageEditKey = (key: any) => {
  const sanitized: any = {
    id: key.id,
    remoteJid: key.remoteJid,
    fromMe: !!key.fromMe,
  }

  if (!sanitized.fromMe && typeof key.participant === 'string' && key.participant.trim()) {
    sanitized.participant = key.participant
  }

  return sanitized
}

const getBrNinthDigitVariants = (digits: string) => {
  const raw = `${digits || ''}`.replace(/\D/g, '')
  if (!raw.startsWith('55') || (raw.length !== 12 && raw.length !== 13)) return []
  const to12 = (() => {
    if (raw.length === 12) return raw
    const ddd = raw.slice(2, 4)
    const local9 = raw.slice(4)
    return `55${ddd}${local9.slice(1)}`
  })()
  const to13 = (() => {
    if (raw.length === 13) return raw
    const ddd = raw.slice(2, 4)
    const local = raw.slice(4)
    return /[6-9]/.test(local[0]) ? `55${ddd}9${local}` : raw
  })()
  return Array.from(new Set([to12, to13]))
}

const formatVcardPhoneLikeOriginal = (original: string, digits: string) => {
  const clean = `${digits || ''}`.replace(/\D/g, '')
  if (!clean) return original
  return `${original || ''}`.trim().startsWith('+') ? `+${clean}` : clean
}

interface Delay {
  (phone: string, to: string): Promise<void>
}

const delays: Map<string, Map<string, Delay>> = new Map()

export const getClientBaileys: getClient = async ({
  phone,
  listener,
  getConfig,
  onNewLogin,
}: {
  phone: string
  listener: Listener
  getConfig: getConfig
  onNewLogin: OnNewLogin
}): Promise<Client> => {
  if (pendingClients.has(phone)) {
    logger.warn('Awaiting pending client creation %s', phone)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return pendingClients.get(phone)!
  }
  if (!clients.has(phone)) {
    const createPromise = (async () => {
      logger.info('Creating client baileys %s', phone)
      const config = await getConfig(phone)
      let client
      if (config.coexistenceEnabled) {
        logger.info('Connecting client coexistence (web+meta) %s', phone)
        client = new ClientCoexistence(phone, listener, getConfig, onNewLogin)
      } else if (config.connectionType == 'forward') {
        logger.info('Connecting client forward %s', phone)
        client = new ClientForward(phone, getConfig, listener)
      } else {
        logger.info('Connecting client baileys %s', phone)
        client = new ClientBaileys(phone, listener, getConfig, onNewLogin)
      }
      if (config.autoConnect) {
        logger.info('Connecting client %s', phone)
        await client.connect(1)
        logger.info('Created and connected client %s', phone)
      } else {
        logger.info('Config client to not auto connect %s', phone)
      }
      clients.set(phone, client)
      return client as Client
    })()
    pendingClients.set(phone, createPromise)
    try {
      return await createPromise
    } finally {
      pendingClients.delete(phone)
    }
  } else {
    logger.debug('Retrieving client baileys %s', phone)
  }
  return clients.get(phone) as Client
}

const sendError = new SendError(15, t('reloaded_session'))

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const readMessagesDefault: readMessages = async (_keys) => {
  throw sendError
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const rejectCallDefault: rejectCall = async (_keys) => {
  throw sendError
}

const sendCallNodeDefault: sendCallNode = async (_node) => {
  throw sendError
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fetchTcTokenDefault: fetchTcToken = async (_jids) => undefined
const decryptVoipEncDefault: decryptVoipEnc = async (_node, _jids) => undefined

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fetchImageUrlDefault: fetchImageUrl = async (_jid: string) => ''

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fetchGroupMetadataDefault: fetchGroupMetadata = async (_jid: string) => {
  throw sendError
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const groupMetadataDefault: groupMetadata = async (_jid: string) => {
  throw sendError
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const existsDefault: exists = async (_jid: string) => {
  throw sendError
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logoutDefault: logout = async () => {}

const closeDefault = async () => logger.info(`Close connection`)
const groupUnavailable = async () => { throw new Error('group management unavailable') }

const buildSendOkResponse = (to: string, keyId: string) => {
  const target = `${to || ''}`.trim()
  const waId = target.endsWith('@g.us') ? target : jidToPhoneNumber(target, '')
  return {
    messaging_product: 'whatsapp',
    contacts: [
      {
        input: target,
        wa_id: waId,
      },
    ],
    messages: [
      {
        id: keyId,
      },
    ],
  }
}

export class ClientBaileys implements Client {
  private voipPipelines = new Map<string, Promise<void>>()
  private voipCommandDrainPollers = new Map<string, Promise<void>>()

  private async resolveContactCardPn(digits: string): Promise<string | undefined> {
    const variants = getBrNinthDigitVariants(digits)
    for (const variant of variants) {
      const pnJid = `${variant}@s.whatsapp.net`
      try {
        const authLid = await getLidForPnFromAuthCache(this.phone, pnJid)
        if (authLid) return variant
      } catch {}
    }
    return undefined
  }

  private async normalizeContactVcard(vcard: string): Promise<string> {
    const lines = `${vcard || ''}`.split(/\r\n|\n|\r/)
    let changed = false
    const normalized: string[] = []
    for (const line of lines) {
      if (!/^TEL(?:;|:)/i.test(line)) {
        normalized.push(line)
        continue
      }
      const colon = line.indexOf(':')
      if (colon < 0) {
        normalized.push(line)
        continue
      }
      const paramsPart = line.slice(0, colon)
      const valuePart = line.slice(colon + 1)
      const waidMatch = paramsPart.match(/(?:^|;)WAID=([^;:]+)/i)
      const rawDigits = `${waidMatch?.[1] || valuePart}`.replace(/\D/g, '')
      const resolved = await this.resolveContactCardPn(rawDigits)
      if (!resolved || resolved === rawDigits) {
        normalized.push(line)
        continue
      }
      let nextParams = paramsPart
      if (waidMatch) {
        nextParams = nextParams.replace(/WAID=[^;:]*/i, `WAID=${resolved}`)
      } else {
        nextParams = `${nextParams};WAID=${resolved}`
      }
      const nextValue = formatVcardPhoneLikeOriginal(valuePart, resolved)
      normalized.push(`${nextParams}:${nextValue}`)
      changed = true
      logger.warn('CONTACT_VCARD_AUTH_CANONICAL: normalized %s -> %s via auth cache', rawDigits, resolved)
    }
    return changed ? normalized.join('\r\n') : vcard
  }

  private async normalizeContactCardsForAuthCache(content: any) {
    const cards = content?.contacts?.contacts
    if (!Array.isArray(cards)) return
    for (const card of cards) {
      if (typeof card?.vcard !== 'string') continue
      card.vcard = await this.normalizeContactVcard(card.vcard)
    }
  }

  private async enqueueVoipByCall<T>(callId: string, task: () => Promise<T>): Promise<T> {
    const key = `${this.phone}:${callId}`
    const previous = this.voipPipelines.get(key) || Promise.resolve()
    let current: Promise<T>
    current = previous.catch(() => undefined).then(task)
    const settled = current.then(() => undefined, () => undefined)
    this.voipPipelines.set(key, settled)
    try {
      return await current
    } finally {
      if (this.voipPipelines.get(key) === settled) {
        this.voipPipelines.delete(key)
      }
    }
  }

  private async processVoipCommands(commands: VoipCommand[]) {
    for (const command of commands || []) {
      if (!command) continue
      if (command.action !== 'send_call_node') {
        logger.warn(
          {
            session: this.phone,
            callId: command.callId,
            action: command.action,
            eventSummary: command.action === 'voip_event' ? this.summarizeVoipEventCommand(command) : undefined,
          },
          command.action === 'voip_event' ? 'VOIP wasm event observed from service' : 'VOIP command skipped'
        )
        continue
      }
      try {
        const payloadBuffer = Buffer.from(command.payloadBase64 || '', 'base64')
        const storedNetworkPeerJid = `${this.voipNetworkPeerByCallId.get(command.callId) || ''}`.trim()
        const networkPeerJid = storedNetworkPeerJid || command.peerJid
        const commandPeerJid = `${command.peerJid || ''}`.trim()
        const isCallPeer = (jid: string) => /@(s\.whatsapp\.net|lid)$/i.test(jid)
        const outgoingTargets = Array.from(new Set([storedNetworkPeerJid || commandPeerJid || networkPeerJid].filter(isCallPeer)))
        if (!outgoingTargets.length && networkPeerJid) outgoingTargets.push(networkPeerJid)
        try {
          const decoded = await decodeBinaryNode(payloadBuffer)
          if (decoded?.tag === 'call') {
            const firstChild = Array.isArray(decoded.content) ? decoded.content.find(child => typeof child === 'object') : undefined
            logger.info(
              {
                session: this.phone,
                callId: command.callId,
                to: decoded.attrs?.to,
                from: decoded.attrs?.from,
                childTag: firstChild?.tag,
                childAttrs: firstChild?.attrs,
              },
              'VOIP sending decoded call node'
            )
            await this.sendVoipCallNodeWithAck(decoded, command.callId, firstChild?.tag)
            logger.info({ session: this.phone, callId: command.callId, to: decoded.attrs?.to }, 'VOIP decoded call node sent')
            continue
          }
          if (decoded?.tag) {
            for (const targetJid of outgoingTargets) {
              const outgoingChild = normalizeOutgoingVoipCallChild(decoded, targetJid)
              const node = {
                tag: command.payloadTag || 'call',
                attrs: {
                  from: `${this.store?.state?.creds?.me?.id || ''}`.trim(),
                  to: targetJid,
                },
                content: [outgoingChild],
              }
              logger.info(
                {
                  session: this.phone,
                  callId: command.callId,
                  to: node.attrs.to,
                  from: node.attrs.from,
                  childTag: outgoingChild?.tag,
                  childAttrs: outgoingChild?.attrs,
                },
                'VOIP sending wrapped decoded call node'
              )
              logger.warn(
                {
                  session: this.phone,
                  callId: command.callId,
                  to: node.attrs.to,
                  childTag: outgoingChild?.tag,
                  childAttrs: outgoingChild?.attrs,
                },
                'VOIP call command send visible'
              )
              await this.sendVoipCallNodeWithAck(node, command.callId, outgoingChild?.tag)
              logger.info({ session: this.phone, callId: command.callId, to: node.attrs.to }, 'VOIP wrapped decoded call node sent')
            }
            continue
          }
        } catch {}

        const xml = payloadBuffer.toString('utf8').trim()
        const parsed = parseVoipXmlNode(xml)
        if (parsed?.tag === 'call') {
          const firstChild = Array.isArray(parsed.content) ? parsed.content.find(child => typeof child === 'object') : undefined
          logger.info(
            {
              session: this.phone,
              callId: command.callId,
              to: parsed.attrs?.to,
              from: parsed.attrs?.from,
              childTag: firstChild?.tag,
              childAttrs: firstChild?.attrs,
            },
            'VOIP sending parsed call node'
          )
          await this.sendVoipCallNodeWithAck(parsed, command.callId, firstChild?.tag)
          logger.info({ session: this.phone, callId: command.callId, to: parsed.attrs?.to }, 'VOIP parsed call node sent')
          continue
        }

        const children = parseVoipXmlFragment(xml)
        if (!children.length) {
          logger.warn(
            {
              session: this.phone,
              callId: command.callId,
              peerJid: command.peerJid,
              payloadTag: command.payloadTag,
              payloadChildTag: command.payloadChildTag,
              payloadBytes: payloadBuffer.byteLength,
              payloadPreview: xml.slice(0, 120),
            },
            'voip command without parsable call payload'
          )
          continue
        }
        for (const targetJid of outgoingTargets) {
          const outgoingChildren = children.map(child => normalizeOutgoingVoipCallChild(child, targetJid))
          const node: BinaryNode = {
            tag: command.payloadTag || 'call',
            attrs: {
              from: `${this.store?.state?.creds?.me?.id || ''}`.trim(),
              to: targetJid,
            },
            content: outgoingChildren,
          }
          const firstChild = outgoingChildren.find(child => typeof child === 'object')
          logger.info(
            {
              session: this.phone,
              callId: command.callId,
              to: node.attrs.to,
              from: node.attrs.from,
              childTag: firstChild?.tag,
              childAttrs: firstChild?.attrs,
            },
            'VOIP sending wrapped parsed call node'
          )
          logger.warn(
            {
              session: this.phone,
              callId: command.callId,
              to: node.attrs.to,
              childTag: firstChild?.tag,
              childAttrs: firstChild?.attrs,
            },
            'VOIP call command send visible'
          )
          await this.sendVoipCallNodeWithAck(node, command.callId, firstChild?.tag)
          logger.info({ session: this.phone, callId: command.callId, to: node.attrs.to }, 'VOIP wrapped parsed call node sent')
        }
      } catch (error) {
        logger.warn(error as any, 'failed to process voip command for %s', this.phone)
      }
    }
  }

  private async sendVoipCallNodeWithAck(node: BinaryNode, callId: string, childTag?: string) {
    const ack = await this.sendCallNode(node)
    if (!ack) return

    const peerJid = `${node?.attrs?.to || ''}`.trim()
    if (!peerJid) return

    try {
      logger.warn(
        {
          session: this.phone,
          callId,
          peerJid,
          childTag,
          ackTag: ack.tag,
          ackAttrs: ack.attrs,
        },
        'VOIP forwarding call node ack to voip service'
      )
      const tcTokenBase64 = await this.fetchTcToken([peerJid])
      const selfIdentity = this.getVoipSelfIdentity()
      const response = await this.enqueueVoipByCall(callId, async () => sendVoipSignaling(this.config, {
        session: this.phone,
        callId,
        peerJid,
        selfJid: selfIdentity.selfJid,
        selfLid: selfIdentity.selfLid,
        msgType: 'ack',
        payload: binaryNodeToXml(ack),
        payloadBase64: Buffer.from(encodeBinaryNode(ack)).toString('base64'),
        tcTokenBase64,
        payloadEncoding: 'wa_binary',
        attrs: {
          error: `${ack.attrs?.error || '0'}`,
          type: `${ack.attrs?.type || childTag || 'ack'}`,
        },
      }))
      const commands = extractVoipCommands(response.body)
      if (commands.length) {
        logger.warn(
          {
            session: this.phone,
            callId,
            peerJid,
            commandCount: commands.length,
            commandActions: commands.map(command => command?.action).filter(Boolean),
          },
          'VOIP call node ack produced commands'
        )
        await this.processVoipCommands(commands)
      }
    } catch (error) {
      logger.warn({ err: error, session: this.phone, callId, peerJid }, 'failed to forward voip call node ack')
    }
  }

  private async drainAndProcessVoipCommands(callId: string, attempt: number, source: string) {
    const response = await this.enqueueVoipByCall(callId, async () => drainVoipCommands(this.config, this.phone, callId))
    const commands = extractVoipCommands(response.body)
    const commandActions = commands.map(command => command?.action).filter(Boolean)
    const commandTags = commands.map(command => command?.action === 'send_call_node' ? command.payloadChildTag || command.payloadTag : command?.action).filter(Boolean)
    const drainLog = {
      phone: this.phone,
      callId,
      ok: response.ok,
      status: response.status,
      reason: response.reason,
      bodyKeys: response.body && typeof response.body === 'object' ? Object.keys(response.body as Record<string, unknown>) : [],
      commandCount: commands.length,
      commandActions,
      commandTags,
      attempt,
      source,
    }
    if (commands.length) logger.warn(drainLog, 'VOIP async command drain polled')
    else logger.info(drainLog, 'VOIP async command drain polled')
    if (!commands.length) return 0

    logger.info({ phone: this.phone, callId, commandCount: commands.length, commandActions, attempt, source }, 'VOIP async commands drained')
    await this.processVoipCommands(commands)
    return commands.length
  }

  private scheduleVoipCommandDrain(callId: string) {
    const key = `${this.phone}:${callId}`
    if (this.voipCommandDrainPollers.has(key)) return

    const poller = (async () => {
      const maxAttempts = 60
      const intervalMs = 1000
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await delay(intervalMs)
        await this.drainAndProcessVoipCommands(callId, attempt, 'poll')
      }
      logger.info({ phone: this.phone, callId, attempts: maxAttempts }, 'VOIP async command drain finished without commands')
    })().catch(error => {
      logger.warn(error as any, 'failed to poll voip async commands for %s', this.phone)
    }).finally(() => {
      this.voipCommandDrainPollers.delete(key)
    })

    this.voipCommandDrainPollers.set(key, poller)
  }

  private getVoipSelfIdentity() {
    const me = (this.store as any)?.state?.creds?.me || {}
    return {
      selfJid: typeof me.id === 'string' && me.id ? me.id : undefined,
      selfLid: typeof me.lid === 'string' && me.lid ? me.lid : undefined,
    }
  }

  private summarizeVoipEventCommand(command: VoipCommand) {
    if (command.action !== 'voip_event') return undefined
    if (!command.eventData) return { eventType: command.eventType, hasEventData: false }
    try {
      const parsed = JSON.parse(command.eventData)
      const callInfo = parsed?.call_info || parsed?.callInfo || {}
      return {
        eventType: command.eventType,
        callId: parsed?.callId || parsed?.call_id || callInfo?.call_id || command.callId,
        callState: callInfo?.call_state || parsed?.call_state,
        callResult: callInfo?.call_result || parsed?.call_result,
        callSetupErrorType: callInfo?.call_setup_error_type || parsed?.call_setup_error_type,
        reasonCode: parsed?.reason_code || callInfo?.reason_code,
        bytesReceived: callInfo?.bytes_received,
        bytesSent: callInfo?.bytes_sent,
        relayRtt: callInfo?.relay_rtt,
      }
    } catch {
      return {
        eventType: command.eventType,
        parseError: true,
        eventDataPreview: `${command.eventData}`.slice(0, 500),
      }
    }
  }

  private async forwardVoipSignalingNode(node: BinaryNode) {
    try {
      const children = getBinaryNodeChildrenSafe(node)
      const infoChild = children?.[0]
      if (!infoChild) return
      const callId = `${infoChild.attrs?.['call-id'] || ''}`.trim()
      const callCreator = `${infoChild.attrs?.['call-creator'] || ''}`.trim()
      const callCreatorPeerJid = callCreator.replace(/@lid$/i, '@s.whatsapp.net')
      const rawPeerJid = `${infoChild.tag === 'offer'
        ? infoChild.attrs?.participant || node.attrs?.participant || callCreatorPeerJid || node.attrs?.from || infoChild.attrs?.caller_pn
        : infoChild.attrs?.from || infoChild.attrs?.participant || node.attrs?.participant || callCreator || node.attrs?.from || ''
      }`.trim()
      const networkPeerJid = `${node.attrs?.from || infoChild.attrs?.participant || node.attrs?.participant || callCreator || rawPeerJid}`.trim()
      const storedPeerJid = callId ? this.voipPeerByCallId.get(callId) : undefined
      const isCallPeer = (jid: string) => /@(s\.whatsapp\.net|lid)$/i.test(jid)
      const peerJid = isCallPeer(networkPeerJid)
        ? networkPeerJid
        : (infoChild.tag === 'offer' ? rawPeerJid : (storedPeerJid || rawPeerJid))
      if (!callId || !peerJid) return
      if (infoChild.tag === 'offer') {
        this.voipPeerByCallId.set(callId, peerJid)
        if (networkPeerJid) this.voipNetworkPeerByCallId.set(callId, networkPeerJid)
      }
      logger.info({
        phone: this.phone,
        callId,
        msgType: infoChild.tag,
        rawPeerJid,
        networkPeerJid,
        storedPeerJid,
        peerJid,
      }, 'VOIP route peer selected')
      const infoChildren = getBinaryNodeChildrenSafe(infoChild)
      const encChild = infoChildren.find((child) => child?.tag === 'enc')
      const audioChild = infoChildren.find((child) => child?.tag === 'audio')
      const capabilityChild = infoChildren.find((child) => child?.tag === 'capability')
      const metadataChild = infoChildren.find((child) => child?.tag === 'metadata')
      const encoptChild = infoChildren.find((child) => child?.tag === 'encopt')
      const encContent = encChild?.content
      const encCtor = encContent && typeof encContent === 'object' ? (encContent as any)?.constructor?.name : typeof encContent
      let encBytes: Buffer | undefined
      if (encContent && Buffer.isBuffer(encContent)) {
        encBytes = Buffer.from(encContent)
      } else if (encContent instanceof Uint8Array) {
        encBytes = Buffer.from(encContent)
      } else if (typeof encContent === 'string') {
        encBytes = Buffer.from(encContent, 'binary')
      }
      if (infoChild.tag === 'offer') {
        try {
          logger.info(
            {
              phone: this.phone,
              callId,
              peerJid,
              rootAttrs: node.attrs || {},
              offerAttrs: infoChild.attrs || {},
              offerChildTags: infoChildren.map((child) => child?.tag).filter(Boolean),
              audioAttrs: audioChild?.attrs || {},
              capabilityAttrs: capabilityChild?.attrs || {},
              metadataAttrs: metadataChild?.attrs || {},
              encoptAttrs: encoptChild?.attrs || {},
              encAttrsExpanded: encChild?.attrs || {},
            },
            'VOIP offer tree diagnostics'
          )
        } catch {}
      }
      try {
        logger.info(
          {
            phone: this.phone,
            callId,
            msgType: infoChild.tag,
            peerJid,
            outerTag: node.tag,
            encTag: encChild?.tag,
            encCtor,
            encLength: typeof encContent === 'string'
              ? encContent.length
              : encBytes?.byteLength,
            encPreviewHex: encBytes?.subarray(0, 24).toString('hex'),
            encPreviewBase64: encBytes?.subarray(0, 24).toString('base64'),
          },
          'VOIP raw signaling payload diagnostics'
        )
      } catch {}
      let signalingPayloadBase64 = ''
      let payloadStrategy = 'enc_raw'
      let rawCallRootWapBytes: Buffer | undefined
      const originalInfoBytes = encodeBinaryNode(infoChild)
      let rawCallOfferRootMinimalWapBytes: Buffer | undefined
      let rawCallOfferRootEnrichedWapBytes: Buffer | undefined
      let rawCallOfferRootPrunedWapBytes: Buffer | undefined
      let rawCallOfferRootNoEncoptWapBytes: Buffer | undefined
      let rawCallOfferRootNoMetadataWapBytes: Buffer | undefined
      let rawCallOfferRootNoEncoptNoMetadataWapBytes: Buffer | undefined
      let rawCallOfferRootNoRelayWapBytes: Buffer | undefined
      let rawCallOfferRootNoNetWapBytes: Buffer | undefined
      let rawCallOfferRootNoRteWapBytes: Buffer | undefined
      let rawCallOfferRootCoreRelayWapBytes: Buffer | undefined
      let rawCallOfferRootCallerMetadataWapBytes: Buffer | undefined
      let rawCallOfferRootCreatorDeviceWapBytes: Buffer | undefined
      let rawCallOfferRootCallerMetadataCreatorDeviceWapBytes: Buffer | undefined
      let rawCallOfferRootNoJoinableWapBytes: Buffer | undefined
      let rawCallOfferRootNoCallerPnWapBytes: Buffer | undefined
      let rawCallOfferRootNoCountryCodeWapBytes: Buffer | undefined
      let rawCallOfferRootMinimalAttrsWapBytes: Buffer | undefined
      let rawCallOfferEncWapBytes: Buffer | undefined
      const rawOfferEncBase64 = infoChild.tag === 'offer' && encBytes
        ? encBytes.toString('base64')
        : undefined
      const decryptedOfferNode = infoChild.tag === 'offer' && encBytes
        ? await this.decryptVoipEnc(infoChild, [
          peerJid,
          `${node.attrs?.from || ''}`.trim(),
          `${infoChild.attrs?.['call-creator'] || ''}`.trim(),
          `${infoChild.attrs?.caller_pn || ''}`.trim(),
        ])
        : undefined
      const decryptedOfferBytes = decryptedOfferNode ? encodeBinaryNode(decryptedOfferNode) : undefined
      const offerWapNoPrefixBytes = infoChild.tag === 'offer'
        ? Buffer.from((encodeBinaryNode as any)(infoChild, undefined, []))
        : undefined
      const rawDecryptedCallFrameBase64 = typeof (node as any)?.__unoRawDecryptedFrameBase64 === 'string'
        ? (node as any).__unoRawDecryptedFrameBase64 as string
        : ''
      const rawDecryptedCallFrameBytes = rawDecryptedCallFrameBase64 ? Buffer.from(rawDecryptedCallFrameBase64, 'base64') : undefined
      let rawFirstChildWapBytes: Buffer | undefined
      if (rawDecryptedCallFrameBytes) {
        try {
          rawFirstChildWapBytes = extractFirstChildDecompressedWapSlice(decompressWapFrameIfRequired(rawDecryptedCallFrameBytes))
        } catch (error) {
          logger.warn({ err: error, phone: this.phone, callId, msgType: infoChild.tag }, 'failed to extract raw first child WAP slice')
        }
      }
      let rawOfferChildWapBytes: Buffer | undefined
      if (infoChild.tag === 'offer' && rawFirstChildWapBytes) {
        rawOfferChildWapBytes = rawFirstChildWapBytes
      }
      try {
        logger.info(
          {
            phone: this.phone,
            callId,
            msgType: infoChild.tag,
            originalInfoBytes: originalInfoBytes.byteLength,
            originalInfoPreviewHex: originalInfoBytes.subarray(0, 48).toString('hex'),
            originalInfoPreviewBase64: originalInfoBytes.subarray(0, 48).toString('base64'),
            rawDecryptedCallFrameBytes: rawDecryptedCallFrameBytes?.byteLength,
            rawDecryptedCallFramePreviewHex: rawDecryptedCallFrameBytes?.subarray(0, 48).toString('hex'),
            rawDecryptedCallFramePreviewBase64: rawDecryptedCallFrameBytes?.subarray(0, 48).toString('base64'),
            rawFirstChildWapBytes: rawFirstChildWapBytes?.byteLength,
            rawFirstChildWapPreviewHex: rawFirstChildWapBytes?.subarray(0, 48).toString('hex'),
            rawFirstChildWapPreviewBase64: rawFirstChildWapBytes?.subarray(0, 48).toString('base64'),
          },
          'VOIP signaling binary framing diagnostics'
        )
      } catch {}
      if (infoChild.tag === 'offer' && !rawOfferChildWapBytes && rawDecryptedCallFrameBytes) {
        try {
          logger.warn({ phone: this.phone, callId, msgType: infoChild.tag }, 'raw offer child WAP slice unavailable from decrypted frame')
        } catch {}
      }
      if (infoChild.tag === 'offer') {
        const minimalRootAttrs = Object.fromEntries(
          Object.entries(node.attrs || {}).filter(([key, value]) =>
            ['from', 'id', 't'].includes(key) && typeof value !== 'undefined'
          )
        )
        const enrichedRootAttrs = Object.fromEntries(
          Object.entries(node.attrs || {}).filter(([key, value]) =>
            ['from', 'version', 'platform', 'id', 't'].includes(key) && typeof value !== 'undefined'
          )
        )
        const callOfferRootMinimalNode: BinaryNode = {
          tag: node.tag,
          attrs: minimalRootAttrs,
          content: [infoChild],
        }
        rawCallOfferRootMinimalWapBytes = encodeBinaryNode(callOfferRootMinimalNode)
        const callOfferRootEnrichedNode: BinaryNode = {
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [infoChild],
        }
        rawCallOfferRootEnrichedWapBytes = encodeBinaryNode(callOfferRootEnrichedNode)
        const prunedOfferChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => {
            if (typeof child !== 'object' || !child) return false
            return ['audio', 'capability', 'enc', 'encopt', 'metadata'].includes(child.tag || '')
          })
          : infoChild.content
        const callOfferRootPrunedNode: BinaryNode = {
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: prunedOfferChildren,
          }],
        }
        rawCallOfferRootPrunedWapBytes = encodeBinaryNode(callOfferRootPrunedNode)
        const noEncoptChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => typeof child !== 'object' || !child || child.tag !== 'encopt')
          : infoChild.content
        const noMetadataChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => typeof child !== 'object' || !child || child.tag !== 'metadata')
          : infoChild.content
        const noEncoptNoMetadataChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => typeof child !== 'object' || !child || (child.tag !== 'encopt' && child.tag !== 'metadata'))
          : infoChild.content
        rawCallOfferRootNoEncoptWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: noEncoptChildren,
          }],
        })
        rawCallOfferRootNoMetadataWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: noMetadataChildren,
          }],
        })
        rawCallOfferRootNoEncoptNoMetadataWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: noEncoptNoMetadataChildren,
          }],
        })
        const noRelayChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => typeof child !== 'object' || !child || child.tag !== 'relay')
          : infoChild.content
        const noNetChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => typeof child !== 'object' || !child || child.tag !== 'net')
          : infoChild.content
        const noRteChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => typeof child !== 'object' || !child || child.tag !== 'rte')
          : infoChild.content
        const coreRelayChildren = Array.isArray(infoChild.content)
          ? infoChild.content.filter((child) => {
            if (typeof child !== 'object' || !child) return false
            return ['audio', 'capability', 'enc', 'relay'].includes(child.tag || '')
          })
          : infoChild.content
        rawCallOfferRootNoRelayWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: noRelayChildren,
          }],
        })
        rawCallOfferRootNoNetWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: noNetChildren,
          }],
        })
        rawCallOfferRootNoRteWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: noRteChildren,
          }],
        })
        rawCallOfferRootCoreRelayWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: coreRelayChildren,
          }],
        })
        const callerPn = `${infoChild.attrs?.caller_pn || ''}`.trim()
        const originalCallCreator = `${infoChild.attrs?.['call-creator'] || ''}`.trim()
        const creatorDeviceJid = originalCallCreator.replace(/@lid$/i, '@s.whatsapp.net') || callerPn
        const callerMetadataChild: BinaryNode = {
          tag: 'caller_metadata',
          attrs: {
            call_creator: originalCallCreator || creatorDeviceJid,
            caller_pn: callerPn,
            platform: `${node.attrs?.platform || ''}`.trim(),
            notify: `${node.attrs?.notify || ''}`.trim(),
          },
          content: undefined,
        }
        const callerMetadataChildren = Array.isArray(infoChild.content)
          ? [...infoChild.content, callerMetadataChild]
          : [callerMetadataChild]
        rawCallOfferRootCallerMetadataWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: infoChild.attrs || {},
            content: callerMetadataChildren,
          }],
        })
        const creatorDeviceOfferAttrs = {
          ...(infoChild.attrs || {}),
          ...(creatorDeviceJid ? { 'call-creator': creatorDeviceJid } : {}),
        }
        const creatorDeviceRootAttrs = {
          ...enrichedRootAttrs,
          ...(creatorDeviceJid ? { from: creatorDeviceJid } : {}),
        }
        rawCallOfferRootCreatorDeviceWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: creatorDeviceRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: creatorDeviceOfferAttrs,
            content: infoChild.content,
          }],
        })
        rawCallOfferRootCallerMetadataCreatorDeviceWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: creatorDeviceRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: creatorDeviceOfferAttrs,
            content: callerMetadataChildren,
          }],
        })
        const noJoinableOfferAttrs = Object.fromEntries(
          Object.entries(infoChild.attrs || {}).filter(([key]) => key !== 'joinable')
        )
        const noCallerPnOfferAttrs = Object.fromEntries(
          Object.entries(infoChild.attrs || {}).filter(([key]) => key !== 'caller_pn')
        )
        const noCountryCodeOfferAttrs = Object.fromEntries(
          Object.entries(infoChild.attrs || {}).filter(([key]) => key !== 'caller_country_code')
        )
        const minimalOfferAttrs = Object.fromEntries(
          Object.entries(infoChild.attrs || {}).filter(([key]) => ['call-id', 'call-creator', 'caller_pn'].includes(key))
        )
        rawCallOfferRootNoJoinableWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: noJoinableOfferAttrs,
            content: infoChild.content,
          }],
        })
        rawCallOfferRootNoCallerPnWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: noCallerPnOfferAttrs,
            content: infoChild.content,
          }],
        })
        rawCallOfferRootNoCountryCodeWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: noCountryCodeOfferAttrs,
            content: infoChild.content,
          }],
        })
        rawCallOfferRootMinimalAttrsWapBytes = encodeBinaryNode({
          tag: node.tag,
          attrs: enrichedRootAttrs,
          content: [{
            tag: infoChild.tag,
            attrs: minimalOfferAttrs,
            content: infoChild.content,
          }],
        })
      }
      if (infoChild.tag === 'offer') {
        signalingPayloadBase64 = (decryptedOfferBytes || originalInfoBytes).toString('base64')
        payloadStrategy = decryptedOfferBytes ? 'offer_decrypted_enc_node' : 'offer_encoded_node'
      } else if (encBytes) {
        signalingPayloadBase64 = encBytes.toString('base64')
        payloadStrategy = 'enc_raw'
      } else {
        signalingPayloadBase64 = originalInfoBytes.toString('base64')
        payloadStrategy = 'info_node_wap'
      }
      if (infoChild.tag === 'offer' && encBytes && encChild) {
        const minimalOfferNode: BinaryNode = {
          tag: infoChild.tag,
          attrs: infoChild.attrs || {},
          content: [{
            tag: encChild.tag,
            attrs: encChild.attrs || {},
            content: encBytes,
          }],
        }
        const minimalOfferBytes = encodeBinaryNode(minimalOfferNode)
        const callOfferNode: BinaryNode = {
          tag: node.tag,
          attrs: node.attrs || {},
          content: [minimalOfferNode],
        }
        rawCallOfferEncWapBytes = encodeBinaryNode(callOfferNode)
        try {
          logger.info(
            {
              phone: this.phone,
              callId,
              originalOfferBytes: originalInfoBytes.byteLength,
              minimalOfferBytes: minimalOfferBytes.byteLength,
              sameBytes: originalInfoBytes.equals(minimalOfferBytes),
              originalOfferPreviewHex: originalInfoBytes.subarray(0, 48).toString('hex'),
              minimalOfferPreviewHex: minimalOfferBytes.subarray(0, 48).toString('hex'),
              originalOfferPreviewBase64: originalInfoBytes.subarray(0, 48).toString('base64'),
              minimalOfferPreviewBase64: minimalOfferBytes.subarray(0, 48).toString('base64'),
              rawCallOfferEncWapBytes: rawCallOfferEncWapBytes?.byteLength,
              rawCallOfferEncWapPreviewHex: rawCallOfferEncWapBytes?.subarray(0, 48).toString('hex'),
              rawCallOfferEncWapPreviewBase64: rawCallOfferEncWapBytes?.subarray(0, 48).toString('base64'),
              rawCallOfferRootMinimalWapBytes: rawCallOfferRootMinimalWapBytes?.byteLength,
              rawCallOfferRootMinimalWapPreviewHex: rawCallOfferRootMinimalWapBytes?.subarray(0, 48).toString('hex'),
              rawCallOfferRootMinimalWapPreviewBase64: rawCallOfferRootMinimalWapBytes?.subarray(0, 48).toString('base64'),
              rawCallOfferRootEnrichedWapBytes: rawCallOfferRootEnrichedWapBytes?.byteLength,
              rawCallOfferRootEnrichedWapPreviewHex: rawCallOfferRootEnrichedWapBytes?.subarray(0, 48).toString('hex'),
              rawCallOfferRootEnrichedWapPreviewBase64: rawCallOfferRootEnrichedWapBytes?.subarray(0, 48).toString('base64'),
              offerWapNoPrefixBytes: offerWapNoPrefixBytes?.byteLength,
              offerWapNoPrefixPreviewHex: offerWapNoPrefixBytes?.subarray(0, 48).toString('hex'),
              offerWapNoPrefixPreviewBase64: offerWapNoPrefixBytes?.subarray(0, 48).toString('base64'),
              rawOfferChildWapBytes: rawOfferChildWapBytes?.byteLength,
              rawOfferChildWapPreviewHex: rawOfferChildWapBytes?.subarray(0, 48).toString('hex'),
              rawOfferChildWapPreviewBase64: rawOfferChildWapBytes?.subarray(0, 48).toString('base64'),
            },
            'VOIP offer binary diff diagnostics'
          )
        } catch {}
      }
      if (!rawCallRootWapBytes) {
        rawCallRootWapBytes = encodeBinaryNode(node)
      }
      if (!signalingPayloadBase64) {
        // Fallback for signaling nodes that are not wrapped in an `enc` payload.
        const rootFallbackBytes = rawCallRootWapBytes || encodeBinaryNode(node)
        signalingPayloadBase64 = rootFallbackBytes.toString('base64')
        payloadStrategy = 'root_fallback_wap'
      }
      try {
        const finalPayloadBytes = signalingPayloadBase64 ? Buffer.from(signalingPayloadBase64, 'base64') : undefined
        logger.info({
          phone: this.phone,
          callId,
          msgType: infoChild.tag,
          payloadStrategy,
          finalPayloadBytes: finalPayloadBytes?.byteLength,
          finalPayloadPreviewHex: finalPayloadBytes?.subarray(0, 48).toString('hex'),
          finalPayloadPreviewBase64: finalPayloadBytes?.subarray(0, 48).toString('base64'),
          matchesOriginalInfo: !!(finalPayloadBytes && originalInfoBytes.equals(finalPayloadBytes)),
          matchesRawFirstChild: !!(finalPayloadBytes && rawFirstChildWapBytes && finalPayloadBytes.equals(rawFirstChildWapBytes)),
          matchesRawDecryptedFrame: !!(finalPayloadBytes && rawDecryptedCallFrameBytes && finalPayloadBytes.equals(rawDecryptedCallFrameBytes)),
        }, 'VOIP signaling payload strategy')
      } catch {}
      logger.info({
        phone: this.phone,
        callId,
        msgType: infoChild.tag,
        peerJid,
        payloadStrategy,
      }, 'VOIP enqueue signaling start')
      const tcTokenBase64 = infoChild.tag === 'offer'
        ? await this.fetchTcToken([peerJid, `${node.attrs?.from || ''}`.trim(), `${infoChild.attrs?.['call-creator'] || ''}`.trim()])
        : undefined
      const selfIdentity = this.getVoipSelfIdentity()
      logger.warn({
        phone: this.phone,
        callId,
        msgType: infoChild.tag,
        payloadStrategy,
        peerJid,
        rawPeerJid,
        networkPeerJid,
        storedPeerJid,
        storedNetworkPeerJid: callId ? this.voipNetworkPeerByCallId.get(callId) : undefined,
        callCreator,
        callerPn: `${infoChild.attrs?.caller_pn || ''}`.trim() || undefined,
        nodeFrom: `${node.attrs?.from || ''}`.trim() || undefined,
        nodeParticipant: `${node.attrs?.participant || ''}`.trim() || undefined,
        infoParticipant: `${infoChild.attrs?.participant || ''}`.trim() || undefined,
        hasTcToken: !!tcTokenBase64,
        tcTokenSource: infoChild.tag === 'offer' ? 'offer_fetch' : 'stored_by_voip_service',
        selfJid: selfIdentity.selfJid,
        selfLid: selfIdentity.selfLid,
        outerAttrs: node.attrs || {},
        infoAttrs: infoChild.attrs || {},
      }, 'VOIP signaling context forwarding to voip service')
      const response = await this.enqueueVoipByCall(callId, async () => {
        logger.info({
          phone: this.phone,
          callId,
          msgType: infoChild.tag,
          peerJid,
          payloadStrategy,
          hasTcToken: !!tcTokenBase64,
        }, 'VOIP enqueue signaling callback')
        return sendVoipSignaling(this.config, {
          session: this.phone,
          callId,
          peerJid,
          selfJid: selfIdentity.selfJid,
          selfLid: selfIdentity.selfLid,
          msgType: infoChild.tag,
          payload: binaryNodeToXml(infoChild),
          payloadBase64: signalingPayloadBase64,
          rawCallRootWapBase64: rawCallRootWapBytes?.toString('base64'),
          rawCallOfferRootMinimalWapBase64: rawCallOfferRootMinimalWapBytes?.toString('base64'),
          rawCallOfferRootEnrichedWapBase64: rawCallOfferRootEnrichedWapBytes?.toString('base64'),
          rawCallOfferRootPrunedWapBase64: rawCallOfferRootPrunedWapBytes?.toString('base64'),
          rawCallOfferRootNoEncoptWapBase64: rawCallOfferRootNoEncoptWapBytes?.toString('base64'),
          rawCallOfferRootNoMetadataWapBase64: rawCallOfferRootNoMetadataWapBytes?.toString('base64'),
          rawCallOfferRootNoEncoptNoMetadataWapBase64: rawCallOfferRootNoEncoptNoMetadataWapBytes?.toString('base64'),
          rawCallOfferRootNoRelayWapBase64: rawCallOfferRootNoRelayWapBytes?.toString('base64'),
          rawCallOfferRootNoNetWapBase64: rawCallOfferRootNoNetWapBytes?.toString('base64'),
          rawCallOfferRootNoRteWapBase64: rawCallOfferRootNoRteWapBytes?.toString('base64'),
          rawCallOfferRootCoreRelayWapBase64: rawCallOfferRootCoreRelayWapBytes?.toString('base64'),
          rawCallOfferRootCallerMetadataWapBase64: rawCallOfferRootCallerMetadataWapBytes?.toString('base64'),
          rawCallOfferRootCreatorDeviceWapBase64: rawCallOfferRootCreatorDeviceWapBytes?.toString('base64'),
          rawCallOfferRootCallerMetadataCreatorDeviceWapBase64: rawCallOfferRootCallerMetadataCreatorDeviceWapBytes?.toString('base64'),
          rawCallOfferRootNoJoinableWapBase64: rawCallOfferRootNoJoinableWapBytes?.toString('base64'),
          rawCallOfferRootNoCallerPnWapBase64: rawCallOfferRootNoCallerPnWapBytes?.toString('base64'),
          rawCallOfferRootNoCountryCodeWapBase64: rawCallOfferRootNoCountryCodeWapBytes?.toString('base64'),
          rawCallOfferRootMinimalAttrsWapBase64: rawCallOfferRootMinimalAttrsWapBytes?.toString('base64'),
          rawCallOfferEncWapBase64: rawCallOfferEncWapBytes?.toString('base64'),
          rawOfferEncBase64,
          rawDecryptedCallFrameBase64: rawDecryptedCallFrameBase64 || undefined,
          rawOfferWapNoPrefixBase64: offerWapNoPrefixBytes?.toString('base64'),
          rawOfferChildWapBase64: rawOfferChildWapBytes?.toString('base64'),
          tcTokenBase64,
          payloadEncoding: 'wa_binary',
          attrs: Object.fromEntries(Object.entries(infoChild.attrs || {}).map(([key, value]) => [key, `${value}`])),
          outerAttrs: Object.fromEntries(Object.entries(node.attrs || {}).map(([key, value]) => [key, `${value}`])),
          encAttrs: encChild ? Object.fromEntries(Object.entries(encChild.attrs || {}).map(([key, value]) => [key, `${value}`])) : undefined,
          timestamp: Number(node?.attrs?.t || 0) || undefined,
        })
      })
      logger.info({
        phone: this.phone,
        callId,
        msgType: infoChild.tag,
        peerJid,
      }, 'VOIP enqueue signaling done')
      await this.processVoipCommands(extractVoipCommands(response.body))
      if (infoChild.tag === 'offer') this.scheduleVoipCommandDrain(callId)
      if (infoChild.tag === 'terminate' || infoChild.tag === 'reject') {
        this.voipPeerByCallId.delete(callId)
        this.voipNetworkPeerByCallId.delete(callId)
      }
    } catch (error) {
      logger.warn(error as any, 'failed to forward voip signaling for %s', this.phone)
    }
  }

  private async notifyVoipServiceCallEvent(event: any) {
    const mappedEvent = mapBaileysCallStatusToVoipEvent(event?.status)
    const callId = `${event?.id || ''}`.trim()
    const from = `${event?.from || ''}`.trim()
    if (!mappedEvent || !callId || !from) return

    const timestampRaw = event?.timestamp ?? event?.t ?? event?.messageTimestamp
    const timestamp = Number(timestampRaw)
    const selfIdentity = this.getVoipSelfIdentity()
    const response = await this.enqueueVoipByCall(callId, async () => sendVoipCallEvent(this.config, {
      session: this.phone,
      event: mappedEvent,
      callId,
      from,
      callerPn: `${event?.callerPn || event?.caller_pn || ''}`.trim() || undefined,
      selfJid: selfIdentity.selfJid,
      selfLid: selfIdentity.selfLid,
      isGroup: typeof event?.isGroup === 'boolean' ? event.isGroup : (typeof event?.is_group === 'boolean' ? event.is_group : undefined),
      groupJid: `${event?.groupJid || event?.group_jid || ''}`.trim() || undefined,
      isVideo: typeof event?.isVideo === 'boolean' ? event.isVideo : (typeof event?.is_video === 'boolean' ? event.is_video : undefined),
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      raw: event,
    }))
    await this.processVoipCommands(extractVoipCommands(response.body))
    if (mappedEvent === 'incoming_call') this.scheduleVoipCommandDrain(callId)
  }

  private async handleIncomingCallRejection(event: any, source = 'call') {
    const from = `${event?.from || ''}`.trim()
    const id = `${event?.id || event?.callId || ''}`.trim()
    const status = `${event?.status || ''}`.trim()
    const callerPn = `${event?.callerPn || event?.caller_pn || ''}`.trim()
    if (!from || !id) return

    const normalizedStatus = status.toLowerCase()
    const terminalCallStatuses = new Set(['terminate', 'terminated', 'timeout', 'timed_out', 'reject', 'rejected', 'end', 'ended', 'hangup', 'missed'])
    if (terminalCallStatuses.has(normalizedStatus)) {
      try {
        if (this.calls.delete(from)) {
          logger.info('CALL gate cleared immediately: from=%s id=%s status=%s source=%s', from, id, status, source)
        }
      } catch {}
    }
    try {
      logger.info(
        'CALL ringing gate: from=%s id=%s hasCall=%s hasRejectCall=%s rejectCallsConfigured=%s status=%s source=%s',
        from,
        id,
        this.calls.has(from),
        !!this.rejectCall,
        !!this.config.rejectCalls,
        normalizedStatus,
        source,
      )
    } catch {}
    const incomingCallStatuses = new Set(['ringing', 'offer'])
    if (!incomingCallStatuses.has(normalizedStatus) || this.calls.has(from)) return

    this.calls.set(from, true)
    if (this.config.rejectCalls && this.rejectCall) {
      try {
        logger.info('CALL reject start: from=%s callerPn=%s id=%s source=%s', from, callerPn || '<none>', id, source)
        await this.rejectCall(id, from)
        logger.info('CALL reject success: from=%s id=%s source=%s', from, id, source)
      } catch (error) {
        logger.warn({ err: error, from, callerPn, id, source }, 'CALL reject failed')
      }
      // Enviar mensagem de rejeição respeitando o modo 1:1:
      // - Em PN: preferir PN; para BR, tentar 12 dígitos primeiro (exists), depois 13; fallback origem
      // - Em LID: manter origem
      let toMsg = from
      try {
        if (ONE_TO_ONE_ADDRESSING_MODE === 'pn') {
          let pnJid: string | undefined
          if (callerPn && isPnUser(callerPn)) {
            pnJid = callerPn
          } else if (isLidUser(from)) {
            try { pnJid = await this.store?.dataStore?.getPnForLid?.(this.phone, from) } catch {}
            if (!pnJid) { try { const cand = jidNormalizedUser(from); if (cand && isPnUser(cand as any)) pnJid = cand as any } catch {} }
          } else if (isPnUser(from)) {
            pnJid = from
          }
          const digits = ensurePn(pnJid || from)
          if (digits && digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
            const ddd = digits.slice(2, 4)
            const to12 = digits.length === 12 ? digits : `55${ddd}${digits.slice(5)}`
            const to13 = digits.length === 13 ? digits : (/[6-9]/.test(digits.slice(4)[0]) ? `55${ddd}9${digits.slice(4)}` : digits)
            let chosen: string | undefined
            try { const r12 = await this.exists(to12); if (r12 && isPnUser(r12 as any)) chosen = r12 } catch {}
            if (!chosen) { try { const r13 = await this.exists(to13); if (r13 && isPnUser(r13 as any)) chosen = r13 } catch {} }
            toMsg = chosen || pnJid || from
          } else {
            toMsg = pnJid || from
          }
        } else {
          toMsg = from
        }
      } catch { toMsg = from }
      try {
        await this.sendMessage(toMsg, { text: this.config.rejectCalls }, {})
        logger.info('Rejecting calls %s %s to=%s source=%s', this.phone, this.config.rejectCalls, toMsg, source)
      } catch (error) {
        logger.warn({ err: error, from, callerPn, id, toMsg, source }, 'CALL reject message send failed')
      }
    }

    const messageCallsWebhook = this.config.rejectCallsWebhook || this.config.messageCallsWebhook
    if (messageCallsWebhook) {
      // Tenta resolver PN para o remetente da chamada (quando vier em LID)
      let senderPnJid: string | undefined = undefined
      try {
        if (callerPn && isPnUser(callerPn)) {
          senderPnJid = callerPn
        }
      } catch {}
      try {
        if (!senderPnJid && isLidUser(from)) {
          senderPnJid = await this.store?.dataStore?.getPnForLid?.(this.phone, from)
        }
      } catch {}
      try {
        if (!senderPnJid && isLidUser(from)) {
          senderPnJid = await getPnForLidFromAuthCache(this.phone, from)
        }
      } catch {}
      try {
        if (!senderPnJid && isLidUser(from)) {
          // Fallback leve: normaliza o JID (pode retornar PN em alguns cenários)
          senderPnJid = jidNormalizedUser(from)
        }
      } catch {}
      try {
        logger.info('CALL resolve mapping: from=%s isLid=%s mappedPn=%s source=%s', from, isLidUser(from), senderPnJid || '<none>', source)
      } catch {}
      const remoteJidKey = senderPnJid || from
      const waMessageKey = {
        fromMe: false,
        id: uuid(),
        remoteJid: remoteJidKey,
        // Ajuda o transformer a resolver PN mesmo quando o evento vier em LID (usa mapping quando disponível)
        senderPn: senderPnJid || (isLidUser(from) ? undefined : from),
      }
      try {
        logger.info('CALL notify key: remoteJid=%s senderPn=%s source=%s', waMessageKey.remoteJid, waMessageKey['senderPn'] || '<none>', source)
      } catch {}
      const message = {
        key: waMessageKey,
        message: {
          conversation: messageCallsWebhook,
        },
      }
      await this.listener.process(this.phone, [message], 'notify')
      try { logger.info('CALL notify enqueued for %s source=%s', from, source) } catch {}
    }
    setTimeout(() => {
      logger.debug('Clean call rejecteds %s', from)
      this.calls.delete(from)
    }, 10_000)
  }

  private async ensureUnoExternalMessageId(key: { id?: string; remoteJid?: string } | undefined): Promise<string> {
    const idBaileys = `${key?.id || ''}`.trim()
    if (!idBaileys) return ''
    let idUno = ''
    try { idUno = `${await this.store?.dataStore?.loadUnoId(idBaileys) || ''}`.trim() } catch {}
    if (!idUno) idUno = uuid()
    try { await this.store?.dataStore?.setUnoId(idBaileys, idUno) } catch {}
    try { if (key?.id) await this.store?.dataStore?.setKey(idUno, key as any) } catch {}
    return idUno || idBaileys
  }

  private async remapMentionsToLidForGroup(targetTo: string, content: any, payload?: any) {
    try {
      if (!targetTo || !isJidGroup(targetTo)) return
      const requestId = `${payload?._requestId || payload?.requestId || '<none>'}`
      const inputMentions: string[] = Array.isArray(content?.mentions) ? content.mentions : []
      const mentionAll = !!content?.mentionAll
      if (!inputMentions.length && !mentionAll) return
      if (mentionAll) {
        if (Array.isArray(content?.mentions) && content.mentions.length) {
          logger.info(
            'MENTION_UNO_REMAP req=%s to=%s mentionAll=%s participants=%s before=%s after=%s',
            requestId,
            targetTo,
            true,
            0,
            JSON.stringify(inputMentions),
            JSON.stringify([]),
          )
        }
        delete content.mentions
        return
      }

      let participants: any[] = []
      const lidsByPn = new Map<string, string>()
      try {
        const gm = await this.fetchGroupMetadata(targetTo)
        participants = Array.isArray((gm as any)?.participants) ? (gm as any).participants : []
        for (const p of participants) {
          const rawLid = `${p?.lid || ''}`.trim()
          const rawA = `${p?.id || ''}`.trim()
          const rawB = `${p?.jid || ''}`.trim()
          const lidJid =
            (rawLid && isLidUser(rawLid as any) && (jidNormalizedUser(rawLid as any) as string)) ||
            (rawA && isLidUser(rawA as any) && (jidNormalizedUser(rawA as any) as string)) ||
            (rawB && isLidUser(rawB as any) && (jidNormalizedUser(rawB as any) as string)) ||
            ''
          const pnJid =
            (rawA && isPnUser(rawA as any) && (jidNormalizedUser(rawA as any) as string)) ||
            (rawB && isPnUser(rawB as any) && (jidNormalizedUser(rawB as any) as string)) ||
            ''
          if (pnJid && lidJid) {
            lidsByPn.set(pnJid, lidJid)
            const pnDigits = ensurePn(pnJid)
            if (pnDigits) lidsByPn.set(phoneNumberToJid(pnDigits), lidJid)
          }
        }
      } catch (e) {
        logger.debug(e as any, 'Ignore groupMetadata mention fallback error for %s', targetTo)
      }

      const resolveMention = async (rawMention: string) => {
        const mention = `${rawMention || ''}`.trim()
        if (!mention) return ''
        if (isLidUser(mention as any)) return jidNormalizedUser(mention as any) as string

        let pnJid = ''
        if (isPnUser(mention as any)) {
          pnJid = jidNormalizedUser(mention as any) as string
        } else {
          const pn = ensurePn(mention.startsWith('@') ? mention.slice(1) : mention)
          if (pn) pnJid = phoneNumberToJid(pn)
        }

        if (!pnJid) return mention

        let lidJid: string | undefined
        try {
          lidJid = await this.store?.dataStore?.getLidForPn?.(this.phone, pnJid)
        } catch {}
        if (!lidJid) lidJid = lidsByPn.get(pnJid)
        return lidJid && isLidUser(lidJid as any) ? (jidNormalizedUser(lidJid as any) as string) : pnJid
      }

      const remappedExplicit = (await Promise.all(inputMentions.map(resolveMention))).filter(Boolean)
      const explicitUsers = new Set<string>()
      for (const jid of remappedExplicit) {
        try {
          explicitUsers.add(`${jidNormalizedUser(jid as any)}`.split('@')[0])
        } catch {}
      }

      const remapped = [...remappedExplicit]
      const selfUsers = new Set<string>()
      try {
        const meId = `${this.store?.state?.creds?.me?.id || ''}`.trim()
        if (meId) selfUsers.add((jidNormalizedUser(meId as any) as string).split('@')[0])
      } catch {}
      try {
        const meLid = `${(this.store as any)?.state?.creds?.me?.lid || ''}`.trim()
        if (meLid) selfUsers.add((jidNormalizedUser(meLid as any) as string).split('@')[0])
      } catch {}
      try {
        selfUsers.add(ensurePn(this.phone))
      } catch {}

      const unique = Array.from(new Set(remapped.filter(Boolean))).filter((jid) => {
        try {
          const user = `${jidNormalizedUser(jid as any)}`.split('@')[0]
          if (!user) return false
          if (!selfUsers.has(user)) return true
          return explicitUsers.has(user)
        } catch {
          return true
        }
      })

      const changed = unique.length !== inputMentions.length || unique.some((m, i) => m !== inputMentions[i])
      if (changed) {
        content.mentions = unique
        logger.info(
          'MENTION_UNO_REMAP req=%s to=%s mentionAll=%s participants=%s before=%s after=%s',
          requestId,
          targetTo,
          mentionAll,
          participants.length,
          JSON.stringify(inputMentions),
          JSON.stringify(unique),
        )
      }
    } catch (e) {
      logger.debug(e as any, 'Ignore mention remap error for %s', targetTo)
    }
  }

  /**
   * High-level client that wraps Baileys send/receive operations for a single phone session.
   *
   * Responsibilities:
   * - Connect/disconnect lifecycle
   * - Map Cloud-API-like payloads to Baileys messages
   * - Apply sending safeguards (groups, status broadcast, media checks)
   * - Persist message keys/metadata to the configured Store
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  readonly sendMessageDefault: sendMessage = async (_phone: string, _message: AnyMessageContent, _options: unknown) => {
    const sessionStore = this?.phone && await (await this?.config?.getStore(this.phone, this.config)).sessionStore
    if (sessionStore) {
      if (!await sessionStore.isStatusConnecting(this.phone)) {
        this.clientRegistry.delete(this.phone)
      }
      if (await sessionStore.isStatusOnline(this.phone)) {
        await sessionStore.setStatus(this.phone, 'offline')
        this.clientRegistry.delete(this.phone)
      }
    }
    throw sendError
  }

  private phone: string
  private config: Config = defaultConfig
  private close: close = closeDefault
  private sendMessage = this.sendMessageDefault
  private event
  private fetchImageUrl = fetchImageUrlDefault
  private exists = existsDefault
  private socketLogout: logout = logoutDefault
  private fetchGroupMetadata = fetchGroupMetadataDefault
  private groupMetadataFn: groupMetadata = groupMetadataDefault
  private readMessages = readMessagesDefault
  private rejectCall: rejectCall | undefined = rejectCallDefault
  private sendCallNode: sendCallNode = sendCallNodeDefault
  private fetchTcToken: fetchTcToken = fetchTcTokenDefault
  private decryptVoipEnc: decryptVoipEnc = decryptVoipEncDefault
  private groupCreateFn: groupCreate = groupUnavailable
  private groupUpdateSubjectFn: groupUpdateSubject = groupUnavailable
  private groupUpdateDescriptionFn: groupUpdateDescription = groupUnavailable
  private groupUpdatePictureFn: groupUpdatePicture = groupUnavailable
  private groupParticipantsUpdateFn: groupParticipantsUpdate = groupUnavailable
  private groupInviteCodeFn: groupInviteCode = groupUnavailable
  private groupRevokeInviteFn: groupInviteCode = groupUnavailable
  private groupRequestParticipantsListFn: groupRequestParticipantsList = groupUnavailable
  private groupRequestParticipantsUpdateFn: groupRequestParticipantsUpdate = groupUnavailable
  private groupLeaveFn: groupLeave = groupUnavailable
  private groupSettingUpdateFn: groupSettingUpdate = groupUnavailable
  private groupJoinApprovalModeFn: groupJoinApprovalMode = groupUnavailable
  private listener: Listener
  private store: Store | undefined
  private calls = new Map<string, boolean>()
  private voipPeerByCallId = new Map<string, string>()
  private voipNetworkPeerByCallId = new Map<string, string>()
  private groupMetadataRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private groupMetadataRefreshInFlight = new Set<string>()
  private groupMetadataRefreshLastAt = new Map<string, number>()
  private getConfig: getConfig
  private onNewLogin
  private clientRegistry: Map<string, Client>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onWebhookError = async (error: any) => {
    const { sessionStore } = this.store!
    if (!this.config.throwWebhookError && error.name === 'FetchError' && (await sessionStore.isStatusOnline(this.phone))) {
      return this.sendMessage(
        phoneNumberToJid(this.phone),
        { text: `Error on send message to webhook: ${error.message}`},
        {}
      )
    }
    if (this.config.throwWebhookError) {
      throw error
    }
  }

  private onNotification: OnNotification = async (text: string, important) => {
    if (this.config.sendConnectionStatus || important) {
      const id = uuid()
      const waMessageKey = {
        fromMe: true,
        remoteJid: phoneNumberToJid(this.phone),
        id,
      }
      const payload = {
        key: waMessageKey,
        message: {
          conversation: text,
        },
      }
      logger.debug('onNotification %s', JSON.stringify(payload))
      if (this.config.sessionWebhook) {
        try {
          const { sessionStore } = this.store!
          const body = JSON.stringify({ info: { phone: this.phone }, status: await sessionStore.getStatus(this.phone), ...payload })
          const response = await fetch(this.config.sessionWebhook, {
            method: 'POST',
            body: body,
            headers: { 'Content-Type': 'application/json' },
          })
          logger.debug('Response OnNotification Webhook Session', response)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          logger.error(error, 'Erro on send status')
          await this.onWebhookError(error)
        }
      } else {
        await this.listener.process(this.phone, [payload], 'status')
      }
    }
  }

  private onQrCode: OnQrCode = async (qrCode: string, time, limit) => {
    logger.debug('Received qrcode %s %s', this.phone, qrCode)
    try {
      const { sessionStore } = this.store!
      if (sessionStore && await sessionStore.isStatusOnline(this.phone)) {
        logger.debug('Skip sending QR: session already online %s', this.phone)
        return
      }
    } catch {}
    const id = uuid()
    const qrCodeUrl = await QRCode.toDataURL(qrCode)
    const remoteJid = phoneNumberToJid(this.phone)
    const waMessageKey = {
      fromMe: true,
      remoteJid,
      id,
    }
    const message =  t('qrcode_attemps', time, limit)
    const waMessage: WAMessage = {
      key: waMessageKey,
      message: {
        imageMessage: {
          url: qrCodeUrl,
          mimetype: 'image/png',
          fileLength: qrCode.length,
          caption: message,
        },
      },
    }
    if (this.config.sessionWebhook) {
      const { sessionStore } = this.store!
      const body = JSON.stringify({ info: { phone: this.phone }, status: await sessionStore.getStatus(this.phone), ...waMessage })
      try {
        const response = await fetch(this.config.sessionWebhook, {
          method: 'POST',
          body: body,
          headers: { 'Content-Type': 'application/json' },
        })
        logger.debug('Response Webhook Session', response)
      } catch (error) {
        logger.error(error, 'Erro on send qrcode')
        await this.onWebhookError(error)
      }
    } else {
      await this.listener.process(this.phone, [waMessage], 'qrcode')
    }
  }

  private onReconnect: OnReconnect = async (time: number) => {
    logger.warn('ClientBaileys onReconnect requested for %s (attempt=%s)', this.phone, time)
    try {
      await this.connect(time)
      logger.warn('ClientBaileys onReconnect completed for %s', this.phone)
    } catch (e) {
      logger.error(e as any, 'ClientBaileys onReconnect failed for %s', this.phone)
      throw e
    }
  }

  private delayBeforeSecondMessage: Delay = async (phone, to) => {
    const time = 2000
    logger.debug(`Sleep for ${time} before second message ${phone} => ${to}`)
    delays && (delays.get(phone) || new Map()).set(to, this.continueAfterSecondMessage)
    return delay(time)
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
  private continueAfterSecondMessage: Delay = async (_phone, _to) => {}

  private clearGroupMetadataRefreshTimers() {
    for (const timer of this.groupMetadataRefreshTimers.values()) {
      clearTimeout(timer)
    }
    this.groupMetadataRefreshTimers.clear()
    this.groupMetadataRefreshInFlight.clear()
  }

  private scheduleGroupMetadataRefresh(groupJid: string, reason: string) {
    if (!GROUP_METADATA_EVENT_REFRESH_ENABLED) return
    const jid = `${groupJid || ''}`.trim()
    if (!jid || !jid.endsWith('@g.us')) return
    if (!this.store?.dataStore?.setGroupMetada) return

    const now = Date.now()
    const debounceMs = Math.max(0, GROUP_METADATA_EVENT_REFRESH_DEBOUNCE_MS || 0)
    const minIntervalMs = Math.max(0, GROUP_METADATA_EVENT_REFRESH_MIN_INTERVAL_MS || 0)
    const lastRefreshAt = this.groupMetadataRefreshLastAt.get(jid) || 0
    const remainingIntervalMs = lastRefreshAt ? Math.max(0, minIntervalMs - (now - lastRefreshAt)) : 0
    const delayMs = Math.max(debounceMs, remainingIntervalMs)

    const currentTimer = this.groupMetadataRefreshTimers.get(jid)
    if (currentTimer) clearTimeout(currentTimer)

    const timer = setTimeout(() => {
      this.groupMetadataRefreshTimers.delete(jid)
      void this.refreshGroupMetadataCache(jid, reason)
    }, delayMs)
    this.groupMetadataRefreshTimers.set(jid, timer)
  }

  private async refreshGroupMetadataCache(groupJid: string, reason: string) {
    if (this.groupMetadataRefreshInFlight.has(groupJid)) return
    this.groupMetadataRefreshInFlight.add(groupJid)
    try {
      const metadata = await this.groupMetadataFn(groupJid)
      if (metadata) {
        await this.store?.dataStore?.setGroupMetada(groupJid, metadata)
        const participantsCount = Array.isArray((metadata as any)?.participants) ? (metadata as any).participants.length : undefined
        logger.info(
          'GROUP_METADATA cache refreshed: phone=%s group=%s reason=%s participants=%s',
          this.phone,
          groupJid,
          reason,
          participantsCount ?? '<unknown>',
        )
      }
    } catch (error) {
      logger.warn(error as any, 'Failed to refresh group metadata cache for %s (%s)', groupJid, reason)
    } finally {
      this.groupMetadataRefreshLastAt.set(groupJid, Date.now())
      this.groupMetadataRefreshInFlight.delete(groupJid)
    }
  }

  constructor(phone: string, listener: Listener, getConfig: getConfig, onNewLogin: OnNewLogin, clientRegistry: Map<string, Client> = clients) {
    this.phone = phone
    this.listener = listener
    this.getConfig = getConfig
    this.onNewLogin = onNewLogin
    this.clientRegistry = clientRegistry
  }

  async connect(time: number) {
    logger.debug('Client Baileys connecting for %s', this.phone)
    this.config = await this.getConfig(this.phone)
    this.store = await this.config.getStore(this.phone, this.config)
    const { sessionStore } = this.store

    await sessionStore.syncConnection(this.phone)
    if (await sessionStore.isStatusConnecting(this.phone)) {
      logger.warn('Already Connecting %s', this.phone)
      return
    }
    if (await sessionStore.isStatusOnline(this.phone)) {
      logger.warn('Already Connected %s', this.phone)
      return
    }
    if (await sessionStore.isStatusStandBy(this.phone)) {
      logger.warn('Standby %s', this.phone)
      return
    }

    await sessionStore.setStatus(this.phone, 'connecting')
    const result = await connect({
      phone: this.phone,
      store: this.store!,
      attempts,
      time,
      onQrCode: this.onQrCode,
      onNotification: this.onNotification,
      onNewLogin: this.onNewLogin,
      config: this.config,
      onDisconnected: async () => this.disconnect(),
      onReconnect: this.onReconnect
    })
    if (!result) {
      logger.error('Socket connect return empty %s', this.phone)
      return
    }
    const {
      send,
      read,
      event,
      rejectCall,
      sendCallNode,
      fetchImageUrl,
      fetchGroupMetadata,
      groupMetadata,
      exists,
      close,
      logout,
      groupCreate,
      groupUpdateSubject,
      groupUpdateDescription,
      groupUpdatePicture,
      groupParticipantsUpdate,
      groupInviteCode,
      groupRevokeInvite,
      groupRequestParticipantsList,
      groupRequestParticipantsUpdate,
      groupLeave,
      groupSettingUpdate,
      groupJoinApprovalMode,
      fetchTcToken,
      decryptVoipEnc,
    } = result
    this.event = event
    this.sendMessage = send
    this.readMessages = read
    this.rejectCall = rejectCall
    this.sendCallNode = sendCallNode
    this.fetchTcToken = fetchTcToken || fetchTcTokenDefault
    this.decryptVoipEnc = decryptVoipEnc || decryptVoipEncDefault
    this.groupCreateFn = groupCreate || groupUnavailable
    this.groupUpdateSubjectFn = groupUpdateSubject || groupUnavailable
    this.groupUpdateDescriptionFn = groupUpdateDescription || groupUnavailable
    this.groupUpdatePictureFn = groupUpdatePicture || groupUnavailable
    this.groupParticipantsUpdateFn = groupParticipantsUpdate || groupUnavailable
    this.groupInviteCodeFn = groupInviteCode || groupUnavailable
    this.groupRevokeInviteFn = groupRevokeInvite || groupUnavailable
    this.groupRequestParticipantsListFn = groupRequestParticipantsList || groupUnavailable
    this.groupRequestParticipantsUpdateFn = groupRequestParticipantsUpdate || groupUnavailable
    this.groupLeaveFn = groupLeave || groupUnavailable
    this.groupSettingUpdateFn = groupSettingUpdate || groupUnavailable
    this.groupJoinApprovalModeFn = groupJoinApprovalMode || groupUnavailable
    this.fetchImageUrl = this.config.sendProfilePicture ? fetchImageUrl : fetchImageUrlDefault
    this.fetchGroupMetadata = fetchGroupMetadata
    this.groupMetadataFn = groupMetadata || groupMetadataDefault
    this.close = close
    this.exists = exists
    this.socketLogout = logout
    this.config.getMessageMetadata = async <T>(data: T) => {
      logger.debug(data, 'Put metadata in message')
      return this.getMessageMetadata(data)
    }
    await this.subscribe()
    logger.debug('Client Baileys connected for %s', this.phone)
  }

  async disconnect() {
    logger.debug('Disconnect client store for %s', this?.phone)
    this.clearGroupMetadataRefreshTimers()
    this.store = undefined

    await this.close()
    this.clientRegistry.delete(this?.phone)
    configs.delete(this?.phone)
    this.sendMessage = this.sendMessageDefault
    this.readMessages = readMessagesDefault
    this.rejectCall = rejectCallDefault
    this.sendCallNode = sendCallNodeDefault
    this.fetchImageUrl = fetchImageUrlDefault
    this.fetchGroupMetadata = fetchGroupMetadataDefault
    this.groupMetadataFn = groupMetadataDefault
    this.exists = existsDefault
    this.close = closeDefault
    this.config = defaultConfig
    this.socketLogout = logoutDefault
    this.config.getMessageMetadata = getMessageMetadataDefault
  }

  async subscribe() {
    this.event('groups.update', async (updates: any[] | any) => {
      const list = Array.isArray(updates) ? updates : [updates]
      for (const update of list) {
        const groupJid = `${update?.id || ''}`.trim()
        if (groupJid) this.scheduleGroupMetadataRefresh(groupJid, 'groups.update')
      }
    })

    this.event('group-participants.update', async (update: any) => {
      const groupJid = `${update?.id || ''}`.trim()
      const action = `${update?.action || ''}`.trim()
      if (groupJid) this.scheduleGroupMetadataRefresh(groupJid, action ? `group-participants.update:${action}` : 'group-participants.update')
    })

    this.event('messages.upsert', async (payload: { messages: any[]; type }) => {
      try {
        const arr: any[] = (payload?.messages || []) as any[]
        const cnt = arr.length
        const types = arr.map((m) => {
          try { return getMessageType(m) || Object.keys(m?.message || {})[0] || '<none>' } catch { return '<none>' }
        })
        const sample = arr.slice(0, 3).map((m) => ({
          jid: m?.key?.remoteJid,
          id: m?.key?.id,
          type: getMessageType(m) || Object.keys(m?.message || {})[0] || '<none>',
          fromMe: m?.key?.fromMe,
        }))
        logger.info('BAILEYS upsert: phone=%s count=%s types=%s sample=%s', this.phone, cnt, types.join(','), JSON.stringify(sample))
        // Update contact name cache from pushName/verifiedBizName
        try {
          const store = this.store
          if (store) {
            for (const m of arr) {
              const name = (m?.verifiedBizName || m?.pushName || '').toString().trim()
              const k = (m?.key || {}) as any
              const candidates: string[] = []
              if (typeof k?.participant === 'string') candidates.push(k.participant)
              if (typeof k?.remoteJid === 'string') candidates.push(k.remoteJid)
              for (const j of candidates) {
                try {
                  if (j && typeof j === 'string' && !j.endsWith('@g.us')) {
                    const info: any = { name }
                    if (isLidUser(j)) {
                      info.lidJid = j
                      try {
                        const mapped = await store.dataStore.getPnForLid?.(this.phone, j)
                        if (mapped && isPnUser(mapped)) {
                          info.pnJid = mapped
                          try { info.pn = jidToRawPhoneNumber(mapped, '').replace('+','') } catch {}
                        }
                        // Não derive PN apenas por normalização do LID; aguarde mapping/exists válido
                      } catch {}
                    } else {
                      info.pnJid = j
                      try { info.pn = jidToRawPhoneNumber(j, '').replace('+','') } catch {}
                      try {
                        const lid = await store.dataStore.getLidForPn?.(this.phone, j)
                        if (typeof lid === 'string' && lid.endsWith('@lid')) {
                          if (!info.lidJid) info.lidJid = lid
                        }
                      } catch {}
                    }
                    await store.dataStore.setContactInfo?.(j, info)
                    await store.dataStore.setContactName?.(j, name)
                    try { logger.info('CONTACT_CACHE upsert from upsert: jid=%s name=%s pn=%s lid=%s', j, name || '<none>', info.pn || '<none>', info.lidJid || '<none>') } catch {}
                  }
                } catch {}
              }
            }
          }
        } catch {}
      } catch { logger.debug('messages.upsert %s', this.phone) }
      await this.listener.process(this.phone, payload.messages, payload.type)
      if (this.config.readOnReceipt && payload.messages[0] && !payload.messages[0]?.fromMe) {
        await Promise.all(
          payload.messages
            .filter((message: any) => {
              const messageType = getMessageType(message)
              return !message?.key?.fromMe && messageType && TYPE_MESSAGES_TO_READ.includes(messageType)
            })
            .map(async (message: any) => {
              return this.readMessages([message.key!])
            })
        )
      }
    })
    this.event('messages.update', async (messages: object[]) => {
      try {
        const updates: any[] = Array.isArray(messages) ? (messages as any[]) : []
        const types = updates.map((m) => {
          try {
            const inner = m?.update?.message || m?.message
            return getMessageType({ message: inner }) || Object.keys(inner || {})[0] || '<none>'
          } catch { return '<none>' }
        })
        const sample = updates.slice(0, 3).map((m) => ({
          jid: m?.key?.remoteJid,
          id: m?.key?.id,
          hasUpdateMessage: !!m?.update?.message,
          type: (() => {
            try {
              const inner = m?.update?.message || m?.message
              return getMessageType({ message: inner }) || Object.keys(inner || {})[0] || '<none>'
            } catch { return '<none>' }
          })(),
        }))
        logger.info('BAILEYS update: phone=%s count=%s types=%s sample=%s', this.phone, updates.length, types.join(','), JSON.stringify(sample))
      } catch {}
      try {
        // Persist partial media updates to the DataStore so decrypt can pick improved keys/paths
        try {
          const store = this.store
          if (store && Array.isArray(messages)) {
            for (const m of messages as any[]) {
              const key = m?.key
              const update = m?.update
              if (key?.remoteJid && key?.id && update?.message) {
                try {
                  const existing = await store.dataStore.loadMessage(key.remoteJid, key.id)
                  const merged: any = existing ? { ...existing } : { key }
                  merged.message = { ...(existing?.message || {}), ...(update.message || {}) }
                  await store.dataStore.setMessage(key.remoteJid, merged)
                } catch (e) {
                  logger.warn(e as any, 'Ignore error merging messages.update into store')
                }
              }
            }
          }
        } catch (e) {
          logger.warn(e as any, 'Ignore error persisting messages.update')
        }
        // Detect server ack errors (e.g., 421) for group sends and log context
        const first = Array.isArray(messages) ? (messages[0] as any) : undefined
        const stubParams = first?.update?.messageStubParameters
        const key = first?.key
        if (stubParams && Array.isArray(stubParams) && stubParams.includes('421') && key?.remoteJid?.endsWith?.('@g.us')) {
          logger.warn('Server ack 421 for group %s message %s (fromMe: %s)', key?.remoteJid, key?.id, key?.fromMe)
        }
      } catch {}
      // Para grupos: quando habilitado, emitir apenas evento de "entregue" (DELIVERY_ACK)
      try {
        const useFilter = !!this.config.groupOnlyDeliveredStatus
        if (useFilter) {
          const filtered = Array.isArray(messages)
            ? (messages as any[]).filter((m: any) => {
                const jid = m?.key?.remoteJid || m?.remoteJid
                if (typeof jid === 'string' && jid.endsWith('@g.us')) {
                  const st = m?.status ?? m?.update?.status
                  return st === 3 || st === '3' || st === 'DELIVERY_ACK'
                }
                return true
              })
            : messages
          try {
            const sample = filtered.slice(0, 2).map((u: any) => ({ jid: u?.key?.remoteJid, id: u?.key?.id, status: u?.update?.status, stub: u?.update?.messageStubType }))
            logger.debug('messages.update %s count=%s sample=%s', this.phone, filtered.length, JSON.stringify(sample))
          } catch { logger.debug('messages.update %s count=%s', this.phone, filtered.length) }
          return this.listener.process(this.phone, filtered as any, 'update')
        }
      } catch {}
      try {
        const sample = messages.slice(0, 2).map((u: any) => ({ jid: u?.key?.remoteJid, id: u?.key?.id, status: (u as any)?.update?.status, stub: (u as any)?.update?.messageStubType }))
        logger.debug('messages.update %s count=%s sample=%s', this.phone, messages.length, JSON.stringify(sample))
      } catch { logger.debug('messages.update %s count=%s', this.phone, messages.length) }
      return this.listener.process(this.phone, messages, 'update')
    })
    // Capture contacts roster updates
    this.event('contacts.set' as any, async (u: any) => {
      try {
        const list = (u?.contacts || []) as any[]
        const store = this.store
        if (store) {
          for (const c of list) {
            const jid = c?.id || c?.jid
            const name = (c?.verifiedName || c?.businessName || c?.name || c?.notify || '').toString().trim()
            if (jid && name) {
              const info: any = { name }
              if (isLidUser(jid)) {
                info.lidJid = jid
                try {
                  const mapped = await store.dataStore.getPnForLid?.(this.phone, jid)
                  if (mapped && isPnUser(mapped)) {
                    info.pnJid = mapped
                    try { info.pn = jidToRawPhoneNumber(mapped, '').replace('+','') } catch {}
                  }
                  // Não derive PN apenas por normalização do LID; aguarde mapping/exists válido
                } catch {}
              } else {
                info.pnJid = jid
                try { info.pn = jidToRawPhoneNumber(jid, '').replace('+','') } catch {}
                try {
                  const lid = await store.dataStore.getLidForPn?.(this.phone, jid)
                  if (typeof lid === 'string' && lid.endsWith('@lid')) {
                    if (!info.lidJid) info.lidJid = lid
                  }
                } catch {}
              }
              try { await store.dataStore.setContactInfo?.(jid, info) } catch {}
              try { await store.dataStore.setContactName?.(jid, name) } catch {}
              try { logger.info('CONTACT_CACHE set: jid=%s name=%s pn=%s lid=%s', jid, name || '<none>', info.pn || '<none>', info.lidJid || '<none>') } catch {}
            }
          }
        }
        try {
          if (Array.isArray(list) && list.length > 0) {
            await setContactSyncPending(this.phone, CONTACT_SYNC_PENDING_TTL_SEC)
          }
        } catch {}
      } catch {}
    })
    this.event('contacts.upsert' as any, async (list: any[]) => {
      try {
        const store = this.store
        if (store && Array.isArray(list)) {
          for (const c of list) {
            const jid = c?.id || c?.jid
            const name = (c?.verifiedName || c?.businessName || c?.name || c?.notify || '').toString().trim()
            if (jid && name) {
              const info: any = { name }
              if (isLidUser(jid)) {
                info.lidJid = jid
                try {
                  const mapped = await store.dataStore.getPnForLid?.(this.phone, jid)
                  if (mapped && isPnUser(mapped)) {
                    info.pnJid = mapped
                    try { info.pn = jidToRawPhoneNumber(mapped, '').replace('+','') } catch {}
                  }
                  // Não derive PN apenas por normalização do LID; aguarde mapping/exists válido
                } catch {}
              } else {
                info.pnJid = jid
                try { info.pn = jidToRawPhoneNumber(jid, '').replace('+','') } catch {}
                try {
                  const lid = await store.dataStore.getLidForPn?.(this.phone, jid)
                  if (typeof lid === 'string' && lid.endsWith('@lid')) {
                    if (!info.lidJid) info.lidJid = lid
                  }
                } catch {}
              }
              try { await store.dataStore.setContactInfo?.(jid, info) } catch {}
              try { await store.dataStore.setContactName?.(jid, name) } catch {}
              try { logger.info('CONTACT_CACHE upsert: jid=%s name=%s pn=%s lid=%s', jid, name || '<none>', info.pn || '<none>', info.lidJid || '<none>') } catch {}
            }
          }
        }
      } catch {}
    })
    this.event('contacts.update' as any, async (list: any[]) => {
      try {
        const store = this.store
        if (store && Array.isArray(list)) {
          for (const c of list) {
            const jid = c?.id || c?.jid
            const name = c?.verifiedName || c?.businessName || c?.name || c?.notify
            if (jid && name) {
              try { await store.dataStore.setContactName?.(jid, `${name}`) } catch {}
            }
          }
        }
      } catch {}
    })
    // Track LID<->PN mapping updates from Baileys to feed DataStore cache
    this.event('lid-mapping.update' as any, async (updates: any) => {
      try {
        const sample = updates.slice(0, 2).map((u: any) => ({ from: u?.from, to: u?.to }))
        logger.debug('lid-mapping.update %s count=%s sample=%s', this.phone, updates.length, JSON.stringify(sample))
      } catch {}
      // Persistir PN<->LID quando vierem pares válidos
      try {
        const store = this.store
        if (store && Array.isArray(updates)) {
          for (const u of updates as any[]) {
            try {
              const a = `${u?.from || ''}`
              const b = `${u?.to || ''}`
              if (!a || !b) continue
              // Normalize apenas no formato de transporte; não reescreve PN com 9º dígito.
              let j1 = a; let j2 = b
              try { j1 = normalizeTransportJid(a) } catch {}
              try { j2 = normalizeTransportJid(b) } catch {}
              // Identificar papéis PN/LID
              let pnJid: string | undefined
              let lidJid: string | undefined
              try {
                if (isPnUser(j1) && isLidUser(j2)) { pnJid = j1; lidJid = j2 }
                else if (isLidUser(j1) && isPnUser(j2)) { pnJid = j2; lidJid = j1 }
              } catch {}
              if (pnJid && lidJid) {
                try { logger.info('lid-mapping.observed %s: %s <-> %s', this.phone, pnJid, lidJid) } catch {}
              }
            } catch {}
          }
        }
      } catch {}
    })
    this.event('message-receipt.update', async (updates: object[]) => {
      try {
        for (const u of Array.isArray(updates) ? (updates as any[]) : []) {
          const key = u?.key || {}
          for (const field of ['remoteJid', 'participant', 'senderLid', 'participantLid', 'recipientLid']) {
            const normalized = normalizeLidJid(key[field])
            if (normalized) key[field] = normalized
          }
          const attrs = u?.attrs || u?.receipt?.attrs
          if (attrs) {
            for (const field of ['from', 'to', 'participant', 'recipient']) {
              const normalized = normalizeLidJid(attrs[field])
              if (normalized) attrs[field] = normalized
            }
          }
        }
      } catch {}
      // Para mensagens de grupo, quando habilitado, ignorar recibos individuais (read/played/delivery por participante)
      try {
        if (this.config.ignoreGroupIndividualReceipts) {
          const list = Array.isArray(updates) ? (updates as any[]) : []
          const isGroupUpdate = (u: any) => {
            const jid = u?.key?.remoteJid || u?.remoteJid || u?.attrs?.from
            return typeof jid === 'string' && jid.endsWith('@g.us')
          }
          const groupUpdates = list.filter(isGroupUpdate)
          const filtered = list.filter((u: any) => !isGroupUpdate(u))
          if (groupUpdates.length) {
            const store = this.store
            const dataStore = store?.dataStore
            const seen = new Set<string>()
            const synthetic: any[] = []
            const rankStatus = (s: string) => ({ failed:0, progress:1, pending:1, sent:2, delivered:3, read:4, deleted:5 }[`${s}`] ?? -1)
            for (const u of groupUpdates) {
              const key = u?.key || {}
              const jid = key?.remoteJid || u?.remoteJid || u?.attrs?.from
              const id = key?.id
              if (!jid || !id) continue
              if (key?.fromMe === false) continue
              const dedupeKey = `${jid}|${id}`
              if (seen.has(dedupeKey)) continue
              seen.add(dedupeKey)
              let statusId = id
              try {
                const mapped = await dataStore?.loadUnoId?.(id)
                if (mapped) statusId = mapped
              } catch {}
              try {
                const current = await dataStore?.loadStatus?.(statusId)
                if (current && rankStatus(current) >= rankStatus('delivered')) continue
              } catch {}
              let tsRaw: any = u?.receipt?.t || u?.receipt?.receiptTimestamp || u?.receipt?.readTimestamp
              let tsNum = parseInt(`${tsRaw || ''}`, 10)
              if (!Number.isFinite(tsNum) || tsNum <= 0) {
                tsNum = Math.floor(Date.now() / 1000)
              } else if (tsNum > 1000000000000) {
                tsNum = Math.floor(tsNum / 1000)
              }
              synthetic.push({
                key: { ...key, remoteJid: jid, id },
                receipt: { receiptTimestamp: tsNum },
              })
            }
            if (synthetic.length) {
              try {
                logger.info('Group receipt synth %s: delivered=%s from=%s', this.phone, synthetic.length, groupUpdates.length)
              } catch {}
              await this.listener.process(this.phone, synthetic as any, 'update')
            }
          }
          if (filtered.length === 0) {
            logger.debug('message-receipt.update %s ignorado para grupos (0 itens)', this.phone)
            return
          }
          try {
            const sample = filtered.slice(0, 2).map((u: any) => ({ jid: u?.key?.remoteJid, id: u?.key?.id, type: (u as any)?.receipt?.type, ts: (u as any)?.receipt?.t }))
            logger.debug('message-receipt.update %s count=%s sample=%s', this.phone, filtered.length, JSON.stringify(sample))
          } catch { logger.debug('message-receipt.update %s count=%s', this.phone, filtered.length) }
          await this.listener.process(this.phone, filtered as any, 'update')
          return
        }
      } catch {}
      try {
        const sample = updates.slice(0, 2).map((u: any) => ({ jid: (u as any)?.key?.remoteJid, id: (u as any)?.key?.id, type: (u as any)?.receipt?.type, ts: (u as any)?.receipt?.t }))
        logger.debug('message-receipt.update %s count=%s sample=%s', this.phone, updates.length, JSON.stringify(sample))
      } catch { logger.debug('message-receipt.update %s count=%s', this.phone, updates.length) }
      await this.listener.process(this.phone, updates, 'update')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.event('messages.delete', (updates: any) => {
      try {
        const sample = updates.slice(0, 2).map((u: any) => ({ jid: u?.key?.remoteJid, id: u?.key?.id }))
        logger.debug('messages.delete %s count=%s sample=%s', this.phone, updates.length, JSON.stringify(sample))
      } catch { logger.debug('messages.delete %s count=%s', this.phone, updates.length) }
      this.listener.process(this.phone, updates, 'delete')
    })
    if (!this.config.ignoreHistoryMessages) {
      logger.info('Config import history messages %', this.phone)
      this.event('messaging-history.set', async ({
        messages,
        isLatest,
        syncType,
        chunkOrder,
        progress,
      }: {
        messages: proto.IWebMessageInfo[]
        isLatest?: boolean
        syncType?: proto.HistorySync.HistorySyncType | null
        chunkOrder?: number | null
        progress?: number | null
      }) => {
        const sampleMediaMessage = (list: proto.IWebMessageInfo[] = []) => {
          for (const item of list) {
            try {
              const normalized = normalizeMessageContent(item?.message)
              const mt = normalized && getMessageType({ message: normalized as any })
              const media = mt && TYPE_MESSAGES_MEDIA.includes(mt.replace('Message', ''))
                ? (normalized as any)?.[mt]
                : undefined
              if (!media) continue
              return {
                id: `${item?.key?.id || ''}`.trim(),
                remoteJid: `${item?.key?.remoteJid || ''}`.trim(),
                type: mt,
                timestamp: Number(item?.messageTimestamp || 0) || undefined,
                hasMediaKey: !!media.mediaKey,
                mediaKeyLength: media.mediaKey
                  ? (() => {
                      try {
                        if (media.mediaKey instanceof Uint8Array) return media.mediaKey.length
                        if (typeof media.mediaKey === 'string') return media.mediaKey.length
                        if (Array.isArray(media.mediaKey?.data)) return media.mediaKey.data.length
                        return Object.keys(media.mediaKey || {}).length || 0
                      } catch {
                        return 0
                      }
                    })()
                  : 0,
                hasDirectPath: !!media.directPath,
                hasUrl: !!media.url,
                mimetype: `${media.mimetype || ''}`.trim() || undefined,
                fileName: `${media.fileName || ''}`.trim() || undefined,
              }
            } catch {}
          }
          return undefined
        }
        const summarizeMedia = (list: proto.IWebMessageInfo[] = []) => {
          let withMedia = 0
          let withMediaKey = 0
          let withDirectPath = 0
          let withUrl = 0
          for (const item of list) {
            try {
              const normalized = normalizeMessageContent(item?.message)
              const mt = normalized && getMessageType({ message: normalized as any })
              const media = mt && TYPE_MESSAGES_MEDIA.includes(mt.replace('Message', ''))
                ? (normalized as any)?.[mt]
                : undefined
              if (!media) continue
              withMedia++
              if (media.mediaKey) withMediaKey++
              if (media.directPath) withDirectPath++
              if (media.url) withUrl++
            } catch {}
          }
          return { withMedia, withMediaKey, withDirectPath, withUrl }
        }
        const syncTypeName = typeof syncType === 'number'
          ? proto.HistorySync.HistorySyncType[syncType] || `${syncType}`
          : `${syncType || 'unknown'}`
        const cutoffSec = Math.floor((Date.now() - HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) / 1000)
        const filtered = (messages || []).filter((m) => {
          const ts = Number(m?.messageTimestamp || 0)
          return Number.isFinite(ts) && ts >= cutoffSec
        })
        const rawSummary = summarizeMedia(messages || [])
        const filteredSummary = summarizeMedia(filtered)
        const rawSample = sampleMediaMessage(messages || [])
        const filteredSample = sampleMediaMessage(filtered)
        logger.info(
          'Importing history messages syncType=%s chunkOrder=%s progress=%s (<= %sd): %d -> %d, isLatest %s media raw=%j filtered=%j sampleRaw=%j sampleFiltered=%j %s',
          syncTypeName,
          `${chunkOrder ?? '<none>'}`,
          `${progress ?? '<none>'}`,
          HISTORY_MAX_AGE_DAYS,
          messages?.length || 0,
          filtered.length,
          isLatest,
          rawSummary,
          filteredSummary,
          rawSample,
          filteredSample,
          this.phone,
        )
        if (filtered.length) {
          this.listener.process(this.phone, filtered, 'history')
        }
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.event('call', async (events: any[]) => {
      for (let i = 0; i < events.length; i++) {
        const event = events[i] || {}
        const from = event?.from
        const id = event?.id
        const status = event?.status
        const callerPn = event?.callerPn || event?.caller_pn
        try {
          logger.info('CALL event: from=%s callerPn=%s id=%s status=%s', from, callerPn || '<none>', id, status)
        } catch {}
        try {
          await this.notifyVoipServiceCallEvent(event)
        } catch {}
        await this.handleIncomingCallRejection(event)
      }
    })
    this.event('call.raw' as any, async (node: BinaryNode) => {
      await this.forwardVoipSignalingNode(node)
    })
  }

  async logout() {
    logger.debug('Logout client store for %s', this?.phone)
    await this.socketLogout()
    await this.disconnect()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(payload: any, options: any = {}) {
    /**
     * Send a message using the underlying Baileys socket.
     *
     * @param payload Cloud API-like payload (type, to, content objects)
     * @param options Extra Baileys options (e.g., composing, addressingMode, statusJidList)
     * @returns Response with Cloud API-compatible shape and optional error object
     */
    const { status, type } = payload
    let { to } = payload
    try {
      if (status) {
        if (['sent', 'delivered', 'failed', 'progress', 'read', 'deleted'].includes(status)) {
          if (status == 'read') {
            const currentStatus = await this.store?.dataStore?.loadStatus(payload?.message_id)
            if (currentStatus != status) {
              const key = await this.store?.dataStore?.loadKey(payload?.message_id)
              try { logger.debug('key (jid=%s id=%s) for %s', key?.remoteJid, key?.id, payload?.message_id) } catch {}
              if (key?.id) {
                if (key?.id.indexOf('-') > 0) {
                  logger.debug('Ignore read message for %s with key id %s reading message key %s...', this.phone, key?.id)
                } else {
                  try { logger.debug('baileys %s reading message (jid=%s id=%s)...', this.phone, key?.remoteJid, key?.id) } catch {}
                  if (await this.readMessages([key])) {
                    await this.store?.dataStore?.setStatus(payload?.message_id, status)
                    try { logger.debug('baileys %s read message (jid=%s id=%s)!', this.phone, key?.remoteJid, key?.id) } catch {}
                  } else {
                    try { logger.debug('baileys %s not read message (jid=%s id=%s)!', this.phone, key?.remoteJid, key?.id) } catch {}
                    throw `not online session ${this.phone}`
                  }
                }
              }
            } else {
              logger.debug('baileys %s already read message id %s!', this.phone, payload?.message_id)
            }
          } else if (status == 'deleted') {
            const key = await this.store?.dataStore?.loadKey(payload?.message_id)
            try { logger.debug('key (jid=%s id=%s) for %s', key?.remoteJid, key?.id, payload?.message_id) } catch {}
            if (key?.id) {
              if (key?.id.indexOf('-') > 0) {
                logger.debug('Ignore delete message for %s with key id %s reading message key %s...', this.phone, key?.id)
              } else {
                try { logger.debug('baileys %s deleting message (jid=%s id=%s)...', this.phone, key?.remoteJid, key?.id) } catch {}
                if (await this.sendMessage(key.remoteJid!, { delete: key }, {})) {
                  await this.store?.dataStore?.setStatus(payload?.message_id, status)
                  try { logger.debug('baileys %s delete message (jid=%s id=%s)!', this.phone, key?.remoteJid, key?.id) } catch {}
                } else {
                  try { logger.debug('baileys %s not delete message (jid=%s id=%s)!', this.phone, key?.remoteJid, key?.id) } catch {}
                  throw `not online session ${this.phone}`
                }
              }
            }
          } else {
            await this.store?.dataStore?.setStatus(payload?.message_id, status)
          }
          const r: Response = { ok: { success: true } }
          return r
        } else {
          throw new Error(`Unknow message status ${status}`)
        }
      } else if (type) {
        if (['text', 'message_edit', 'image', 'audio', 'sticker', 'document', 'video', 'template', 'interactive', 'contacts', 'reaction', 'baileys'].includes(type)) {
          let content
          let targetTo = to
          if (payload?.recipient_type === 'group' || `${targetTo || ''}`.endsWith('@g.us')) {
            targetTo = normalizeGroupId(targetTo)
            to = targetTo
          }
          const extraSendOptions: any = {}
          if ('reaction' === type) {
            const reaction = payload?.reaction || {}
            const messageId =
              reaction?.message_id ||
              reaction?.messageId ||
              payload?.message_id ||
              payload?.context?.message_id ||
              payload?.context?.id
            if (!messageId) {
              throw new SendError(400, 'invalid_reaction_payload: missing message_id')
            }
            const dataStore = this.store?.dataStore
            let providerId: string | undefined
            let key = undefined as any
            try {
              providerId = await dataStore?.loadProviderId?.(messageId)
            } catch {}
            if (!providerId) {
              try {
                const unoFromProvider = await dataStore?.loadUnoId?.(messageId)
                if (unoFromProvider) providerId = messageId
              } catch {}
            }
            if (providerId) {
              key = await dataStore?.loadKey(providerId)
            }
            if (!key) {
              key = await dataStore?.loadKey(messageId)
            }
            if (!key || !key.id || !key.remoteJid) {
              throw new SendError(404, `reaction_message_not_found: ${messageId}`)
            }
            const emojiRaw = typeof reaction?.emoji !== 'undefined'
              ? reaction.emoji
              : (typeof reaction?.text !== 'undefined' ? reaction.text : reaction?.value)
            const emoji = `${emojiRaw ?? ''}`
            let reactionKey = providerId && key.id !== providerId ? { ...key, id: providerId } : key
            try {
              const original = await dataStore?.loadMessage?.(reactionKey.remoteJid, reactionKey.id)
              if (original?.key) {
                reactionKey = { ...original.key, id: reactionKey.id }
                if (typeof reactionKey.participant === 'string' && reactionKey.participant.trim() === '') {
                  delete (reactionKey as any).participant
                }
              }
            } catch {}
            try {
              logger.info(
                'REACTION send: msgId=%s providerId=%s key.id=%s key.remoteJid=%s key.participant=%s',
                messageId,
                providerId || '<none>',
                reactionKey?.id || '<none>',
                reactionKey?.remoteJid || '<none>',
                (reactionKey as any)?.participant || '<none>',
              )
            } catch {}
            content = { react: { text: emoji, key: reactionKey } }
            targetTo = reactionKey.remoteJid
            to = targetTo
            extraSendOptions.forceRemoteJid = reactionKey.remoteJid
            extraSendOptions.skipBrSendOrder = true
          } else if ('message_edit' === type) {
            const messageId =
              payload?.context?.message_id ||
              payload?.context?.id ||
              payload?.edit?.message_id ||
              payload?.edit?.messageId ||
              payload?.message_id
            if (!messageId) {
              throw new SendError(400, 'invalid_message_edit_payload: missing context.message_id')
            }
            const dataStore = this.store?.dataStore
            let providerId: string | undefined
            let editKey = undefined as any
            try {
              providerId = await dataStore?.loadProviderId?.(messageId)
            } catch {}
            if (!providerId) {
              try {
                const unoFromProvider = await dataStore?.loadUnoId?.(messageId)
                if (unoFromProvider) providerId = messageId
              } catch {}
            }
            if (providerId) {
              editKey = await dataStore?.loadKey(providerId)
            }
            if (!editKey) {
              editKey = await dataStore?.loadKey(messageId)
            }
            if (!editKey || !editKey.id || !editKey.remoteJid) {
              throw new SendError(404, `message_edit_original_not_found: ${messageId}`)
            }
            if (providerId && editKey.id !== providerId) {
              editKey = { ...editKey, id: providerId }
            }
            try {
              const original = await dataStore?.loadMessage?.(editKey.remoteJid, editKey.id)
              if (original?.key) {
                editKey = { ...original.key, id: editKey.id }
                if (typeof editKey.participant === 'string' && editKey.participant.trim() === '') {
                  delete (editKey as any).participant
                }
              }
            } catch {}
            if (editKey?.fromMe) {
              delete (editKey as any).participant
            }
            editKey = sanitizeMessageEditKey(editKey)
            content = toBaileysMessageContent(payload, this.config.customMessageCharactersFunction)
            await this.remapMentionsToLidForGroup(targetTo, content as any, payload)
            ;(content as any).edit = editKey
            targetTo = editKey.remoteJid
            to = targetTo
            extraSendOptions.forceRemoteJid = editKey.remoteJid
            extraSendOptions.skipBrSendOrder = true
          } else if ('template' === type) {
            const template = new Template(this.getConfig)
            content = await template.bind(this.phone, payload.template.name, payload.template.components)
          } else {
            if (VALIDATE_MEDIA_LINK_BEFORE_SEND && TYPE_MESSAGES_MEDIA.includes(type)) {
              const link = payload[type] && payload[type].link
              if (link) {
                // Algumas URLs presignadas (S3/CDN) são específicas de método (GET) e podem retornar 403 no HEAD.
                // Estratégia: tentar HEAD; se não ok e for erro plausível de método/permissão, tentar GET com Range: bytes=0-0.
                const tryHead = async () => {
                  try { return await fetch(link, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'HEAD' }) } catch (e) { return undefined as any }
                }
                const tryRangeGet = async () => {
                  try {
                    return await fetch(link, {
                      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                      method: 'GET',
                      headers: { Range: 'bytes=0-0' },
                    })
                  } catch (e) { return undefined as any }
                }
                let ok = false
                let status = 0
                let resp = await tryHead()
                if (resp && resp.ok) { ok = true; status = resp.status }
                if (!ok) {
                  status = resp ? resp.status : 0
                  // Tentar GET com range mínimo para validar disponibilidade
                  resp = await tryRangeGet()
                  if (resp && resp.ok) { ok = true; status = resp.status }
                }
                if (!ok) {
                  throw new SendError(11, t('invalid_link', status || 'fetch_error', link))
                }
              }
            }
            try {
              const requestId = `${payload?._requestId || payload?.requestId || '<none>'}`
              logger.info(
                'MENTION_IN req=%s payload to=%s type=%s mentionAll=%s mentions=%s body="%s"',
                requestId,
                `${payload?.to || '<none>'}`,
                `${payload?.type || '<none>'}`,
                !!(payload?.mentionAll || payload?.text?.mentionAll),
                JSON.stringify(payload?.mentions || payload?.text?.mentions || []),
                `${payload?.text?.body || ''}`.slice(0, 200),
              )
            } catch {}
            content = toBaileysMessageContent(payload, this.config.customMessageCharactersFunction)
            if (type === 'contacts') {
              await this.normalizeContactCardsForAuthCache(content)
            }
            await this.remapMentionsToLidForGroup(targetTo, content as any, payload)
            try {
              const requestId = `${payload?._requestId || payload?.requestId || '<none>'}`
              logger.info(
                'MENTION_SEND req=%s content to=%s mentionAll=%s mentions=%s text="%s"',
                requestId,
                `${payload?.to || '<none>'}`,
                !!(content as any)?.mentionAll,
                JSON.stringify((content as any)?.mentions || []),
                `${(content as any)?.text || ''}`.slice(0, 200),
              )
            } catch {}
            if (CONVERT_AUDIO_MESSAGE_TO_OGG && content.audio && content.ptt) {
              try {
                const url = content.audio?.url
                if (url) {
                  const { buffer, waveform, mimetype: outType } = await convertToOggPtt(url, FETCH_TIMEOUT_MS)
                  content.audio = buffer
                  content.waveform = waveform
                  content.mimetype = outType || 'audio/ogg; codecs=opus'
                  content.ptt = true
                  logger.debug('Audio converted to OGG/Opus PTT for %s', url)
                } else {
                  logger.debug('Skip audio conversion (not mp3 or missing url). url: %s', url)
                }
              } catch (err) {
                logger.warn(err, 'Ignore error converting audio to ogg sending original')
              }
            }
            if (type === 'sticker') {
              try {
                const stickerPayload: any = payload?.sticker || {}
                const stickerLink = stickerPayload?.link || (content as any)?.sticker?.url
                const cleanLink = `${stickerLink || ''}`.split('?')[0].split('#')[0]
                const stickerMimeRaw = `${stickerPayload?.mime_type || stickerPayload?.mimetype || (content as any)?.mimetype || ''}`.toLowerCase()
                const isWebp = stickerMimeRaw.includes('webp') || cleanLink.toLowerCase().endsWith('.webp')
                if (stickerLink && !isWebp && typeof (content as any)?.sticker === 'object' && (content as any)?.sticker?.url) {
                  const resp = await fetch(stickerLink, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'GET' })
                  if (!resp?.ok) {
                    throw new Error(`sticker_download_failed: ${resp?.status || 0}`)
                  }
                  const MAX_STICKER_BYTES = 8 * 1024 * 1024
                  const contentLength = Number(resp.headers.get('content-length') || 0)
                  if (contentLength && contentLength > MAX_STICKER_BYTES) {
                    throw new Error(`sticker_too_large: ${contentLength}`)
                  }
                  const contentType = `${resp.headers.get('content-type') || ''}`.toLowerCase()
                  const isAnimated = contentType.includes('gif') || cleanLink.toLowerCase().endsWith('.gif')
                  const arrayBuffer = await resp.arrayBuffer()
                  if (arrayBuffer.byteLength > MAX_STICKER_BYTES) {
                    throw new Error(`sticker_too_large: ${arrayBuffer.byteLength}`)
                  }
                  const buf = Buffer.from(arrayBuffer)
                  const webp = await convertToWebpSticker(buf, { animated: isAnimated })
                  ;(content as any).sticker = webp
                  ;(content as any).mimetype = 'image/webp'
                  logger.debug('Sticker converted to webp for %s', stickerLink)
                }
              } catch (err) {
                logger.warn(err, 'Ignore error converting sticker to webp sending original')
              }
            }
          }
          let quoted: WAMessage | undefined = undefined
          let disappearingMessagesInChat: boolean | number = false
          const messageId = type === 'message_edit' ? undefined : payload?.context?.message_id || payload?.context?.id
          if (messageId) {
            const dataStore = this.store?.dataStore
            let providerId: string | undefined
            let key: any = undefined
            try {
              providerId = await dataStore?.loadProviderId?.(messageId)
            } catch {}
            if (!providerId) {
              try {
                const unoFromProvider = await dataStore?.loadUnoId?.(messageId)
                if (unoFromProvider) providerId = messageId
              } catch {}
            }
            try {
              logger.info(
                {
                  phone: this.phone,
                  targetTo,
                  messageId,
                  providerId,
                },
                'reply quote lookup start'
              )
            } catch {}
            if (providerId) {
              key = await dataStore?.loadKey(providerId)
            }
            if (!key) {
              key = await dataStore?.loadKey(messageId)
            }
            try { logger.debug('Quoted message key %s (providerId=%s)!', key?.id, providerId) } catch {}
            if (key?.id) {
              const candidateIds = Array.from(new Set([
                providerId,
                key?.id,
                messageId,
                await dataStore?.loadProviderId?.(key?.id),
                await dataStore?.loadUnoId?.(key?.id),
              ].filter((v): v is string => typeof v === 'string' && !!v)))
              const candidateJids = Array.from(new Set([
                key?.remoteJid,
                targetTo,
                (() => { try { return phoneNumberToJid(targetTo) } catch { return undefined } })(),
                (() => { try { return normalizeTransportJid(key?.remoteJid) } catch { return key?.remoteJid } })(),
              ].filter((v): v is string => typeof v === 'string' && !!v)))

              for (const candidateJid of candidateJids) {
                for (const candidateId of candidateIds) {
                  quoted = await dataStore?.loadMessage(candidateJid, candidateId)
                  if (quoted) break
                }
                if (quoted) break
              }

              try {
                const qid = quoted?.key?.id
                const qjid = quoted?.key?.remoteJid
                const qtype = quoted?.message ? Object.keys(quoted.message)[0] : 'unknown'
                logger.info(
                  {
                    phone: this.phone,
                    targetTo,
                    messageId,
                    providerId,
                    quotedFound: !!quoted,
                    quotedId: qid,
                    quotedRemoteJid: qjid,
                    quotedType: qtype,
                    candidateJids,
                    candidateIds,
                  },
                  'reply quote lookup result'
                )
              } catch { logger.debug('Quoted message loaded') }
            }
          }
          if (payload?.ttl) {
            disappearingMessagesInChat = payload.ttl
          }
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const sockDelays = delays.get(this.phone) || (delays.set(this.phone, new Map<string, Delay>()) && delays.get(this.phone)!)
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const toDelay = sockDelays.get(targetTo) || (async (_phone: string, to) => sockDelays.set(to, this.delayBeforeSecondMessage))
          await toDelay(this.phone, targetTo)
          // Prefetch foto de perfil do destino (1:1 ou grupo) para garantir cache atualizado em FS/S3
          try {
            if (this.config.sendProfilePicture && typeof targetTo === 'string') {
              const prefetchJid = targetTo.includes('@') ? targetTo : phoneNumberToJid(targetTo)
              logger.info('PROFILE_PICTURE prefetch start: %s', prefetchJid)
              const fetched = await this.fetchImageUrl(prefetchJid)
              logger.info('PROFILE_PICTURE prefetch done: %s -> %s', prefetchJid, fetched || '<none>')
            }
          } catch (e) {
            try {
              const prefetchJid = targetTo.includes('@') ? targetTo : phoneNumberToJid(targetTo)
              logger.warn(e as any, 'PROFILE_PICTURE prefetch error for %s', prefetchJid)
            } catch { logger.warn(e as any, 'PROFILE_PICTURE prefetch error') }
          }
          let response
          // merge base options and ensure status broadcast defaults when applicable
          const messageOptions: any = {
            composing: this.config.composingMessage,
            quoted,
            disappearingMessagesInChat,
            ...options,
            ...extraSendOptions,
          }
          // Apply addressing mode para grupos
          // Se GROUP_SEND_ADDRESSING_MODE estiver setada, respeita. Caso contrário, usa LID por padrão
          // para reduzir "session not found" em grupos grandes.
          try {
            if (targetTo && targetTo.endsWith('@g.us')) {
              let applied = ''
              if (GROUP_SEND_ADDRESSING_MODE) {
                const preferred = GROUP_SEND_ADDRESSING_MODE
                const mode = preferred === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN
                messageOptions.addressingMode = mode
                applied = preferred
              }
              // Caso não haja preferência via env, usar LID por padrão
              if (!applied) {
                messageOptions.addressingMode = WAMessageAddressingMode.LID
                applied = 'lid'
              }
              if (!applied) {
                // Fallback: don't force; let Baileys decide
                delete (messageOptions as any).addressingMode
                applied = 'auto'
              }
              logger.debug('Applied group addressingMode %s for %s', applied, targetTo)
            }
          } catch (e) {
            logger.warn(e, 'Ignore error applying group addressingMode')
          }
          // Soft membership check: warn when not found, but do not block send
          if (targetTo && targetTo.endsWith('@g.us') && GROUP_SEND_MEMBERSHIP_CHECK) {
            try {
              const gm = await this.fetchGroupMetadata(targetTo)
              const myId = jidNormalizedUser(this.store?.state.creds.me?.id)
              const participants = gm?.participants || []
              const isParticipant = participants.length > 0 && !!participants.find?.((p: any) => {
                const anyId = p?.id || p?.jid || p?.lid
                try {
                  return anyId && jidNormalizedUser(anyId) === myId
                } catch {
                  return false
                }
              })
              if (!isParticipant) {
                logger.warn('Membership not verified for group %s (self: %s, participants: %s) — proceeding to send', targetTo, myId, participants.length)
              }
            } catch (err) {
              logger.warn(err, 'Ignore error on group membership check; proceeding to send')
            }
          }
          if (targetTo === 'status@broadcast') {
            if (typeof messageOptions.broadcast === 'undefined') messageOptions.broadcast = true
            if (typeof messageOptions.statusJidList === 'undefined') messageOptions.statusJidList = []
          }
          if (content?.listMessage) {
            if (UNOAPI_DEBUG_BAILEYS_LIST_DUMP) {
              try {
                logger.debug('baileys list send content=%s', JSON.stringify(content))
              } catch {
                logger.debug('baileys list send content')
              }
            }
            const trySendOnce = async () => this.sendMessage(targetTo, content, messageOptions)
            try {
              response = await trySendOnce()
            } catch (firstErr) {
              throw firstErr
            }
          } else {
            // Envio com retry para mídia: em caso de erro de link (11), aguardamos e tentamos de novo
            const trySendOnce = async () => this.sendMessage(targetTo, content, messageOptions)
            try {
              response = await trySendOnce()
            } catch (firstErr) {
              // Só retry para falha de link (403/invalid_link) — codificamos em SendError(11) no catch inferior
              // Aqui apenas guardamos; a lógica de retry acontecerá no catch de SendError logo abaixo
              throw firstErr
            }
          }

          if (response) {
            // Evita JSON.stringify no WAProto (pode disparar Long.toString com this incorreto)
            try {
              const requestId = `${payload?._requestId || payload?.requestId || '<none>'}`
              const summary = {
                requestId,
                key: {
                  id: (response as any)?.key?.id,
                  remoteJid: (response as any)?.key?.remoteJid,
                  fromMe: (response as any)?.key?.fromMe,
                  participant: (response as any)?.key?.participant,
                },
                messageType: (() => {
                  try { return Object.keys((response as any)?.message || {})[0] } catch { return undefined }
                })(),
                messageTimestamp: (response as any)?.messageTimestamp,
                status: (response as any)?.status,
              }
              logger.info('SEND_OK %s', JSON.stringify(summary))
            } catch {
              try {
                const requestId = `${payload?._requestId || payload?.requestId || '<none>'}`
                logger.info('SEND_OK req=%s (jid=%s id=%s)', requestId, (response as any)?.key?.remoteJid, (response as any)?.key?.id)
              } catch { logger.info('SEND_OK') }
            }
            const key = response.key
            const externalId = await this.ensureUnoExternalMessageId(key)
            await this.store?.dataStore?.setKey(key.id, key)
            await this.store?.dataStore?.setMessage(key.remoteJid, response)
            const ok = buildSendOkResponse(to, externalId || key.id)
            try {
              if (to === 'status@broadcast') {
                const skipped = (response as any).__statusSkipped || []
                // expose auxiliary info without breaking Cloud API shape
                ;(ok as any).status_skipped = skipped
                ;(ok as any).status_recipients = Array.isArray((messageOptions as any).statusJidList)
                  ? (messageOptions as any).statusJidList.length
                  : 0
              }
            } catch {}
            const r: Response = { ok }
            return r
          }
        } else {
          throw new Error(`Unknow message type ${type}`)
        }
      }
    } catch (ee) {
      let e = ee
      if (isRetryableStaleSendError(e) && !(options as any)?.__staleReconnectRetried) {
        const retryPayload = getRetryableStaleSendPayload(e)
        if (retryPayload?.targetJid) {
          logger.warn('Retrying stale send after reconnect for %s to %s', this.phone, retryPayload.targetJid)
          await this.close()
          await this.connect(1)
          const retryMessage = retryPayload.fullMessage?.message || toBaileysMessageContent(payload, this.config.customMessageCharactersFunction)
          const retryOptions = { ...(retryPayload.relayOptions || {}), __staleReconnectRetried: true }
          const response = await this.sendMessage(retryPayload.targetJid, retryMessage as any, retryOptions)
          if (response) {
            const key = response.key
            const externalId = await this.ensureUnoExternalMessageId(key)
            await this.store?.dataStore?.setKey(key.id, key)
            await this.store?.dataStore?.setMessage(key.remoteJid, response)
            const ok = buildSendOkResponse(to, externalId || key.id)
            const r: Response = { ok }
            return r
          }
        }
      }
      if (ee.message == 'Media upload failed on all hosts') {
        const link = payload[type] && payload[type].link
        if (link) {
          // HEAD pode retornar 403 em URLs presignadas GET-only; tentar GET com Range como fallback
          const tryHead = async () => {
            try { return await fetch(link, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'HEAD' }) } catch (e) { return undefined as any }
          }
          const tryRangeGet = async () => {
            try {
              return await fetch(link, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'GET', headers: { Range: 'bytes=0-0' } })
            } catch (e) { return undefined as any }
          }
          let ok = false; let status = 0; let resp = await tryHead()
          if (resp && resp.ok) { ok = true; status = resp.status }
          if (!ok) { status = resp ? resp.status : 0; resp = await tryRangeGet(); if (resp && resp.ok) { ok = true; status = resp.status } }
          if (!ok) { e = new SendError(11, t('invalid_link', status || 'fetch_error', link)) }
        } else {
          e = new SendError(11, ee.message)
        }
      }
      if (e instanceof SendError) {
        const code = e.code
        const title = e.title
        // Retry de mídia quando o presigned ainda não está disponível (erro de link)
        try {
          const asStr = `${code}`
          const link = payload?.[type]?.link
          const mayRetry = MEDIA_RETRY_ENABLED && asStr === '11' && link && ['image','audio','video','document','sticker'].includes(type)
          if (mayRetry && !(options && options.__mediaRetried)) {
            const delays = (MEDIA_RETRY_DELAYS_MS || []).slice(0, 5)
            for (const waitMs of delays) {
              try {
                await delay(waitMs)
                const retryContent = toBaileysMessageContent(payload, this.config.customMessageCharactersFunction)
                const toJid = (typeof to === 'string' && to.includes('@')) ? to : phoneNumberToJid(to)
                const messageOptions: any = { ...(options || {}), __mediaRetried: true }
                const resp = await this.sendMessage(toJid, retryContent as any, messageOptions)
                if (resp) {
                  const key = resp.key
                  const externalId = await this.ensureUnoExternalMessageId(key)
                  await this.store?.dataStore?.setKey(key.id, key)
                  await this.store?.dataStore?.setMessage(key.remoteJid, resp)
                  const ok = buildSendOkResponse(toJid, externalId || key.id)
                  const r: Response = { ok }
                  return r
                }
              } catch (re2) {
                // Se não for mais erro de link, interrompe o retry e repassa o erro para o fluxo padrão
                if (!(re2 instanceof SendError) || `${(re2 as SendError).code}` !== '11') { throw re2 }
              }
            }
          }
        } catch {}
        // Fallback: se falhou com erro de link (403/invalid link), tente baixar nós mesmos e enviar como Buffer
        try {
          const asStr = `${code}`
          const link = payload?.[type]?.link
          const mayRetryAsBuffer = asStr === '11' && link && ['image','audio','video','document','sticker'].includes(type)
          if (mayRetryAsBuffer && !(options && options.__mediaBufferRetried)) {
            try {
              const resp: FetchResponse = await fetch(link, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'GET' })
              if (resp && resp.ok) {
                const buf = Buffer.from(await resp.arrayBuffer())
                // Recria conteúdo e troca URL por Buffer
                const content = toBaileysMessageContent(payload, this.config.customMessageCharactersFunction)
                ;(content as any)[type] = buf
                // Garante mimetype coerente se disponível no payload
                try {
                  const mt = (payload?.[type]?.mime_type || (content as any)?.mimetype) as string | undefined
                  if (mt) (content as any).mimetype = mt
                } catch {}
                // Reenvia com opções mínimas para evitar loop
                const toJid = (typeof to === 'string' && to.includes('@')) ? to : phoneNumberToJid(to)
                const messageOptions: any = { ...(options || {}), __mediaBufferRetried: true }
                const response = await this.sendMessage(toJid, content as any, messageOptions)
                if (response) {
                  const key = response.key
                  const externalId = await this.ensureUnoExternalMessageId(key)
                  await this.store?.dataStore?.setKey(key.id, key)
                  await this.store?.dataStore?.setMessage(key.remoteJid, response)
                  const ok = buildSendOkResponse(toJid, externalId || key.id)
                  const r: Response = { ok }
                  return r
                }
              }
            } catch (re) {
              try { logger.warn(re as any, 'Buffer fallback failed; keeping status failed') } catch {}
            }
          }
        } catch {}
        // Evitar poluir a conversa com erros de payload/link inválido (código 11).
        // Para esses casos, emitimos apenas o status "failed" via webhook.
        try { await this.onNotification(title, true) } catch {}
        // Retry path for session/crypto errors (No session / Bad MAC)
        if ([3, '3', 12, '12'].includes(code)) {
          try {
            // Avoid infinite loop
            if (!options || !options.__assertRetried) {
              // Prefer LID when available and trigger a fresh exists();
              // socket.send() will pre-assert sessions for 1:1 internally
              const toRaw: string = (typeof payload?.to === 'string') ? payload.to : ''
              // Normalize to JID form if needed for exists()
              let target = toRaw
              try { target = toRaw.includes('@') ? toRaw : phoneNumberToJid(toRaw) } catch {}
              try { await this.exists(target) } catch {}
              const newOptions = { ...(options || {}), __assertRetried: true }
              try { return await this.send(payload, newOptions) } catch {}
            }
          } catch {}
          // Fallback: reconnect session (legacy path)
          await this.close()
          await this.connect(1)
        }
        const id = uuid()
        const ok = {
          messaging_product: 'whatsapp',
          contacts: [
            {
              wa_id: jidToPhoneNumber(to, ''),
            },
          ],
          messages: [
            {
              id,
            },
          ],
        }
        const error = {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: this.phone,
              changes: [
                {
                  value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                      display_phone_number: this.phone,
                      phone_number_id: this.phone,
                    },
                    statuses: [
                      {
                        id,
                        recipient_id: `${to || ''}`.endsWith('@g.us') ? to : jidToPhoneNumber(to || this.phone, ''),
                        ...(`${to || ''}`.endsWith('@g.us') ? { recipient_type: 'group' } : {}),
                        status: 'failed',
                        timestamp: Math.floor(Date.now() / 1000),
                        errors: [
                          {
                            code,
                            title,
                          },
                        ],
                      },
                    ],
                  },
                  field: 'messages',
                },
              ],
            },
          ],
        }
        const r: Response = { ok, error }
        return r
      } else {
        throw e
      }
    }
    throw new Error(`Unknow message type ${JSON.stringify(payload)}`)
  }

  async getMessageMetadata<T>(message: T) {
    /**
     * Enrich an outbound/inbound message with user/group metadata and pictures when available.
     * It is safe/no-op if the session is offline.
     */
    if (!this.store || !await this.store.sessionStore.isStatusOnline(this.phone)) {
      return message
    }
    const key = message && message['key']
    try {
      if (key) {
        for (const field of ['remoteJid', 'participant', 'senderLid', 'participantLid', 'recipientLid']) {
          const normalized = normalizeLidJid(key[field])
          if (normalized) key[field] = normalized
        }
      }
    } catch {}
    let remoteJid
    if (key.remoteJid && isJidGroup(key.remoteJid)) {
      logger.debug(`Retrieving group metadata...`)
      remoteJid = key.participant
      let groupMetadata: GroupMetadata | undefined
      try {
        groupMetadata = await this.fetchGroupMetadata(key.remoteJid)
      } catch (error) {
        logger.warn(error, 'Ignore error fetch group metadata')
      }
      const hasFetchedGroupMetadata = !!groupMetadata
      if (groupMetadata) {
        logger.debug(groupMetadata, 'Retrieved group metadata!')
      } else {
        groupMetadata = {
          // owner_country_code: '55',
          addressingMode: isLidUser(key.remoteJid) ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
          id: key.remoteJid,
          owner: '',
          subject: key.remoteJid,
          participants: [],
        }
      }
      const gm = groupMetadata!
      // Build names map for participants (best-effort)
      try {
        const names: Record<string, string> = {}
        const store = this.store
        if (store && Array.isArray(gm.participants)) {
          for (const p of gm.participants as any[]) {
            try {
              for (const field of ['id', 'jid', 'lid']) {
                const normalized = normalizeLidJid(p?.[field])
                if (normalized) p[field] = normalized
              }
            } catch {}
            const ids: string[] = []
            if (p?.id) ids.push(p.id)
            if (p?.jid && p?.jid !== p?.id) ids.push(p.jid)
            if (p?.lid) ids.push(p.lid)
            for (const j of ids) {
              try {
                let n = await store.dataStore.getContactName?.(j)
                if (!n) {
                  // Fallback: contactInfo.name quando name não está salvo
                  try { n = (await store.dataStore.getContactInfo?.(j))?.name } catch {}
                }
                if (n) {
                  names[j] = n
                  // Add PN digits alias para replacement rápido
                  try {
                    if (!j.includes('@g.us')) {
                      const pnDigits = jidToPhoneNumber(j, '').replace('+','')
                      if (pnDigits) names[pnDigits] = n
                    }
                  } catch {}
                  // Add LID digits alias quando o id é LID (para @<lidDigits>)
                  try {
                    if (typeof j === 'string' && j.includes('@lid')) {
                      const lidDigits = j.split('@')[0].split(':')[0]
                      if (lidDigits) names[lidDigits] = n
                    }
                  } catch {}
                }
              } catch {}
            }
          }
        }
        // Also scan message text for @<digits> that may reference non-participants and enrich from contact-info
        try {
          const rawText: string = (() => {
            try { return ((message as any)?.message?.extendedTextMessage?.text || (message as any)?.message?.conversation || '').toString() } catch { return '' }
          })()
          if (rawText && /@\d{6,}/.test(rawText)) {
            const seen = new Set<string>()
            const re = /@(\d{6,})\b/g
            let m: RegExpExecArray | null
            while ((m = re.exec(rawText)) !== null) {
              const digits = (m[1] || '').toString()
              if (!digits || seen.has(digits)) continue
              seen.add(digits)
              try {
                const pnJid = `${digits}@s.whatsapp.net`
                const lidJid = `${digits}@lid`
                let nm = await store.dataStore.getContactName?.(pnJid)
                if (!nm) { try { nm = await store.dataStore.getContactName?.(lidJid) } catch {} }
                if (!nm) {
                  try { nm = (await store.dataStore.getContactInfo?.(pnJid))?.name } catch {}
                }
                if (!nm) {
                  try { nm = (await store.dataStore.getContactInfo?.(lidJid))?.name } catch {}
                }
                if (nm && nm.toString().trim()) {
                  const alias = nm.toString().trim()
                  names[digits] = alias
                  try { names[pnJid] = alias } catch {}
                  try { names[lidJid] = alias } catch {}
                }
              } catch {}
            }
          }
        } catch {}
        if (Object.keys(names).length) (gm as any)['names'] = names
      } catch {}
      message['groupMetadata'] = gm
      logger.debug(`Retrieving group profile picture...`)
      try {
        const profilePictureGroup = await this.fetchImageUrl(key.remoteJid)
        if (profilePictureGroup) {
          logger.debug(`Retrieved group picture! ${profilePictureGroup}`)
          gm['profilePicture'] = profilePictureGroup
          if (hasFetchedGroupMetadata) {
            try { await this.store?.dataStore?.setGroupMetada?.(key.remoteJid, gm) } catch {}
          }
        }
      } catch (error) {
        logger.warn(error)
        logger.warn(error, 'Ignore error on retrieve group profile picture')
      }
    } else {
      remoteJid = key.remoteJid
    }
    // Enriquecer com contactNames também para 1:1 (ajuda substituir @<digits> no body)
    try {
      const store = this.store
      if (store) {
        const names: Record<string, string> = {}
        const ids: string[] = []
        try { if (typeof key?.remoteJid === 'string') ids.push(key.remoteJid) } catch {}
        try { if (typeof key?.participant === 'string') ids.push(key.participant) } catch {}
        // tentar variantes mapeadas PN<->LID
        for (const j of Array.from(new Set(ids))) {
          try {
            let n = await store.dataStore.getContactName?.(j)
            if (!n) { try { n = (await store.dataStore.getContactInfo?.(j))?.name } catch {} }
            if (n) {
              names[j] = n
              try {
                // alias por PN digits
                if (!j.includes('@g.us')) {
                  const pnDigits = jidToPhoneNumber(j, '').replace('+','')
                  if (pnDigits) names[pnDigits] = n
                }
              } catch {}
              try {
                // alias por LID digits quando aplicável
                if (typeof j === 'string' && j.includes('@lid')) {
                  const lidDigits = j.split('@')[0]
                  if (lidDigits) names[lidDigits] = n
                }
              } catch {}
            }
            // também refletir mapeamento inverso quando existir
            try {
              if (j.includes('@lid')) {
                const pnJid = await store.dataStore.getPnForLid?.(this.phone, j)
                if (pnJid) {
                  const n2 = await store.dataStore.getContactName?.(pnJid) || n
                  if (n2) {
                    names[pnJid] = n2
                    try { const d = jidToPhoneNumber(pnJid, '').replace('+',''); if (d) names[d] = n2 } catch {}
                  }
                }
              } else if (j.includes('@s.whatsapp.net')) {
                const lid = await store.dataStore.getLidForPn?.(this.phone, j)
                if (lid) {
                  const n3 = await store.dataStore.getContactName?.(lid) || n
                  if (n3) {
                    names[lid] = n3
                  try { const d = lid.split('@')[0].split(':')[0]; if (d) names[d] = n3 } catch {}
                  }
                }
              }
            } catch {}
          } catch {}
        }
        // Também escanear o texto por @<digits> e enriquecer a partir do contact-info
        try {
          const rawText: string = (() => {
            try { return ((message as any)?.message?.extendedTextMessage?.text || (message as any)?.message?.conversation || '').toString() } catch { return '' }
          })()
          if (rawText && /@\d{6,}/.test(rawText)) {
            const seen = new Set<string>()
            const re = /@(\d{6,})\b/g
            let m: RegExpExecArray | null
            while ((m = re.exec(rawText)) !== null) {
              const digits = (m[1] || '').toString()
              if (!digits || seen.has(digits)) continue
              seen.add(digits)
              try {
                const pnJid = `${digits}@s.whatsapp.net`
                const lidJid = `${digits}@lid`
                let nm = await store.dataStore.getContactName?.(pnJid)
                if (!nm) { try { nm = await store.dataStore.getContactName?.(lidJid) } catch {} }
                if (!nm) { try { nm = (await store.dataStore.getContactInfo?.(pnJid))?.name } catch {} }
                if (!nm) { try { nm = (await store.dataStore.getContactInfo?.(lidJid))?.name } catch {} }
                if (nm && nm.toString().trim()) {
                  const alias = nm.toString().trim()
                  names[digits] = alias
                  try { names[pnJid] = alias } catch {}
                  try { names[lidJid] = alias } catch {}
                }
              } catch {}
            }
          }
        } catch {}
        if (Object.keys(names).length) {
          try { (message as any)['contactNames'] = names } catch {}
        }
      }
    } catch {}
    // Primeiro tenta anexar foto diretamente com o JID conhecido (evita depender de onWhatsApp)
    try {
      if (remoteJid && this.config.sendProfilePicture) {
        const direct = await this.fetchImageUrl(remoteJid)
        if (direct) {
          try { message['profilePicture'] = direct } catch {}
        } else {
          // Fallback: resolve JID via exists() e tenta novamente
          try {
            const resolved = await this.exists(remoteJid)
            if (resolved) {
              const url = await this.fetchImageUrl(resolved)
              if (url) { try { message['profilePicture'] = url } catch {} }
            }
          } catch {}
        }
      }
    } catch (e) { logger.debug(e as any, 'Ignore error attaching direct profile picture') }
      // Normalize LID senders to PN where possible to improve downstream delivery/webhook payloads
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const k: any = key
        if (k?.remoteJid && isLidUser(k.remoteJid)) {
          // Preserve original LID and expose a PN-normalized variant (best effort)
          k.senderLid = normalizeLidJid(k.remoteJid) || k.remoteJid
          let pnJid: string | undefined
          // 0) Try mapping cache PN<-LID (DataStore)
          try {
            const mapped = await this.store?.dataStore?.getPnForLid?.(this.phone, k.senderLid)
            if (mapped && isPnUser(mapped)) pnJid = mapped
          } catch {}
          try {
            const gm: any = (message as any)?.groupMetadata
            if (gm?.participants?.length) {
              const found = (gm.participants as any[]).find((p: any) => `${p?.lid || ''}` === `${k.remoteJid}`)
              pnJid = found?.id || found?.jid
            }
          } catch {}
          // 1) First inbound attempt: probe exists() using PN-candidate derived from LID (digits or normalized)
          if (!pnJid) {
            try {
              // prefer a normalized PN JID candidate when possible
              const candidate = (() => {
                try {
                  const norm = jidNormalizedUser(k.remoteJid)
                  return isPnUser(norm) ? (norm as any) : undefined
                } catch { return undefined }
              })()
              const resolved = await this.exists(candidate || k.remoteJid)
              if (resolved && isPnUser(resolved)) {
                pnJid = resolved
              }
            } catch {}
          }
          // Não promover PN apenas por normalização de LID -> PN sem confirmação (evita "LID nu" como PN)
          if (pnJid && isPnUser(pnJid)) {
            k.senderPn = pnJid
          }
        }
        if (k?.participant && isLidUser(k.participant)) {
          k.participantLid = normalizeLidJid(k.participant) || k.participant
          let pnJid: string | undefined
          // 0) Try mapping cache PN<-LID (DataStore)
          try {
            const mapped = await this.store?.dataStore?.getPnForLid?.(this.phone, k.participantLid)
            if (mapped && isPnUser(mapped)) pnJid = mapped
          } catch {}
          try {
            const gm: any = (message as any)?.groupMetadata
            if (gm?.participants?.length) {
              const found = (gm.participants as any[]).find((p: any) => `${p?.lid || ''}` === `${k.participant}`)
              pnJid = found?.id || found?.jid
            }
          } catch {}
          if (!pnJid) {
            try {
              const candidate = (() => {
                try {
                  const norm = jidNormalizedUser(k.participant)
                  return isPnUser(norm) ? (norm as any) : undefined
                } catch { return undefined }
              })()
              const resolved = await this.exists(candidate || k.participant)
              if (resolved && isPnUser(resolved)) {
                pnJid = resolved
              }
            } catch {}
          }
          // Não promover PN apenas por normalização de LID -> PN sem confirmação (evita "LID nu" como PN)
          if (pnJid && isPnUser(pnJid)) {
            k.participantPn = pnJid
          }
        }
      } catch (e) {
        logger.warn(e, 'Ignore LID normalization error')
      }
    if (remoteJid) {
      const jid = await this.exists(remoteJid)
      if (jid) {
        try {
          logger.debug(`Retrieving user picture for %s...`, jid)
          const profilePicture = await this.fetchImageUrl(jid)
          if (profilePicture) {
            logger.debug('Retrieved user picture %s for %s!', profilePicture, jid)
            message['profilePicture'] = profilePicture
          } else {
            logger.debug(`Not found user picture for %s!`, jid)
          }
        } catch (error) {
          logger.warn(error)
          logger.warn(error, 'Ignore error on retrieve user profile picture')
        }
      }
    }
    return message
  }

  public async groupCreate(subject: string, participants: string[]) {
    return this.groupCreateFn(subject, participants)
  }

  public async groupUpdateSubject(jid: string, subject: string) {
    return this.groupUpdateSubjectFn(jid, subject)
  }

  public async groupUpdateDescription(jid: string, description?: string) {
    return this.groupUpdateDescriptionFn(jid, description)
  }

  public async groupUpdatePicture(jid: string, pictureUrl: string) {
    return this.groupUpdatePictureFn(jid, pictureUrl)
  }

  public async groupParticipantsUpdate(jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') {
    return this.groupParticipantsUpdateFn(jid, participants, action)
  }

  public async groupInviteCode(jid: string) {
    return this.groupInviteCodeFn(jid)
  }

  public async groupRevokeInvite(jid: string) {
    return this.groupRevokeInviteFn(jid)
  }

  public async groupRequestParticipantsList(jid: string) {
    return this.groupRequestParticipantsListFn(jid)
  }

  public async groupRequestParticipantsUpdate(jid: string, participants: string[], action: 'approve' | 'reject') {
    return this.groupRequestParticipantsUpdateFn(jid, participants, action)
  }

  public async groupLeave(jid: string) {
    return this.groupLeaveFn(jid)
  }

  public async groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') {
    return this.groupSettingUpdateFn(jid, setting)
  }

  public async groupJoinApprovalMode(jid: string, mode: 'on' | 'off') {
    return this.groupJoinApprovalModeFn(jid, mode)
  }

  public async groupMetadata(jid: string) {
    return this.groupMetadataFn(jid)
  }

  public async recoverDelivery(payload: any, options: any = {}) {
    const messageId = `${payload?.message_id || payload?.messageId || payload?.id || ''}`.trim()
    if (!messageId) {
      throw new SendError(400, 'delivery_recovery_message_id_required')
    }

    const dataStore = this.store?.dataStore
    let providerId = ''
    try { providerId = `${await dataStore?.loadProviderId?.(messageId) || ''}`.trim() } catch {}
    if (!providerId) {
      try {
        const unoFromProvider = `${await dataStore?.loadUnoId?.(messageId) || ''}`.trim()
        if (unoFromProvider) providerId = messageId
      } catch {}
    }

    let key: any
    if (providerId) {
      try { key = await dataStore?.loadKey?.(providerId) } catch {}
    }
    if (!key) {
      try { key = await dataStore?.loadKey?.(messageId) } catch {}
    }

    const targetRaw = `${payload?.to || key?.remoteJid || ''}`.trim()
    if (!targetRaw) {
      throw new SendError(404, `delivery_recovery_target_not_found: ${messageId}`)
    }
    const targetTo = targetRaw.endsWith('@g.us')
      ? normalizeGroupId(targetRaw)
      : (targetRaw.includes('@') ? targetRaw : phoneNumberToJid(targetRaw))

    let content: AnyMessageContent | undefined
    if (payload?.type) {
      content = toBaileysMessageContent(payload, this.config.customMessageCharactersFunction) as AnyMessageContent
    } else {
      const lookupIds = Array.from(new Set([providerId, key?.id, messageId].filter(Boolean)))
      const lookupJids = Array.from(new Set([key?.remoteJid, targetTo].filter(Boolean)))
      for (const jid of lookupJids) {
        for (const id of lookupIds) {
          try {
            const stored = await dataStore?.loadMessage?.(jid, id)
            if (stored?.message) {
              content = stored.message as AnyMessageContent
              break
            }
          } catch {}
        }
        if (content) break
      }
    }
    if (!content) {
      throw new SendError(404, `delivery_recovery_message_content_not_found: ${messageId}`)
    }

    const resendId = providerId || key?.id || messageId
    if (resendId && resendId !== messageId) {
      try { await dataStore?.setUnoId?.(resendId, messageId) } catch {}
    }

    const recoveryOptions = {
      ...options,
      ...(payload?.options || {}),
      messageId: resendId,
      forceDeliveryRecovery: true,
      forceSessionRefresh: true,
      forceDeviceList: payload?.force_device_list !== false && payload?.forceDeviceList !== false,
      useUserDevicesCache: false,
    }
    logger.warn(
      'DELIVERY_RECOVERY start phone=%s to=%s messageId=%s providerId=%s forceDeviceList=%s',
      this.phone,
      targetTo,
      messageId,
      providerId || '<none>',
      `${recoveryOptions.forceDeviceList}`,
    )
    const response = await this.sendMessage(targetTo, content, recoveryOptions)
    if (!response?.key?.id) {
      throw new SendError(500, `delivery_recovery_send_failed: ${messageId}`)
    }
    const keyOut = response.key
    const externalId = await this.ensureUnoExternalMessageId(keyOut)
    try { await dataStore?.setKey?.(keyOut.id, keyOut) } catch {}
    try { await dataStore?.setMessage?.(keyOut.remoteJid, response) } catch {}
    logger.warn('DELIVERY_RECOVERY sent phone=%s to=%s messageId=%s providerId=%s newProviderId=%s', this.phone, targetTo, messageId, providerId || '<none>', keyOut.id)
    const ok: any = buildSendOkResponse(targetTo, externalId || messageId)
    ok.recovery = {
      attempted: true,
      message_id: messageId,
      provider_id: providerId || undefined,
      sent_provider_id: keyOut.id,
      target: targetTo,
      force_session_refresh: true,
      force_device_list: recoveryOptions.forceDeviceList,
    }
    return { ok }
  }

  public async contacts(numbers: string[]) {
    /**
     * Validate a list of phone numbers using Baileys onWhatsApp/exists().
     * Returns the resolved JIDs and validity flags.
     */
    const contacts: Contact[] = []
    for (let index = 0; index < numbers.length; index++) {
      const number = numbers[index]
      // Let exists() resolve using the raw number; avoids incorrect digit insertion
      const realJid = await this.exists(`${number}`.trim())
      contacts.push({
        wa_id: realJid,
        input: number,
        status: realJid ? 'valid' : 'invalid'
      })
    }
    return contacts
  }
}
