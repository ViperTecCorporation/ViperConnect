import type { Webhook } from './config'

export const LEGACY_FAKE_WEBHOOK_URL = 'http://localhost:9876/webhooks/fake'

export const normalizeWebhookConfig = (
  value: Partial<Webhook>,
  fallback: Partial<Webhook> = {},
): Webhook => {
  const webhook = { ...fallback, ...value } as Webhook
  if (`${webhook.urlAbsolute || ''}`.trim() && webhook.url === LEGACY_FAKE_WEBHOOK_URL) {
    webhook.url = ''
  }
  return webhook
}

export const webhookHasTarget = (webhook: Partial<Webhook> | undefined): boolean => {
  if (!webhook) return false
  return !!`${webhook.urlAbsolute || webhook.url || ''}`.trim()
}

export const resolveWebhookUrl = (webhook: Partial<Webhook>, phone: string): string | undefined => {
  const absolute = `${webhook.urlAbsolute || ''}`.trim()
  if (absolute) return absolute
  const base = `${webhook.url || ''}`.trim().replace(/\/$/, '')
  return base ? `${base}/${phone}` : undefined
}
