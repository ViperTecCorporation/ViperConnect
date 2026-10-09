import { randomBytes } from 'node:crypto'
import { MOBILE_DRAFTS_KEY, MobileDeviceDraft, MobileDeviceError, MobileDeviceService } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { convertWhalibmobCredentials } from './whalibmob_credentials'
import { RegistrationDiagnostic, sanitizeRegistrationDiagnostic } from './registration_diagnostic'
import { sameRegistrationPhone } from './registration_identity'

export const REGISTRATION_PREFIX = 'mobile-primary:{v1}:registration:'
export const REGISTRATION_CAS = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
local old = redis.call('GET', KEYS[2]) or ''
if old ~= ARGV[3] then return 0 end
redis.call('SET', KEYS[2], ARGV[4])
return 1`
export interface RegistrationRedis {
  get(key: string): Promise<string | null>
  eval(script: string, args: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export interface RegistrationResult { store?: any; error?: 'challenge_required' | 'rate_limited' | 'provider_failed'; diagnostic?: RegistrationDiagnostic }
export type RegistrationProvider = (input: { action: 'prepare' | 'request' | 'verify' | 'check'; draft: MobileDeviceDraft; store?: unknown; code?: string; method?: 'sms' | 'voice' }) => Promise<RegistrationResult>
interface RegistrationState {
  method?: 'sms' | 'voice'
  status: 'requesting' | 'code_required' | 'verifying' | 'registered' | 'blocked' | 'uncertain'
  updatedAt: number
  store?: unknown
  advSecret: string
  canonicalPhone?: string
  sessionPhone?: string
  confirmationCheckAt?: number
  error?: string
  diagnostic?: RegistrationDiagnostic
  verificationAttempts?: number
  recoveryUsed?: boolean
  requestAttempts?: number
}

function canResendSms(state: RegistrationState, now: number, method: 'sms' | 'voice' = 'sms'): boolean {
  const diagnostic = sanitizeRegistrationDiagnostic(state.diagnostic)
  const wait = method === 'voice' ? diagnostic?.voiceWaitSeconds : diagnostic?.smsWaitSeconds
  if (wait !== undefined) state = { ...state, diagnostic: { ...diagnostic!, waitSeconds: wait } }
  if (!Number.isFinite(state.updatedAt)) return false
  // Only the relay preflight can prove no /code request was sent. Unknown
  // outcomes or generic network errors remain ineligible for automatic recovery.
  if (state.status === 'blocked' && state.error === 'provider_failed' && diagnostic?.stage === 'request' && diagnostic.reason === 'ipv6_relay_configuration') {
    return !!state.store && !(state.store as any).registered && !diagnostic.providerStatus &&
      !diagnostic.providerReason && !diagnostic.providerPending && diagnostic.httpStatus === undefined &&
      (wait ?? diagnostic.waitSeconds) === undefined
  }
  if (state.status === 'blocked' && state.error === 'provider_failed' && diagnostic?.stage === 'request' && ['no_routes', 'blocked'].includes(diagnostic.providerReason || '')) {
    const seconds = wait ?? diagnostic.waitSeconds
    return !!state.store && !(state.store as any).registered && !diagnostic.providerPending &&
      (diagnostic.providerReason === 'blocked' || method !== (state.method || 'sms') || seconds !== undefined) && (seconds === undefined || now - state.updatedAt >= seconds * 1000)
  }
  // A refused /code request has no pending code. Honor its remote cooldown
  // before requiring codePending, with an independent deadline per method.
  if (state.status === 'blocked' && state.error === 'rate_limited') {
    const seconds = wait ?? diagnostic?.waitSeconds
    return !!state.store && !(state.store as any).registered && diagnostic?.stage === 'request' &&
      diagnostic.providerReason === 'too_recent' && !diagnostic.providerPending &&
      seconds !== undefined && now - state.updatedAt >= seconds * 1000
  }
  if (!(state.store as any)?.codePending || (state.store as any)?.registered) return false
  if (state.status === 'code_required') {
    const detail = sanitizeRegistrationDiagnostic(state.diagnostic)
    return !state.error && !detail?.providerPending &&
      (detail?.waitSeconds === undefined || now - state.updatedAt >= detail.waitSeconds * 1000)
  }
  if (state.status !== 'blocked') return false
  if (['provider_failed', 'challenge_required'].includes(state.error || '') && diagnostic?.stage === 'verify' && diagnostic.providerReason === 'device_confirm_or_second_code') {
    const seconds = wait ?? diagnostic.waitSeconds
    return !diagnostic.providerPending && seconds !== undefined && now - state.updatedAt >= seconds * 1000
  }
  if (state.error !== 'provider_failed' || now - state.updatedAt < 300000) return false
  if ((state.requestAttempts || 1) >= 2) return false
  return !state.diagnostic || (state.diagnostic.stage === 'verify' && state.diagnostic.reason === 'code_expired')
}

function canRecoverVerification(state: RegistrationState, now: number): boolean {
  if (state.status !== 'blocked' || state.error !== 'provider_failed' || now - state.updatedAt < 60000 || (state.verificationAttempts || 1) >= 3) return false
  if (!(state.store as any)?.codePending || (state.store as any)?.registered) return false
  // One explicit diagnostic recovery for legacy records that discarded the cause.
  if (!state.diagnostic) return !state.recoveryUsed
  if (state.diagnostic.stage === 'verify' && state.diagnostic.reason === 'unknown' && !state.diagnostic.providerStatus && !state.diagnostic.providerReason && !state.diagnostic.providerPending && !state.diagnostic.httpStatus) return !state.recoveryUsed
  return state.diagnostic.stage === 'verify' && state.diagnostic.reason === 'invalid_code'
}

export class MobileRegistrationService {
  constructor(
    private readonly drafts: Pick<MobileDeviceService, 'get'>,
    private readonly redis: () => Promise<RegistrationRedis>,
    private readonly vault: () => RegistrationVault,
    private readonly provider: RegistrationProvider,
    readonly enabled: () => boolean,
    private readonly now = Date.now,
  ) {}
  private assertEnabled() {
    if (!this.enabled()) throw new MobileDeviceError(503, 'mobile_registration_disabled')
  }
  async status(id: string) {
    this.assertEnabled()
    await this.drafts.get(id)
    const raw = await (await this.redis()).get(REGISTRATION_PREFIX + id)
    if (!raw) return { status: 'idle', canonicalPhone: undefined, error: undefined }
    const state = this.vault().open<RegistrationState>(id, raw)
    const stale = ['requesting', 'verifying'].includes(state.status) && this.now() - state.updatedAt > 120000
    const additionalConfirmation = state.status === 'blocked' && state.diagnostic?.stage === 'verify' && state.diagnostic?.providerReason === 'device_confirm_or_second_code'
    const diagnostic = sanitizeRegistrationDiagnostic(state.diagnostic)
    const smsWait = diagnostic?.smsWaitSeconds ?? diagnostic?.waitSeconds
    const retryAt = (additionalConfirmation || (state.status === 'blocked' && (state.error === 'rate_limited' || ['no_routes', 'blocked'].includes(diagnostic?.providerReason || ''))) || state.status === 'code_required') && Number.isFinite(state.updatedAt) && smsWait !== undefined
      ? state.updatedAt + smsWait * 1000 : undefined
    return { method: state.method || 'sms', canResendVoice: canResendSms(state, this.now(), 'voice'), retryAtVoice: diagnostic?.voiceWaitSeconds !== undefined ? state.updatedAt + diagnostic.voiceWaitSeconds * 1000 : retryAt, retryAt, status: stale ? 'uncertain' : additionalConfirmation ? 'additional_confirmation_required' : state.status, canonicalPhone: state.canonicalPhone, error: stale ? 'interrupted_operation' : state.error,
      diagnostic: sanitizeRegistrationDiagnostic(state.diagnostic), canRetryVerification: canRecoverVerification(state, this.now()), canResendSms: canResendSms(state, this.now()) }
  }
  /** Explicit remote check after device approval. Never requests or verifies an OTP. */
  async checkConfirmation(id: string, input: any) {
    this.assertEnabled()
    if (!input || input.confirm !== true || Object.keys(input).some(key => key !== 'confirm')) throw new MobileDeviceError(400, 'mobile_registration_invalid_input')
    const draft = await this.drafts.get(id), redis = await this.redis(), vault = this.vault()
    const key = REGISTRATION_PREFIX + id, raw = await redis.get(key)
    if (!raw) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    const state = vault.open<RegistrationState>(id, raw)
    if (state.status === 'registered') return this.status(id)
    if (!['blocked', 'uncertain'].includes(state.status) || state.diagnostic?.stage !== 'verify' || state.diagnostic.providerReason !== 'device_confirm_or_second_code' || !(state.store as any)?.codePending || (state.store as any)?.registered) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    if (state.confirmationCheckAt !== undefined && this.now() - state.confirmationCheckAt < 15000) throw new MobileDeviceError(409, 'mobile_registration_check_wait')
    const reserved = { ...state, confirmationCheckAt: this.now() }
    const encrypted = vault.seal(id, reserved)
    const save = (before: string, after: string) => redis.eval(REGISTRATION_CAS, { keys: [MOBILE_DRAFTS_KEY, key], arguments: [draft.phone, JSON.stringify(draft), before, after] })
    if (Number(await save(raw, encrypted)) !== 1) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    let response: RegistrationResult
    try { response = await this.provider({ action: 'check', draft, store: state.store }) }
    catch { throw new MobileDeviceError(503, 'mobile_registration_check_failed') }
    // A failed query does not replace the original challenge or reset resend deadlines.
    if (response.error || !response.store) throw new MobileDeviceError(503, 'mobile_registration_check_failed')
    const before = state.store as any, after = response.store
    if (['noiseKeyPair', 'identityKeyPair', 'signedPreKey', 'registrationId'].some(field => JSON.stringify(after[field]) !== JSON.stringify(before[field])) || after.device?.os !== draft.platform || after.device?.business !== (draft.accountType === 'business') || !sameRegistrationPhone(draft.phone, after.phoneNumber)) throw new MobileDeviceError(409, 'mobile_registration_identity_mismatch')
    await convertWhalibmobCredentials(after, { expectedCanonicalPhone: after.phoneNumber, advSecretKey: Buffer.from(state.advSecret, 'base64') })
    const result = { ...reserved, status: 'registered', store: after, canonicalPhone: after.phoneNumber, sessionPhone: draft.phone, updatedAt: this.now(), error: undefined, diagnostic: undefined }
    if (Number(await save(encrypted, vault.seal(id, result))) !== 1) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    return this.status(id)
  }

  async execute(id: string, action: 'request' | 'verify', input: unknown) {
    this.assertEnabled()
    const body = input as any
    const allowed = action === 'request' ? ['confirm', 'confirmResend', 'method'] : ['code', 'confirmRecovery']
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) ||
      (action === 'request' ? body.confirm !== true || (body.method !== undefined && !['sms', 'voice'].includes(body.method)) || (body.confirmResend !== undefined && typeof body.confirmResend !== 'boolean') : typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || (body.confirmRecovery !== undefined && typeof body.confirmRecovery !== 'boolean'))) {
      throw new MobileDeviceError(400, 'mobile_registration_invalid_input')
    }
    const draft = await this.drafts.get(id)
    const redis = await this.redis()
    const key = REGISTRATION_PREFIX + id
    const raw = await redis.get(key)
    const vault = this.vault()
    const previous = raw ? vault.open<RegistrationState>(id, raw) : undefined
    // No automatic resends after failures/unknown outcomes. Never rotate registration keys.
    const recovery = action === 'verify' && previous && body.confirmRecovery === true && canRecoverVerification(previous, this.now())
    const resend = action === 'request' && previous && body.confirmResend === true && canResendSms(previous, this.now(), body.method || 'sms')
    if (action === 'request' ? (!!previous && !resend) || (!previous && body.confirmResend === true) : previous?.status !== 'code_required' && !recovery) {
      throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    }
    const prepared = action === 'request' && !resend ? await this.provider({ action: 'prepare', draft }) : undefined
    if (action === 'request' && !resend && (!prepared?.store || prepared.error)) throw new MobileDeviceError(503, 'mobile_registration_disabled')
    const pending: RegistrationState = {
      ...previous, method: action === 'request' ? body.method || 'sms' : previous?.method || 'sms', status: action === 'request' ? 'requesting' : 'verifying', updatedAt: this.now(),
      store: prepared?.store || previous?.store,
      advSecret: previous?.advSecret || randomBytes(32).toString('base64'),
      error: undefined, diagnostic: undefined,
      verificationAttempts: action === 'verify' ? (previous?.verificationAttempts || (recovery ? 1 : 0)) + 1 : (previous?.verificationAttempts || (resend ? 1 : 0)),
      requestAttempts: action === 'request' ? (previous?.requestAttempts || (resend ? 1 : 0)) + 1 : previous?.requestAttempts,
      recoveryUsed: previous?.recoveryUsed || !!recovery,
    }
    const encrypted = vault.seal(id, pending)
    const save = (before: string, after: string) => redis.eval(REGISTRATION_CAS, {
      keys: [MOBILE_DRAFTS_KEY, key], arguments: [draft.phone, JSON.stringify(draft), before, after],
    })
    if (Number(await save(raw || '', encrypted)) !== 1) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    let result: RegistrationState
    try {
      const response = await this.provider({ action, draft, store: pending.store, ...(action === 'verify' ? { code: body.code } : { method: pending.method }) })
      if (response.store) {
        const before = pending.store as any
        if (['noiseKeyPair', 'identityKeyPair', 'signedPreKey', 'registrationId'].some(field => JSON.stringify(response.store[field]) !== JSON.stringify(before[field])) ||
          response.store.device?.os !== draft.platform || response.store.device?.business !== (draft.accountType === 'business')) throw new Error('identity_changed')
      }
      if (response.error || !response.store) {
        result = { ...pending, ...(action === 'request' && response.store ? { store: response.store } : {}), status: 'blocked', error: response.error || 'provider_failed', diagnostic: sanitizeRegistrationDiagnostic(response.diagnostic) }
      } else if (action === 'request') {
        result = { ...pending, status: 'code_required', store: response.store, diagnostic: sanitizeRegistrationDiagnostic(response.diagnostic) }
      } else {
        const converted = await convertWhalibmobCredentials(response.store, {
          expectedCanonicalPhone: response.store.phoneNumber,
          advSecretKey: Buffer.from(pending.advSecret, 'base64'),
        })
        if (!sameRegistrationPhone(draft.phone, response.store.phoneNumber)) throw new Error('identity_changed')
        result = { ...pending, status: 'registered', store: response.store, canonicalPhone: converted.meJid!.split('@')[0], sessionPhone: draft.phone }
      }
    } catch { result = { ...pending, status: 'uncertain', error: 'provider_interrupted' } }
    result.updatedAt = this.now()
    if (Number(await save(encrypted, vault.seal(id, result))) !== 1) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    return this.status(id)
  }
}
