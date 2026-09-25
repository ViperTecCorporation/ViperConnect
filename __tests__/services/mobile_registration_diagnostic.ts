import { sanitizeRegistrationDiagnostic } from '../../src/services/mobile_primary/registration_diagnostic'
const { diagnostic, failure, responseDiagnostic, protocolCode } = require('../../lab/registration/diagnostic.cjs')

describe('registration diagnostic allowlist', () => {
  test.each([
    [{ sms_wait: '2700', voice_wait: 9000, retry_after: 10000 }, 2700],
    [{ voice_wait: 9000, wa_old_wait: 8000 }, 9000],
    [{ retry_after: '7200' }, 7200],
    [{ sms_wait: -1, retry_after: 30 }, 30],
    [{ sms_wait: true, voice_wait: {}, retry_after: 'SECRET' }, undefined],
    [{ sms_wait: Infinity, retry_after: 2147483648 }, undefined],
  ])('retains only valid wait seconds using upstream priority', (raw, expected) => {
    const detail = responseDiagnostic(raw, 'request')
    expect(detail.waitSeconds).toBe(expected)
    expect(sanitizeRegistrationDiagnostic(detail)?.waitSeconds).toBe(expected)
  })
  test.each([-1, 0, 1.5, Infinity, '7200', true, 2147483648])('rejects malformed IPC wait', waitSeconds => {
    expect(sanitizeRegistrationDiagnostic({ stage: 'request', reason: 'rate_limited', waitSeconds })?.waitSeconds).toBeUndefined()
  })
  test('captures protocol codes without response payload or identity', () => {
    const detail = responseDiagnostic({ status: 'fail', reason: 'new_provider_reason', pending: 'approval', login: '999123456789', code: '123456', token: 'SECRET', raw: 'SECRET' }, 'verify')
    expect(detail).toEqual({ stage: 'verify', reason: 'provider_response', providerStatus: 'fail', providerReason: 'new_provider_reason', providerPending: 'approval' })
    expect(sanitizeRegistrationDiagnostic({ ...detail, raw: 'SECRET', token: 'SECRET' })).toEqual(detail)
  })
  test.each(['123456', 'reason with spaces', 'Bearer SECRET', 'https://example.com', 'abc123', 'a'.repeat(49), {}, null])('rejects non-code fields', value => {
    expect(protocolCode(value)).toBeUndefined()
    const detail = responseDiagnostic({ status: value, reason: value, pending: value }, 'verify')
    expect(detail).toEqual({ stage: 'verify', reason: 'unknown' })
    expect(sanitizeRegistrationDiagnostic({ ...detail, providerReason: value })).toEqual(detail)
  })
  test('handles missing or malformed responses without inventing approval', () => {
    for (const value of [undefined, null, 'SECRET', []]) expect(responseDiagnostic(value, 'invalid')).toEqual({ stage: 'prepare', reason: 'unknown' })
  })
  test.each([
    ['Verification failed: code expired or already used.', 'code_expired'],
    ['Verification failed: wrong code entered.', 'invalid_code'],
    ['Verification failed: bad_token', 'bad_token'],
    ['captcha SECRET', 'challenge_required'], ['too_many SECRET', 'rate_limited'],
    ['NO_APK_MATERIAL SECRET', 'android_material'], ['source_mismatch', 'local_configuration'],
    ['socket hang up SECRET', 'network'], ['HTTP 503 /register: SECRET', 'http_error'],
    ['Verification failed: secret_value', 'unknown'],
  ])('classifies without leaking: %s', (message, reason) => {
    const value = diagnostic(new Error(message), 'verify')
    expect(value.reason).toBe(reason)
    expect(JSON.stringify(value)).not.toContain('SECRET')
    expect(sanitizeRegistrationDiagnostic(value)).toEqual(value)
  })
  test('rejects injected fields and arbitrary values at service boundary', () => {
    expect(sanitizeRegistrationDiagnostic({ stage: 'verify', reason: 'unknown', httpStatus: 'SECRET', raw: 'SECRET' })).toEqual({ stage: 'verify', reason: 'unknown' })
    expect(sanitizeRegistrationDiagnostic({ stage: 'SECRET', reason: 'unknown' })).toBeUndefined()
    expect(sanitizeRegistrationDiagnostic({ stage: 'verify', reason: 'SECRET' })).toBeUndefined()
    expect(diagnostic(undefined, 'SECRET')).toEqual({ stage: 'prepare', reason: 'unknown' })
    expect(failure(new Error('HTTP 503 /register: SECRET'), 'verify')).toEqual({ error: 'provider_failed', diagnostic: { stage: 'verify', reason: 'http_error', httpStatus: 503 } })
  })
})
