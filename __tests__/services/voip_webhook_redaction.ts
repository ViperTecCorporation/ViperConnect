import { sanitizeVoipConsolePayload } from '../../src/services/voip_service'

test('Manager drops webhook credentials and unknown fields even if upstream returns them', () => {
  expect(sanitizeVoipConsolePayload({ companies: [{ viperchatWebhook: {
    enabled: true, artifactsDelivery: 'webhook', baseUrl: 'https://chat.example', accountId: '1', serviceId: '2',
    sourceInstanceId: 'central', hasApiAccessToken: true, apiAccessToken: 'secret',
    activatedAt: 'internal', nested: { token: 'another-secret' },
  } }] })).toEqual({ companies: [{ viperchatWebhook: {
    enabled: true, artifactsDelivery: 'webhook', baseUrl: 'https://chat.example', accountId: '1', serviceId: '2',
    sourceInstanceId: 'central', hasApiAccessToken: true,
  } }] })
})

test('Manager webhook projection rejects nested values in public scalar fields', () => {
  expect(sanitizeVoipConsolePayload({ viperchatWebhook: {
    enabled: { token: 'secret' }, baseUrl: { token: 'secret' }, hasApiAccessToken: 'secret',
  } })).toEqual({ viperchatWebhook: {} })
})
