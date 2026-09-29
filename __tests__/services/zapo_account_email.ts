import { ZapoOwnProfile } from '../../src/services/zapo/zapo_own_profile'
import { validateProfileCommand } from '../../src/services/profile_input'
import logger from '../../src/services/logger'

const fixture = (mobile = true) => {
  const email = { getStatus: jest.fn().mockResolvedValue({ email: 'me@example.com', verified: true, confirmed: false }),
    setEmail: jest.fn().mockResolvedValue({ email: 'me@example.com', verified: false, confirmed: false }),
    requestVerificationCode: jest.fn(), verifyCode: jest.fn().mockResolvedValue({ verified: true, autoVerifyFailed: false, email: 'me@example.com' }), confirm: jest.fn() }
  const client: any = { email, getCredentials: () => ({ meJid: '5511000000000@s.whatsapp.net' }), getState: () => ({ connected: true }) }
  return { email, client, run: (value?: any) => new ZapoOwnProfile(client, undefined, mobile).execute({ action: value ? 'set' : 'get', field: 'account_email', ...(value ? { value } : {}) }) }
}
test('request diagnostics distinguish lookup from requesting without exposing secrets', async () => {
  const log = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
  try {
    const f = fixture()
    f.email.getStatus.mockRejectedValueOnce(new Error('query timed out private@example.com 123456'))
    await expect(f.run({ operation: 'request_code' })).rejects.toThrow('provider_request_failed')
    expect(log).toHaveBeenLastCalledWith({ stage: 'getStatus', providerCode: null, reason: 'timeout' }, 'PROFILE_EMAIL_PROVIDER_FAILED')
    expect(f.email.requestVerificationCode).not.toHaveBeenCalled()
    f.email.requestVerificationCode.mockRejectedValueOnce(new Error('email.requestCode iq failed (500: private@example.com 123456)'))
    await expect(f.run({ operation: 'request_code' })).rejects.toThrow('provider_request_failed')
    expect(log).toHaveBeenLastCalledWith({ stage: 'requestVerificationCode', providerCode: 500, reason: 'iq_rejected' }, 'PROFILE_EMAIL_PROVIDER_FAILED')
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private@example|123456/)
    expect(f.email.requestVerificationCode).toHaveBeenCalledTimes(1)
  } finally { log.mockRestore() }
})
test('linked sessions cannot read or mutate email', async () => {
  const { email, run } = fixture(false)
  await expect(run()).rejects.toThrow('mobile_primary_required')
  await expect(run({ operation: 'set', email: 'me@example.com' })).rejects.toThrow('mobile_primary_required')
  expect(email.getStatus).not.toHaveBeenCalled(); expect(email.setEmail).not.toHaveBeenCalled()
})
test('offline fails before email queries', async () => {
  const f = fixture(); f.client.getState = () => ({ connected: false })
  await expect(f.run()).rejects.toThrow('not_connected'); expect(f.email.getStatus).not.toHaveBeenCalled()
})
test('read and set are separate from verification and return whitelisted state', async () => {
  const { email, run } = fixture()
  expect(await run()).toEqual({ email: 'me@example.com', verified: true, confirmed: false })
  expect(await run({ operation: 'set', email: 'me@example.com' })).toMatchObject({ success: true, verified: false })
  expect(email.setEmail).toHaveBeenCalledWith('me@example.com', 'settings')
  expect(email.requestVerificationCode).not.toHaveBeenCalled()
})
test('explicit code request, verification and confirmation use SDK signatures', async () => {
  const { email, run } = fixture()
  await run({ operation: 'request_code' })
  expect(email.requestVerificationCode).toHaveBeenCalledWith({ languageCode: 'pt', localeCode: 'BR' })
  const result = await run({ operation: 'verify', code: '123456' })
  expect(email.verifyCode).toHaveBeenCalledWith('123456')
  expect(JSON.stringify(result)).not.toContain('123456'); expect(email.confirm).not.toHaveBeenCalled()
  await run({ operation: 'confirm' }); expect(email.confirm).toHaveBeenCalledWith('settings')
})
test('missing email and unverified state block request and confirmation', async () => {
  const { email, run } = fixture(); email.getStatus.mockResolvedValue({ email: null, verified: false, confirmed: false } as any)
  await expect(run({ operation: 'request_code' })).rejects.toThrow('not_configured')
  await expect(run({ operation: 'confirm' })).rejects.toThrow('not_verified')
  expect(email.confirm).not.toHaveBeenCalled(); expect(email.requestVerificationCode).not.toHaveBeenCalled()
  email.verifyCode.mockResolvedValue({ verified: false, autoVerifyFailed: true, email: null } as any)
  await expect(run({ operation: 'verify', code: '123456' })).rejects.toThrow('not_verified')
})
test.each([[403, 'forbidden'], [534, 'locked'], [535, 'code_expired'], [536, 'code_incorrect'], [537, 'too_many_retries'], [500, 'provider_request_failed']])('safe provider error %s without leaking code', async (code, suffix) => {
  const { email, run } = fixture(); email.verifyCode.mockRejectedValue(new Error(`email.verifyCode iq failed (${code}: SECRET)`))
  await expect(run({ operation: 'verify', code: '123456' })).rejects.toThrow(`profile_email_${suffix}`)
  expect(email.verifyCode).toHaveBeenCalledTimes(1)
})
test.each([{ operation: 'remove' }, { operation: 'verify', code: '12345' }, { operation: 'verify', code: '123456', email: 'me@example.com' }, { operation: 'set', email: 'bad' }, { operation: 'confirm', code: '123456' }, { operation: 'request_code', extra: true }])('invalid email operation %#', value => {
  expect(() => validateProfileCommand({ action: 'set', field: 'account_email', value })).toThrow('invalid_profile_')
})
