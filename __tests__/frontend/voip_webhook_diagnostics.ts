import { renderWebhookDiagnostics, replayWebhookPayload } from '../../frontend/features/voip_webhook_diagnostics'

const eventId = 'a'.repeat(64)
const requestId = '12345678-abcd-4321-abcd-123456789abc'
test('diagnostics renders safe counts, technical errors and original-scope confirmation without payload', () => {
  const html = renderWebhookDiagnostics({ type: 'voip-webhook-diagnostics', companyId: 'company', confirmIds: [eventId], requestId, value: {
    counts: { dead: 1 }, items: [{ id: eventId, eventId, status: 'dead', attempts: 8, errorCode: 'http_503', replayAllowed: true, destinationMatches: true,
      ...{ payload: { token: 'must-not-render', phone: '555123456789' } } }],
  } })
  expect(html).toContain('HTTP_503')
  expect(html).toContain('Confirmar reprocessamento')
  expect(html).toContain('mesmo destino original')
  expect(html).toContain('data-action="prepare-voip-webhook-replay"')
  expect(html).not.toContain('must-not-render')
  expect(html).not.toContain('555123456789')
})
test('diagnostics rejects unknown errors and hides replay when scope or delivery state disallows it', () => {
  for (const flags of [{ status: 'dead', destinationMatches: false }, { status: 'delivered', destinationMatches: true }]) {
    const html = renderWebhookDiagnostics({ type: 'voip-webhook-diagnostics', companyId: 'company', value: { items: [{ id: eventId, eventId, attempts: 1, replayAllowed: true, errorCode: 'token-secret-example', ...flags }] } })
    expect(html).not.toContain('token-secret-example')
    expect(html).not.toContain('data-action="prepare-voip-webhook-replay"')
    expect(html).toContain('delivery_error')
  }
})
test('replay only serializes explicit bounded event IDs, confirmation and idempotency ID', () => {
  expect(replayWebhookPayload([eventId, eventId], requestId)).toEqual({ eventIds: [eventId], confirm: true, requestId })
  expect(() => replayWebhookPayload([], requestId)).toThrow()
  expect(() => replayWebhookPayload(['https://other-tenant'], requestId)).toThrow()
  expect(() => replayWebhookPayload([eventId], 'bad')).toThrow()
  expect(() => replayWebhookPayload(Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(64, '0')), requestId)).toThrow()
})
