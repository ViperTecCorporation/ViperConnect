import { companionDiagnostic } from '../../src/services/mobile_primary/companion_diagnostic'

test('classifies IQ rejection without leaking remote text or QR', () => {
  const error = new Error('companion-host.pair-device iq failed (400: SECRET_QR_AND_KEYS)')
  error.stack = 'Error: SECRET_QR_AND_KEYS\n at fn (/app/node_modules/zapo-js/dist/client/coordinators/WaMobileCoordinator.js:449:12)'
  expect(companionDiagnostic(error)).toEqual({ reason: 'provider_iq_rejected', stage: 'pair-device', providerCode: 400, locations: ['WaMobileCoordinator.js:449:12'] })
  expect(JSON.stringify(companionDiagnostic(error))).not.toContain('SECRET')
})
test.each([
  ['mobile_companion_state_conflict', 'state_conflict'],
  ['pair-device result missing <device jid>', 'device_jid_missing'],
  ['query timed out: SECRET', 'timeout'],
  ['SECRET_TOKEN_QR', 'unclassified'],
  ['__proto__', 'unclassified'],
])('classifies %s using safe labels only', (message, reason) => {
  expect(companionDiagnostic(new Error(message)).reason).toBe(reason)
  expect(JSON.stringify(companionDiagnostic(new Error(message)))).not.toContain('SECRET')
})
test('does not serialize arbitrary thrown payloads', () => {
  expect(companionDiagnostic({ message: 'SECRET', code: 'SECRET', qr: 'SECRET' })).toEqual({ reason: 'unclassified', locations: [] })
  expect(companionDiagnostic(null)).toEqual({ reason: 'unclassified', locations: [] })
})
