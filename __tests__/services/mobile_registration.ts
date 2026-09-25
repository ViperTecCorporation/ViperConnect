import { randomBytes } from 'node:crypto'
import { X25519, xeddsaSign } from 'zapo-js/crypto'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { MobileRegistrationService, REGISTRATION_PREFIX } from '../../src/services/mobile_primary/registration_service'

const draft: any = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', phone: '999123456789', name: 'Lab', platform: 'android', accountType: 'personal', state: 'draft' }
async function fixture() {
  const pair = async () => { const p = await X25519.generateKeyPair(); return { private: Buffer.from(p.privKey).toString('base64'), public: Buffer.concat([Buffer.from([5]), p.pubKey]).toString('base64') } }
  const identityKeyPair = await pair(); const signedPreKey = { ...await pair(), id: 1, signature: '' }
  signedPreKey.signature = Buffer.from(await xeddsaSign(Buffer.from(identityKeyPair.private, 'base64'), Buffer.from(signedPreKey.public, 'base64'))).toString('base64')
  return { phoneNumber: draft.phone, name: 'Lab', noiseKeyPair: await pair(), identityKeyPair, signedPreKey, registrationId: 12, registered: false, codePending: false, version: '2.26.27.70', device: { os: 'android', business: false, manufacturer: 'Samsung', modelId: 'SM-S928B', model: 'Galaxy', osVersion: '14', osBuildNumber: 'UP1A' } }
}
function setup(now = () => 1000000) {
  const rows = new Map<string, string>()
  const vault = new RegistrationVault('ab'.repeat(32))
  const provider = jest.fn()
  const enabled = jest.fn(() => true)
  const drafts = { get: jest.fn(async () => draft) }
  const redis = { get: jest.fn(async (key: string) => rows.get(key) || null), eval: jest.fn(async (_script, args) => {
    if ((rows.get(args.keys[1]) || '') !== args.arguments[2]) return 0
    rows.set(args.keys[1], args.arguments[3]); return 1
  }) }
  const service = new MobileRegistrationService(drafts, async () => redis, () => vault, provider, enabled, now)
  return { rows, vault, provider, enabled, drafts, redis, service }
}
describe('registration vault', () => {
  test('round-trip, randomized ciphertext, and no plaintext secret', () => {
    const v = new RegistrationVault('aa'.repeat(32)); const data = { secret: 'sensitive' }
    const envelope = v.seal('one', data)
    expect(envelope).not.toContain('sensitive'); expect(v.open('one', envelope)).toEqual(data)
    expect(v.seal('one', data)).not.toEqual(envelope)
    expect(() => v.open('two', envelope)).toThrow('unreadable')
    expect(() => new RegistrationVault('bb'.repeat(32)).open('one', envelope)).toThrow('unreadable')
    expect(() => v.open('one', envelope.slice(0, -5))).toThrow('unreadable')
  })
  test.each(['', 'secret', 'ff'.repeat(31)])('rejects malformed wrapping key', key => expect(() => new RegistrationVault(key)).toThrow())
})
describe('registration orchestration', () => {
  test.each([5, 20, undefined])('too_recent has no attempt ceiling for counter %s', async requestAttempts => {
    let now = 3810999
    const s = setup(() => now); const key = REGISTRATION_PREFIX + draft.id
    const store = { ...await fixture(), codePending: true }
    s.rows.set(key, s.vault.seal(draft.id, { status: 'blocked', error: 'rate_limited', updatedAt: 0, store, advSecret: 'ab'.repeat(32), requestAttempts, diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent', waitSeconds: 3811 } }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
    now++
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
    s.provider.mockResolvedValue({ store })
    expect(await s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).toMatchObject({ status: 'code_required' })
    expect(s.provider).toHaveBeenCalledTimes(1)
    expect(s.vault.open<any>(draft.id, s.rows.get(key)!)).toMatchObject({ store, requestAttempts: (requestAttempts || 1) + 1 })
  })
  test('unknown remote wait never invents a local deadline', async () => {
    const s = setup(() => 999999999); const key = REGISTRATION_PREFIX + draft.id
    s.rows.set(key, s.vault.seal(draft.id, { status: 'blocked', error: 'rate_limited', updatedAt: 0, store: { codePending: true }, diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent' } }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false, retryAt: undefined })
    await expect(s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).rejects.toMatchObject({ status: 409 })
    expect(s.provider).not.toHaveBeenCalled()
  })
  test.each([120, 7200])('provider wait %s takes priority over local fallback', async waitSeconds => {
    let now = waitSeconds * 1000 - 1
    const s = setup(() => now); const key = REGISTRATION_PREFIX + draft.id
    s.rows.set(key, s.vault.seal(draft.id, { status: 'blocked', error: 'rate_limited', updatedAt: 0, store: { codePending: true }, requestAttempts: 3, diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent', waitSeconds } }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false, retryAt: waitSeconds * 1000, diagnostic: { waitSeconds } })
    await expect(s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).rejects.toMatchObject({ status: 409 })
    now++
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
    expect(s.provider).not.toHaveBeenCalled()
  })
  test('too_recent permits only explicit concurrent-safe recovery after remote wait with unchanged keys', async () => {
    let now = 3599999
    const s = setup(() => now); const key = REGISTRATION_PREFIX + draft.id
    const store = { ...await fixture(), codePending: true }
    const state = { status: 'blocked', error: 'rate_limited', updatedAt: 0, store, advSecret: 'ab'.repeat(32), requestAttempts: 3, diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent', waitSeconds: 3600 } }
    s.rows.set(key, s.vault.seal(draft.id, state))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
    await expect(s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).rejects.toMatchObject({ status: 409 })
    now++
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
    expect(s.provider).not.toHaveBeenCalled()
    s.provider.mockResolvedValue({ store })
    const results = await Promise.allSettled([1, 2].map(() => s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.provider).toHaveBeenCalledTimes(1)
    expect(s.provider).toHaveBeenCalledWith({ action: 'request', draft, store })
    expect(s.vault.open<any>(draft.id, s.rows.get(key)!)).toMatchObject({ status: 'code_required', store, advSecret: state.advSecret, requestAttempts: 4 })
  })
  test('renewed too_recent restarts the wait and other refusals remain blocked', async () => {
    const s = setup(() => 7200000); const key = REGISTRATION_PREFIX + draft.id
    const state = { status: 'blocked', error: 'rate_limited', updatedAt: 0, store: { codePending: true }, advSecret: 'ab'.repeat(32), requestAttempts: 3, diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent', waitSeconds: 3600 } }
    for (const changes of [{ updatedAt: null }, { status: 'uncertain' }, { store: { codePending: true, registered: true } }, { diagnostic: { ...state.diagnostic, providerReason: 'too_many' } }, { diagnostic: { ...state.diagnostic, stage: 'verify' } }, { diagnostic: { ...state.diagnostic, providerPending: 'app_store_age' } }, { error: 'challenge_required' }]) {
      s.rows.set(key, s.vault.seal(draft.id, { ...state, ...changes }))
      expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
      await expect(s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).rejects.toMatchObject({ status: 409 })
    }
    expect(s.provider).not.toHaveBeenCalled()
    s.rows.set(key, s.vault.seal(draft.id, state))
    s.provider.mockResolvedValue({ error: 'rate_limited', diagnostic: state.diagnostic })
    expect(await s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).toMatchObject({ status: 'blocked', canResendSms: false })
    expect(s.vault.open<any>(draft.id, s.rows.get(key)!)).toMatchObject({ updatedAt: 7200000, requestAttempts: 4 })
  })
  test('additional confirmation permits a bounded explicit SMS experiment without rotating keys', async () => {
    const s = setup(); const store = { ...await fixture(), codePending: true }; const key = REGISTRATION_PREFIX + draft.id
    const state = { status: 'blocked', error: 'provider_failed', store, advSecret: 'ab'.repeat(32), updatedAt: 0, requestAttempts: 2, verificationAttempts: 3, diagnostic: { stage: 'verify', reason: 'provider_response', providerReason: 'device_confirm_or_second_code' } }
    s.rows.set(key, s.vault.seal(draft.id, state))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
    s.provider.mockImplementation(async input => { expect(input.action).toBe('request'); expect(input.store).toEqual(store); return { store } })
    expect(await s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).toMatchObject({ status: 'code_required' })
    expect(s.provider).toHaveBeenCalledTimes(1)
    expect(s.vault.open<any>(draft.id, s.rows.get(key)!)).toMatchObject({ requestAttempts: 3, advSecret: state.advSecret, verificationAttempts: 3 })
    s.rows.set(key, s.vault.seal(draft.id, { ...state, requestAttempts: 3 }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
    s.rows.set(key, s.vault.seal(draft.id, { ...state, error: 'rate_limited' }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
  })
  test('projects known confirmation requirement without mutating stored state or calling provider', async () => {
    const s = setup(); const key = REGISTRATION_PREFIX + draft.id
    const raw = s.vault.seal(draft.id, { status: 'blocked', error: 'provider_failed', updatedAt: 0, diagnostic: { stage: 'verify', reason: 'provider_response', providerReason: 'device_confirm_or_second_code' } })
    s.rows.set(key, raw)
    expect(await s.service.status(draft.id)).toMatchObject({ status: 'additional_confirmation_required', canRetryVerification: false, canResendSms: false })
    expect(s.rows.get(key)).toBe(raw)
    for (const action of ['request', 'verify'] as const) await expect(s.service.execute(draft.id, action, action === 'request' ? { confirm: true, confirmResend: true } : { code: '123456', confirmRecovery: true })).rejects.toMatchObject({ status: 409 })
    expect(s.provider).not.toHaveBeenCalled()
  })
  test('explicit resend preserves identity and allows only one concurrent request', async () => {
    const s = setup(); const store = { ...await fixture(), codePending: true }; const key = REGISTRATION_PREFIX + draft.id
    s.rows.set(key, s.vault.seal(draft.id, { status: 'blocked', error: 'provider_failed', store, advSecret: 'ab'.repeat(32), updatedAt: 0 }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
    s.provider.mockImplementation(async input => { expect(input.action).toBe('request'); expect(input.store).toEqual(store); return { store: input.store } })
    const results = await Promise.allSettled([1, 2].map(() => s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.provider).toHaveBeenCalledTimes(1)
    const saved = s.vault.open<any>(draft.id, s.rows.get(key)!)
    expect(saved).toMatchObject({ status: 'code_required', requestAttempts: 2, advSecret: 'ab'.repeat(32), store })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
  })
  test('missing SMS can be resent manually with original keys and remote wait from success', async () => {
    let now = 0; const s = setup(() => now); const store = await fixture(); const key = REGISTRATION_PREFIX + draft.id
    s.provider.mockResolvedValueOnce({ store }).mockResolvedValueOnce({ store: { ...store, codePending: true }, diagnostic: { stage: 'request', reason: 'unknown', providerStatus: 'sent', waitSeconds: 120 } })
    expect(await s.service.execute(draft.id, 'request', { confirm: true })).toMatchObject({ status: 'code_required', canResendSms: false, retryAt: 120000 })
    const before = s.vault.open<any>(draft.id, s.rows.get(key)!)
    now = 119999
    await expect(s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).rejects.toMatchObject({ status: 409 })
    now++
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
    s.provider.mockResolvedValueOnce({ error: 'rate_limited', diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent', waitSeconds: 300 } })
    expect(await s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).toMatchObject({ status: 'blocked', canResendSms: false, retryAt: 420000 })
    expect(s.provider).toHaveBeenLastCalledWith({ action: 'request', draft, store: before.store })
    expect(s.vault.open<any>(draft.id, s.rows.get(key)!)).toMatchObject({ advSecret: before.advSecret, requestAttempts: 2 })
  })
  test('missing SMS without a remote wait permits explicit resend, never challenge or incomplete state', async () => {
    const s = setup(); const key = REGISTRATION_PREFIX + draft.id
    const base = { status: 'code_required', updatedAt: 0, store: { codePending: true }, requestAttempts: 20 }
    s.rows.set(key, s.vault.seal(draft.id, base))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true, retryAt: undefined })
    for (const changes of [{ error: 'challenge_required' }, { store: { registered: true, codePending: true } }, { store: { codePending: false } }, { diagnostic: { stage: 'request', reason: 'provider_response', providerPending: 'approval' } }]) {
      s.rows.set(key, s.vault.seal(draft.id, { ...base, ...changes }))
      expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
    }
    expect(s.provider).not.toHaveBeenCalled()
  })
  test('resend respects cooldown, state, provider refusal and attempt cap', async () => {
    const s = setup(); const key = REGISTRATION_PREFIX + draft.id
    const base = { status: 'blocked', error: 'provider_failed', store: { codePending: true }, updatedAt: 0 }
    for (const changes of [{ updatedAt: 999999 }, { requestAttempts: 2 }, { status: 'uncertain' }, { status: 'registered' }, { status: 'requesting' }, { error: 'rate_limited' }, { error: 'challenge_required' }, { diagnostic: { stage: 'verify', reason: 'network' } }]) {
      s.rows.set(key, s.vault.seal(draft.id, { ...base, ...changes }))
      expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: false })
      await expect(s.service.execute(draft.id, 'request', { confirm: true, confirmResend: true })).rejects.toMatchObject({ status: 409 })
    }
    expect(s.provider).not.toHaveBeenCalled()
    s.rows.set(key, s.vault.seal(draft.id, { ...base, diagnostic: { stage: 'verify', reason: 'code_expired' } }))
    expect(await s.service.status(draft.id)).toMatchObject({ canResendSms: true })
  })
  test('legacy recovery is explicit, single-use, concurrent-safe and preserves keys', async () => {
    const s = setup(); const store = { ...await fixture(), codePending: true }
    const key = REGISTRATION_PREFIX + draft.id
    s.rows.set(key, s.vault.seal(draft.id, { status: 'blocked', error: 'provider_failed', store, advSecret: 'ab'.repeat(32), updatedAt: 0 }))
    expect(await s.service.status(draft.id)).toMatchObject({ canRetryVerification: true })
    await expect(s.service.execute(draft.id, 'verify', { code: '123456' })).rejects.toMatchObject({ status: 409 })
    s.provider.mockImplementation(async input => {
      expect(input.action).toBe('verify'); expect(input.store).toEqual(store)
      return { error: 'provider_failed', diagnostic: { stage: 'verify', reason: 'unknown', raw: 'SECRET' } }
    })
    const results = await Promise.allSettled([1, 2].map(() => s.service.execute(draft.id, 'verify', { code: '123456', confirmRecovery: true })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.provider).toHaveBeenCalledTimes(1)
    const publicState = await s.service.status(draft.id)
    expect(publicState).toMatchObject({ status: 'blocked', canRetryVerification: false, diagnostic: { stage: 'verify', reason: 'unknown' } })
    expect(JSON.stringify(publicState)).not.toContain('SECRET')
    expect(s.vault.open<any>(draft.id, s.rows.get(key)!).verificationAttempts).toBe(2)
  })
  test.each(['code_expired', 'challenge_required', 'rate_limited', 'network'])('never offers retry for %s', async reason => {
    const s = setup(); const key = REGISTRATION_PREFIX + draft.id
    s.rows.set(key, s.vault.seal(draft.id, { status: 'blocked', error: 'provider_failed', store: { codePending: true }, diagnostic: { stage: 'verify', reason }, updatedAt: 0 }))
    expect(await s.service.status(draft.id)).toMatchObject({ canRetryVerification: false })
    await expect(s.service.execute(draft.id, 'verify', { code: '123456', confirmRecovery: true })).rejects.toMatchObject({ status: 409 })
    expect(s.provider).not.toHaveBeenCalled()
  })
  test('permits one explicit recovery of old unknown diagnostics, not structured refusals', async () => {
    const s = setup(); const key = REGISTRATION_PREFIX + draft.id
    const state = { status: 'blocked', error: 'provider_failed', store: { codePending: true }, diagnostic: { stage: 'verify', reason: 'unknown' }, verificationAttempts: 2, updatedAt: 0 }
    s.rows.set(key, s.vault.seal(draft.id, state))
    expect(await s.service.status(draft.id)).toMatchObject({ canRetryVerification: true })
    await expect(s.service.execute(draft.id, 'verify', { code: '123456' })).rejects.toMatchObject({ status: 409 })
    for (const changes of [{ recoveryUsed: true }, { verificationAttempts: 3 }, { diagnostic: { ...state.diagnostic, providerStatus: 'fail' } }, { diagnostic: { ...state.diagnostic, httpStatus: 500 } }]) {
      s.rows.set(key, s.vault.seal(draft.id, { ...state, ...changes }))
      expect(await s.service.status(draft.id)).toMatchObject({ canRetryVerification: false })
    }
  })
  test('wrong-code recovery respects cooldown and total attempt cap', async () => {
    const s = setup(); const key = REGISTRATION_PREFIX + draft.id
    const state = { status: 'blocked', error: 'provider_failed', store: { codePending: true }, diagnostic: { stage: 'verify', reason: 'invalid_code' }, updatedAt: 0, verificationAttempts: 2 }
    for (const [updates, allowed] of [[{}, true], [{ updatedAt: 999999 }, false], [{ verificationAttempts: 3 }, false]] as const) {
      s.rows.set(key, s.vault.seal(draft.id, { ...state, ...updates }))
      expect(await s.service.status(draft.id)).toMatchObject({ canRetryVerification: allowed })
    }
  })
  test('gates operations and validates consent/code before storage', async () => {
    const s = setup(); s.enabled.mockReturnValue(false)
    await expect(s.service.status(draft.id)).rejects.toMatchObject({ status: 503 })
    expect(s.redis.get).not.toHaveBeenCalled(); s.enabled.mockReturnValue(true)
    for (const body of [{}, { confirm: true, extra: true }, []]) await expect(s.service.execute(draft.id, 'request', body)).rejects.toMatchObject({ status: 400 })
    await expect(s.service.execute(draft.id, 'verify', { code: 123456 })).rejects.toMatchObject({ status: 400 })
  })
  test('persists keys before request, confirms and returns only public status', async () => {
    const s = setup(); const store = await fixture()
    s.provider.mockImplementation(async input => {
      if (input.action === 'prepare') return { store }
      expect(s.rows.size).toBe(1)
      return { store: { ...input.store, registered: input.action === 'verify', codePending: input.action !== 'verify' } }
    })
    expect(await s.service.status(draft.id)).toMatchObject({ status: 'idle' })
    expect(await s.service.execute(draft.id, 'request', { confirm: true })).toMatchObject({ status: 'code_required' })
    expect(await s.service.execute(draft.id, 'verify', { code: '012345' })).toMatchObject({ status: 'registered', canonicalPhone: draft.phone })
    const raw = s.rows.get(REGISTRATION_PREFIX + draft.id)!
    expect(raw).not.toContain('012345'); expect(raw).not.toContain(store.identityKeyPair.private)
    expect(JSON.stringify(await s.service.status(draft.id))).not.toContain('store')
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
  })
  test('concurrent requests send at most one SMS', async () => {
    const s = setup(); const store = await fixture()
    s.provider.mockImplementation(async input => ({ store: input.action === 'prepare' ? store : { ...store, codePending: true } }))
    const results = await Promise.allSettled([s.service.execute(draft.id, 'request', { confirm: true }), s.service.execute(draft.id, 'request', { confirm: true })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.provider.mock.calls.filter(([input]) => input.action === 'request')).toHaveLength(1)
  })
  test.each(['challenge_required', 'rate_limited', 'provider_failed'])('blocks retry after %s', async error => {
    const s = setup(); s.provider.mockResolvedValueOnce({ store: await fixture() }).mockResolvedValueOnce({ error })
    expect(await s.service.execute(draft.id, 'request', { confirm: true })).toMatchObject({ status: 'blocked', error })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 409 })
  })
  test('timeout and identity substitution produce uncertain state without details', async () => {
    const s = setup(); s.provider.mockResolvedValueOnce({ store: await fixture() }).mockRejectedValueOnce(new Error('secret'))
    expect(await s.service.execute(draft.id, 'request', { confirm: true })).toMatchObject({ status: 'uncertain', error: 'provider_interrupted' })
    expect(JSON.stringify(await s.service.status(draft.id))).not.toContain('secret')
    const other = setup(); const store = await fixture()
    other.provider.mockResolvedValueOnce({ store }).mockResolvedValueOnce({ store: { ...store, registrationId: 13 } })
    expect(await other.service.execute(draft.id, 'request', { confirm: true })).toMatchObject({ status: 'uncertain' })
  })
  test('crashed operation is reported as uncertain after deadline', async () => {
    const s = setup(); s.rows.set(REGISTRATION_PREFIX + draft.id, s.vault.seal(draft.id, { status: 'requesting', updatedAt: 0 }))
    expect(await s.service.status(draft.id)).toMatchObject({ status: 'uncertain' })
    await expect(s.service.execute(draft.id, 'verify', { code: '123456' })).rejects.toMatchObject({ status: 409 })
  })
  test('prepare failure never starts a request', async () => {
    const s = setup(); s.provider.mockResolvedValue({ error: 'provider_failed' })
    await expect(s.service.execute(draft.id, 'request', { confirm: true })).rejects.toMatchObject({ status: 503 })
    expect(s.rows.size).toBe(0)
  })
})
