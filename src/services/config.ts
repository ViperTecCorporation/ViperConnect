import { getStore } from './store'
import { getStoreFile } from './store_file'
import { WAMessageKey, WAVersion } from '@whiskeysockets/baileys'
import { Level } from 'pino'
import { SessionProvider } from './providers/provider_types'

export const configs: Map<string, Config> = new Map()

export type connectionType = 'qrcode' | 'pairing_code' | 'forward'
export type OneToOneAddressingMode = 'pn' | 'lid'

export interface GetMessageMetadata {
  <T>(message: T): Promise<T>
}

export const getMessageMetadataDefault: GetMessageMetadata = async <T>(data: T) => data

export type Webhook = {
  id: string,
  url: string
  urlAbsolute: string
  enabled: boolean
  token: string
  header: string
  timeoutMs: number
  sendNewMessages: boolean
  sendUpdateMessages: boolean
  sendGroupMessages: boolean
  sendOutgoingMessages: boolean
  sendNewsletterMessages: boolean
  sendIncomingMessages: boolean
  sendTranscribeAudio: boolean
  addToBlackListOnOutgoingMessageWithTtl: number | undefined
  typebot?: boolean
  disabled?: boolean
}

export const isWebhookEnabled = (webhook: Partial<Webhook> | undefined): boolean => {
  if (!webhook) return false
  if (webhook.enabled === false) return false
  if (webhook.disabled === true) return false
  return true
}

export type WebhookForward = {
  url: string
  phoneNumberId: string
  businessAccountId: string
  token: string
  version: string
  timeoutMs: number
}

export type Config = {
  ignoreGroupMessages: boolean
  ignoreNewsletterMessages: boolean
  ignoreBroadcastMessages: boolean
  ignoreBroadcastStatuses: boolean
  // Controle de fan-out de recibos/status em grupos
  // Se true, ignora recibos individuais (read/played/delivery por participante)
  ignoreGroupIndividualReceipts: boolean
  // Se true, para groups em messages.update repassa somente DELIVERY_ACK (delivered)
  groupOnlyDeliveredStatus: boolean
  readOnReceipt: boolean
  readOnReply: boolean
  markOnlineOnConnect: boolean
  ignoreHistoryMessages: boolean
  clearAppStateSyncOnConnect: boolean
  allowFullHistorySync: boolean
  ignoreYourselfMessages: boolean
  ignoreOwnMessages: boolean
  sendConnectionStatus: boolean
  notifyFailedMessages: boolean
  composingMessage: boolean
  autoRestartMs: number
  autoConnect: boolean
  retryRequestDelayMs: number
  rejectCalls: string
  throwWebhookError: boolean
  rejectCallsWebhook: string
  messageCallsWebhook: string
  proxyUrl: string | undefined
  sessionWebhook: string
  shouldIgnoreJid: (jid: string) => boolean | undefined
  shouldIgnoreKey: (key: WAMessageKey, messageType: string | undefined) => boolean | undefined
  getStore: getStore
  baseStore: string
  webhooks: Webhook[]
  webhookForward: WebhookForward | Partial<WebhookForward>
  logLevel: Level
  getMessageMetadata: GetMessageMetadata
  ignoreDataStore: boolean
  sendReactionAsReply: boolean
  sendProfilePicture: boolean
  authToken: string | undefined
  authHeader: string | undefined
  provider: SessionProvider | undefined
  server:  string | undefined
  connectionType: connectionType
  baileysCountryCode: string
  useRedis: boolean
  useS3: boolean
  // Coexistência Web + Meta
  coexistenceEnabled: boolean
  coexistenceWindowSeconds: number
  qrTimeoutMs: number
  label: string
  overrideWebhooks: boolean
  customMessageCharacters: string[]
  customMessageCharactersFunction: (message: string) => string,
  whatsappVersion: WAVersion | undefined,
  openaiApiKey: string | undefined
  openaiApiTranscribeModel: string | undefined
  openaiAssistantId: string | undefined
  groqApiKey: string | undefined
  groqApiTranscribeModel: string | undefined
  groqApiBaseUrl: string | undefined
  // Rate limit (per-session overrides)
  rateLimitGlobalPerMinute?: number
  rateLimitPerToPerMinute?: number
  rateLimitBlockSeconds?: number
  // Guardar reenvio indevido em caso de retry do job
  outgoingIdempotency: boolean
  oneToOneAddressingMode?: OneToOneAddressingMode
}

export const defaultConfig: Config = {
  ignoreGroupMessages: true,
  ignoreNewsletterMessages: true,
  ignoreBroadcastStatuses: true,
  ignoreBroadcastMessages: false,
  ignoreGroupIndividualReceipts: true,
  groupOnlyDeliveredStatus: true,
  readOnReceipt: false,
  readOnReply: false,
  markOnlineOnConnect: false,
  ignoreHistoryMessages: true,
  clearAppStateSyncOnConnect: false,
  allowFullHistorySync: false,
  ignoreOwnMessages: true,
  ignoreYourselfMessages: true,
  sendConnectionStatus: true,
  notifyFailedMessages: true,
  composingMessage: false,
  rejectCalls: '',
  sessionWebhook: '',
  rejectCallsWebhook: '',
  messageCallsWebhook: '',
  logLevel: 'fatal',
  autoConnect: true,
  autoRestartMs: 0,
  retryRequestDelayMs: 1_000,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldIgnoreJid: (_jid: string) => false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldIgnoreKey: (_key: WAMessageKey, _messageType: string | undefined) => false,
  getStore: getStoreFile,
  throwWebhookError: false,
  baseStore: './data',
  webhooks: [
    {
      id: 'default',
      url: '',
      urlAbsolute: '',
      enabled: true,
      token: '',
      header: '',
      timeoutMs: 5_000,
      sendNewMessages: false,
      sendNewsletterMessages: false,
      sendGroupMessages: true,
      sendOutgoingMessages: true,
      sendUpdateMessages: true,
      sendIncomingMessages: true,
      sendTranscribeAudio: false,
      addToBlackListOnOutgoingMessageWithTtl: undefined,
      typebot: false,
    },
  ],
  webhookForward: {},
  getMessageMetadata: getMessageMetadataDefault,
  ignoreDataStore: false,
  sendReactionAsReply: false,
  sendProfilePicture: false,
  proxyUrl: undefined,
  authToken: undefined,
  authHeader: undefined,
  provider: undefined,
  server: undefined,
  connectionType: 'qrcode',
  baileysCountryCode: 'BR',
  useRedis: false,
  useS3: false,
  coexistenceEnabled: false,
  coexistenceWindowSeconds: 24 * 60 * 60,
  qrTimeoutMs: 60000,
  label: '',
  overrideWebhooks: false,
  customMessageCharacters: [],
  customMessageCharactersFunction: (message: string) => message,
  whatsappVersion: undefined,
  openaiApiKey: undefined,
  openaiApiTranscribeModel: undefined,
  openaiAssistantId: undefined,
  groqApiKey: undefined,
  groqApiTranscribeModel: undefined,
  groqApiBaseUrl: undefined,
  rateLimitGlobalPerMinute: 0,
  rateLimitPerToPerMinute: 0,
  rateLimitBlockSeconds: 60,
  outgoingIdempotency: true,
  oneToOneAddressingMode: undefined
}

export interface getConfig {
  (phone: string): Promise<Config>
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getConfigDefault: getConfig = async (_phone: string): Promise<Config> => {
  return defaultConfig
}
