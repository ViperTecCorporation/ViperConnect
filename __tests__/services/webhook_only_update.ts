import { defaultConfig } from '../../src/services/config'
import { isWebhookOnlyUpdate } from '../../src/services/webhook_only_update'

test('recognizes addition, removal and edits of webhooks in a full config', () => {
  const before = { ...defaultConfig }
  const after = { ...before, webhooks: [{ ...before.webhooks[0], id: 'type', url: 'https://example.test' }] }
  expect(isWebhookOnlyUpdate(before, after)).toBe(true)
  expect(isWebhookOnlyUpdate(after, { ...after, webhooks: [] })).toBe(true)
  expect(isWebhookOnlyUpdate(after, { ...after, webhooks: [{ ...after.webhooks[0], enabled: false }] })).toBe(true)
})

test('allows idempotent saves and rejects connection configuration changes', () => {
  const before = { ...defaultConfig }
  expect(isWebhookOnlyUpdate(before, { ...before })).toBe(true)
  expect(isWebhookOnlyUpdate(before, { ...before, webhooks: [], proxyUrl: 'socks5://example.test' })).toBe(false)
})
