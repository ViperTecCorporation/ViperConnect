import { isWebhookEnabled } from '../../src/services/config'
import { normalizeWebhookConfig, resolveWebhookUrl } from '../../src/services/webhook_config'

describe('webhook config', () => {
  test('does not enable a webhook without a delivery target', () => {
    expect(isWebhookEnabled({ enabled: true, url: '', urlAbsolute: '' })).toBe(false)
  })

  test('prefers the absolute URL and removes the legacy fake base', () => {
    const webhook = normalizeWebhookConfig({
      url: 'http://localhost:9876/webhooks/fake',
      urlAbsolute: 'https://chatwoot.local/webhook',
    })
    expect(webhook.url).toBe('')
    expect(resolveWebhookUrl(webhook, '5566')).toBe('https://chatwoot.local/webhook')
  })
})
