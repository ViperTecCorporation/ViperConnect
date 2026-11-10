import { MessageFilter } from './message_filter'
import { defaultConfig, Config, configs, connectionType } from './config'
import { getStoreRedis } from './store_redis'
import { RATE_LIMIT_BLOCK_SECONDS, RATE_LIMIT_GLOBAL_PER_MINUTE, RATE_LIMIT_PER_TO_PER_MINUTE, OUTGOING_IDEMPOTENCY_ENABLED } from '../defaults'
import { GROUP_IGNORE_INDIVIDUAL_RECEIPTS, GROUP_ONLY_DELIVERED_STATUS } from '../defaults'
import logger from './logger'
import { configLogSummary } from './config_log_summary'
import { Level } from 'pino'

import {
  AUTO_RESTART_MS,
  AUTO_CONNECT,
  COMPOSING_MESSAGE,
  BASE_STORE,
  UNOAPI_RETRY_REQUEST_DELAY_MS,
  REJECT_CALLS,
  REJECT_CALLS_WEBHOOK,
  MESSAGE_CALLS_WEBHOOK,
  WEBHOOK_SESSION,
  WEBHOOK_HEADER,
  WEBHOOK_URL,
  WEBHOOK_URL_ABSOLUTE,
  WEBHOOK_TOKEN,
  LOG_LEVEL,
  IGNORE_GROUP_MESSAGES,
  IGNORE_OWN_MESSAGES,
  IGNORE_BROADCAST_STATUSES,
  IGNORE_BROADCAST_MESSAGES,
  IGNORE_HISTORY_MESSAGES,
  IGNORE_YOURSELF_MESSAGES,
  SEND_CONNECTION_STATUS,
  IGNORE_DATA_STORE,
  THROW_WEBHOOK_ERROR,
  NOTIFY_FAILED_MESSAGES,
  SEND_REACTION_AS_REPLY,
  WEBHOOK_TIMEOUT_MS,
  SEND_PROFILE_PICTURE,
  WEBHOOK_SEND_NEW_MESSAGES,
  WEBHOOK_SEND_GROUP_MESSAGES,
  WEBHOOK_SEND_OUTGOING_MESSAGES,
  PROXY_URL,
  UNOAPI_AUTH_TOKEN,
  UNOAPI_HEADER_NAME,
  CONNECTION_TYPE,
  READ_ON_RECEIPT,
  READ_ON_REPLY,
  IGNORE_NEWSLETTER_MESSAGES,
  WEBHOOK_SEND_NEWSLETTER_MESSAGES,
  WEBHOOK_SEND_UPDATE_MESSAGES,
  CUSTOM_MESSAGE_CHARACTERS,
  WEBHOOK_SEND_INCOMING_MESSAGES,
  WEBHOOK_SEND_TRANSCRIBE_AUDIO,
  OPENAI_API_KEY,
  OPENAI_API_TRANSCRIBE_MODEL,
  OPENAI_API_ASSISTANT_ID,
  GROQ_API_KEY,
  GROQ_API_TRANSCRIBE_MODEL,
  GROQ_API_BASE_URL,
  WEBHOOK_ADD_TO_BLACKLIST_ON_OUTGOING_MESSAGE_WITH_TTL,
  WHATSAPP_ENGINE,
  HISTORY_MAX_AGE_DAYS,
} from '../defaults'
import { resolveSessionProvider } from './providers/provider_resolver'
import { BAILEYS_CONNECTION_POLICY } from './baileys_connection_policy'

export const getConfigByEnv = async (phone: string, cache = true): Promise<Config> => {
  if (!cache || !configs.has(phone)) {
    const config: Config = {
      ...defaultConfig,
      webhooks: defaultConfig.webhooks.map(webhook => ({ ...webhook })),
      webhookForward: { ...defaultConfig.webhookForward },
    }
    config.logLevel = LOG_LEVEL as Level
    config.ignoreGroupMessages = IGNORE_GROUP_MESSAGES
    config.ignoreNewsletterMessages = IGNORE_NEWSLETTER_MESSAGES
    config.readOnReceipt = READ_ON_RECEIPT
    config.readOnReply = READ_ON_REPLY
    config.ignoreBroadcastStatuses = IGNORE_BROADCAST_STATUSES
    config.ignoreBroadcastMessages = IGNORE_BROADCAST_MESSAGES
    config.ignoreGroupIndividualReceipts = GROUP_IGNORE_INDIVIDUAL_RECEIPTS
    config.groupOnlyDeliveredStatus = GROUP_ONLY_DELIVERED_STATUS
    config.ignoreHistoryMessages = IGNORE_HISTORY_MESSAGES
    config.historyMaxAgeDays = Math.max(1, HISTORY_MAX_AGE_DAYS || 30)
    config.clearAppStateSyncOnConnect = BAILEYS_CONNECTION_POLICY.clearAppStateSyncOnConnect
    config.allowFullHistorySync = BAILEYS_CONNECTION_POLICY.allowFullHistorySync
    config.ignoreDataStore = IGNORE_DATA_STORE
    config.ignoreYourselfMessages = IGNORE_YOURSELF_MESSAGES
    config.ignoreOwnMessages = IGNORE_OWN_MESSAGES
    config.sendConnectionStatus = SEND_CONNECTION_STATUS
    config.autoConnect = AUTO_CONNECT
    config.autoRestartMs = AUTO_RESTART_MS
    config.qrTimeoutMs = BAILEYS_CONNECTION_POLICY.qrTimeoutMs
    config.composingMessage = COMPOSING_MESSAGE
    config.baseStore = BASE_STORE
    config.rejectCalls = REJECT_CALLS
    config.rejectCallsWebhook = REJECT_CALLS_WEBHOOK
    config.messageCallsWebhook = MESSAGE_CALLS_WEBHOOK
    config.throwWebhookError = THROW_WEBHOOK_ERROR
    config.notifyFailedMessages = NOTIFY_FAILED_MESSAGES
    config.retryRequestDelayMs = UNOAPI_RETRY_REQUEST_DELAY_MS
    config.connectionType = CONNECTION_TYPE as connectionType
    config.sendReactionAsReply = SEND_REACTION_AS_REPLY
    config.sendProfilePicture = SEND_PROFILE_PICTURE
    config.sessionWebhook = WEBHOOK_SESSION
    config.proxyUrl = PROXY_URL
    config.authToken = UNOAPI_AUTH_TOKEN
    config.authHeader = UNOAPI_HEADER_NAME
    config.baileysCountryCode = BAILEYS_CONNECTION_POLICY.countryCode
    config.openaiApiKey = OPENAI_API_KEY
    config.openaiApiTranscribeModel = OPENAI_API_TRANSCRIBE_MODEL
    config.openaiAssistantId = OPENAI_API_ASSISTANT_ID
    config.groqApiKey = GROQ_API_KEY
    config.groqApiTranscribeModel = GROQ_API_TRANSCRIBE_MODEL
    config.groqApiBaseUrl = GROQ_API_BASE_URL
    // Rate limits from env (can be overridden per-session via UI)
    config.rateLimitGlobalPerMinute = RATE_LIMIT_GLOBAL_PER_MINUTE
    config.rateLimitPerToPerMinute = RATE_LIMIT_PER_TO_PER_MINUTE
    config.rateLimitBlockSeconds = RATE_LIMIT_BLOCK_SECONDS
    config.outgoingIdempotency = OUTGOING_IDEMPOTENCY_ENABLED
    config.provider = resolveSessionProvider(WHATSAPP_ENGINE)
    config.useRedis = true
    config.useS3 = !!process.env.STORAGE_ENDPOINT
    config.webhooks[0].url = WEBHOOK_URL
    config.webhooks[0].urlAbsolute = WEBHOOK_URL_ABSOLUTE
    config.webhooks[0].token = WEBHOOK_TOKEN
    config.webhooks[0].header = WEBHOOK_HEADER
    config.webhooks[0].timeoutMs = WEBHOOK_TIMEOUT_MS
    config.webhooks[0].sendNewMessages = WEBHOOK_SEND_NEW_MESSAGES
    config.webhooks[0].sendGroupMessages = WEBHOOK_SEND_GROUP_MESSAGES
    config.webhooks[0].sendOutgoingMessages = WEBHOOK_SEND_OUTGOING_MESSAGES
    config.webhooks[0].sendNewsletterMessages = WEBHOOK_SEND_NEWSLETTER_MESSAGES
    config.webhooks[0].sendUpdateMessages = WEBHOOK_SEND_UPDATE_MESSAGES
    config.webhooks[0].sendIncomingMessages = WEBHOOK_SEND_INCOMING_MESSAGES
    config.webhooks[0].sendTranscribeAudio = WEBHOOK_SEND_TRANSCRIBE_AUDIO
    config.webhooks[0].addToBlackListOnOutgoingMessageWithTtl = WEBHOOK_ADD_TO_BLACKLIST_ON_OUTGOING_MESSAGE_WITH_TTL

    config.customMessageCharacters = CUSTOM_MESSAGE_CHARACTERS
    config.whatsappVersion = BAILEYS_CONNECTION_POLICY.whatsappVersion

    if (config.customMessageCharacters.length > 0) {
      const getRandomChar = () => {
        const randomIndex = Math.floor(Math.random() * config.customMessageCharacters.length);
        return config.customMessageCharacters[randomIndex]
      }
      config.customMessageCharactersFunction = (message: string) => {
        return message.replace(' ', ` ${getRandomChar()}`)
      }
    }

    config.getStore = getStoreRedis

    const filter: MessageFilter = new MessageFilter(phone, config)
    config.shouldIgnoreJid = filter.isIgnoreJid.bind(filter)
    config.shouldIgnoreKey = filter.isIgnoreKey.bind(filter)
    logger.info('Config by env: %s summary=%s', phone, JSON.stringify(configLogSummary(config)))
    if (cache) configs.set(phone, config)
    return config
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return configs.get(phone)!
}
