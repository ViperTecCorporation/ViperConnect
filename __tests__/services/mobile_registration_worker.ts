const { operate } = require('../../lab/registration/worker.cjs')

describe('isolated registration driver with offline provider responses', () => {
  const original = process.env.MOBILE_REGISTRATION_MODULE
  beforeEach(() => { process.env.MOBILE_REGISTRATION_MODULE = require('node:path').resolve('lab/registration') })
  afterAll(() => { if (original === undefined) delete process.env.MOBILE_REGISTRATION_MODULE; else process.env.MOBILE_REGISTRATION_MODULE = original })
  const deps = () => ({ store: { createNewStore: jest.fn(() => ({ phoneNumber: '999123456789' })), storeFromJson: (v: any) => ({ ...v }), storeToJson: (v: any) => v }, registration: { requestSmsCode: jest.fn(), verifyCode: jest.fn() } })
  const input = { action: 'request', draft: { phone: '999123456789', name: 'Lab' }, store: { phoneNumber: '999123456789' } }
  test('prepare generates state without network registration', async () => {
    const d = deps(); expect(await operate({ ...input, action: 'prepare' }, d)).toHaveProperty('store')
    expect(d.registration.requestSmsCode).not.toHaveBeenCalled()
  })
  test('preserves structured refusal fields from errors without raw data', async () => {
    const d = deps(); d.registration.verifyCode.mockRejectedValue(Object.assign(new Error('Verification failed'), { raw: { status: 'fail', reason: 'new_reason', pending: 'approval', login: '999123456789', token: 'SECRET' } }))
    expect(await operate({ ...input, action: 'verify', code: '123456' }, d)).toEqual({ error: 'provider_failed', diagnostic: { stage: 'verify', reason: 'provider_response', providerStatus: 'fail', providerReason: 'new_reason', providerPending: 'approval' } })
  })
  test('records non-success responses rather than dropping them', async () => {
    const d = deps(); d.registration.requestSmsCode.mockResolvedValue({ status: 'fail', reason: 'no_routes', token: 'SECRET' })
    expect(await operate(input, d)).toEqual({ error: 'provider_failed', diagnostic: { stage: 'request', reason: 'provider_response', providerStatus: 'fail', providerReason: 'no_routes' } })
  })
  test('retains remote wait through the error boundary without response secrets', async () => {
    const d = deps(); d.registration.requestSmsCode.mockRejectedValue(Object.assign(new Error('too_recent'), { raw: { status: 'fail', reason: 'too_recent', sms_wait: '7200', token: 'SECRET' } }))
    const result = await operate(input, d)
    expect(result).toMatchObject({ error: 'rate_limited', diagnostic: { waitSeconds: 7200, providerReason: 'too_recent' } })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
  test('request uses SMS only and marks code pending', async () => {
    const d = deps(); d.registration.requestSmsCode.mockResolvedValue({ status: 'sent' })
    expect(await operate(input, d)).toMatchObject({ store: { codePending: true } })
    expect(d.registration.requestSmsCode).toHaveBeenCalledWith(expect.anything(), 'sms')
  })
  test('successful SMS response retains resend wait without exposing raw data', async () => {
    const d = deps(); d.registration.requestSmsCode.mockResolvedValue({ status: 'sent', sms_wait: '120', token: 'SECRET' })
    const result = await operate(input, d)
    expect(result).toMatchObject({ store: { codePending: true }, diagnostic: { waitSeconds: 120, providerStatus: 'sent' } })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
  test.each([{ status: 'sent' }, { status: 'ok', pending: 'challenge', login: '999123456789' }, { status: 'ok' }])('rejects partial confirmation', async response => {
    const d = deps(); d.registration.verifyCode.mockResolvedValue(response)
    expect(await operate({ ...input, action: 'verify', code: '123456' }, d)).toMatchObject({ error: 'challenge_required' })
  })
  test('confirmed response preserves canonical server identity', async () => {
    const d = deps(); d.registration.verifyCode.mockResolvedValue({ status: 'ok', login: '999876543210' })
    expect(await operate({ ...input, action: 'verify', code: '123456' }, d)).toMatchObject({ store: { phoneNumber: '999876543210', registered: true, codePending: false } })
  })
  test.each([['captcha SECRET', 'challenge_required'], ['too_many SECRET', 'rate_limited'], ['socket SECRET', 'provider_failed']])('sanitizes errors', async (message, error) => {
    const d = deps(); d.registration.requestSmsCode.mockRejectedValue(new Error(message))
    expect(await operate(input, d)).toMatchObject({ error })
    expect(JSON.stringify(await operate(input, d))).not.toContain('SECRET')
  })
})
