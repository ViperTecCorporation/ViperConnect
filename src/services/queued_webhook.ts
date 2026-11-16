import { defaultConfig, isWebhookEnabled, type Webhook } from './config'
import { getConfig } from './redis'
import { normalizeWebhookConfig, resolveWebhookUrl } from './webhook_config'
import * as defaults from '../defaults'
import logger from './logger'

/** A failed read is not proof of removal: let the queue retry, without HTTP. */
export class WebhookBindingReadError extends Error {
  constructor() { super('webhook_binding_read_failed') }
}

const environmentWebhook = (): Webhook => ({
  ...defaultConfig.webhooks[0],
  url: defaults.WEBHOOK_URL, urlAbsolute: defaults.WEBHOOK_URL_ABSOLUTE,
  token: defaults.WEBHOOK_TOKEN, header: defaults.WEBHOOK_HEADER,
  timeoutMs: defaults.WEBHOOK_TIMEOUT_MS,
  sendNewMessages: defaults.WEBHOOK_SEND_NEW_MESSAGES,
  sendGroupMessages: defaults.WEBHOOK_SEND_GROUP_MESSAGES,
  sendOutgoingMessages: defaults.WEBHOOK_SEND_OUTGOING_MESSAGES,
  sendNewsletterMessages: defaults.WEBHOOK_SEND_NEWSLETTER_MESSAGES,
  sendUpdateMessages: defaults.WEBHOOK_SEND_UPDATE_MESSAGES,
  sendIncomingMessages: defaults.WEBHOOK_SEND_INCOMING_MESSAGES,
  sendTranscribeAudio: defaults.WEBHOOK_SEND_TRANSCRIBE_AUDIO,
  addToBlackListOnOutgoingMessageWithTtl: defaults.WEBHOOK_ADD_TO_BLACKLIST_ON_OUTGOING_MESSAGE_WITH_TTL,
})

/** Read Redis directly, not the process-local Config cache or queued snapshot. */
export async function readWebhookBindings(phone: string): Promise<Webhook[]> {
  try {
    const config = await getConfig(phone)
    if (!config) return []
    const fallback = environmentWebhook()
    if (config.webhooks == null) return [fallback]
    if (!Array.isArray(config.webhooks)) return []
    return config.webhooks.map(value => normalizeWebhookConfig(value, fallback))
  } catch { throw new WebhookBindingReadError() }
}

/** Never redirect a queued event to a replacement destination. Use current
 * credentials and filters only when both the ID and effective URL still match. */
export function currentQueuedWebhooks(phone: string, queued: Webhook[], current: Webhook[], transcription = false): Webhook[] {
  return queued.flatMap(snapshot => {
    const id = snapshot?.id || 'default'
    const target = snapshot && resolveWebhookUrl(snapshot, phone)
    const matches = current.filter(item => (item.id || 'default') === id)
    const live = matches.length === 1 ? matches[0] : undefined
    if (!target || !isWebhookEnabled(snapshot) || !live || !isWebhookEnabled(live)
      || resolveWebhookUrl(live, phone) !== target || (transcription && !live.sendTranscribeAudio)) {
      logger.info({ phone, webhookId: id, reason: 'binding_removed_disabled_or_changed' }, 'QUEUED_WEBHOOK_DROPPED')
      return []
    }
    return [{ ...live }]
  })
}
