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

test('Manager preserves public native wake settings without exposing token or accepting invalid timeout', () => {
  expect(sanitizeVoipConsolePayload({ viperchatWebhook: {
    nativeWakeEnabled: true, nativeWakeTimeoutSeconds: 15, apiAccessToken: 'secret',
  } })).toEqual({ viperchatWebhook: { nativeWakeEnabled: true, nativeWakeTimeoutSeconds: 15 } })
  for (const value of [4, 61, 10.5, NaN, Infinity, '30', { token: 'secret' }]) {
    expect(sanitizeVoipConsolePayload({ viperchatWebhook: {
      nativeWakeEnabled: false, nativeWakeTimeoutSeconds: value,
    } })).toEqual({ viperchatWebhook: { nativeWakeEnabled: false } })
  }
})
