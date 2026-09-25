import { randomBytes } from 'node:crypto'
import { MOBILE_DRAFTS_KEY, MobileDeviceDraft, MobileDeviceError, MobileDeviceService } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { convertWhalibmobCredentials } from './whalibmob_credentials'
import { RegistrationDiagnostic, sanitizeRegistrationDiagnostic } from './registration_diagnostic'

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
export type RegistrationProvider = (input: { action: 'prepare' | 'request' | 'verify'; draft: MobileDeviceDraft; store?: unknown; code?: string }) => Promise<RegistrationResult>
interface RegistrationState {
  status: 'requesting' | 'code_required' | 'verifying' | 'registered' | 'blocked' | 'uncertain'
  updatedAt: number
  store?: unknown
  advSecret: string
  canonicalPhone?: string
  error?: string
  diagnostic?: RegistrationDiagnostic
  verificationAttempts?: number
  recoveryUsed?: boolean
  requestAttempts?: number
}

function canResendSms(state: RegistrationState, now: number): boolean {
  if (!Number.isFinite(state.updatedAt)) return false
  if (!(state.store as any)?.codePending || (state.store as any)?.registered) return false
  if (state.status === 'code_required') {
    const detail = sanitizeRegistrationDiagnostic(state.diagnostic)
    return !state.error && !detail?.providerPending &&
      (detail?.waitSeconds === undefined || now - state.updatedAt >= detail.waitSeconds * 1000)
  }
  if (state.status !== 'blocked') return false
  // Only a known remote wait releases this refusal; no local timer or attempt ceiling.
  if (state.error === 'rate_limited') {
    const waitSeconds = sanitizeRegistrationDiagnostic(state.diagnostic)?.waitSeconds
    return state.diagnostic?.stage === 'request' && state.diagnostic.providerReason === 'too_recent' &&
      !state.diagnostic.providerPending && waitSeconds !== undefined && now - state.updatedAt >= waitSeconds * 1000
  }
  if (state.error !== 'provider_failed' || now - state.updatedAt < 300000) return false
  // Explicit lab experiment, not a claimed implementation of the second-code protocol.
  if (state.diagnostic?.stage === 'verify' && state.diagnostic.providerReason === 'device_confirm_or_second_code') return (state.requestAttempts || 1) < 3
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
    const retryAt = ((state.status === 'blocked' && state.error === 'rate_limited') || state.status === 'code_required') && Number.isFinite(state.updatedAt) && diagnostic?.waitSeconds !== undefined
      ? state.updatedAt + diagnostic.waitSeconds * 1000 : undefined
    return { retryAt, status: stale ? 'uncertain' : additionalConfirmation ? 'additional_confirmation_required' : state.status, canonicalPhone: state.canonicalPhone, error: stale ? 'interrupted_operation' : state.error,
      diagnostic: sanitizeRegistrationDiagnostic(state.diagnostic), canRetryVerification: canRecoverVerification(state, this.now()), canResendSms: canResendSms(state, this.now()) }
  }
  async execute(id: string, action: 'request' | 'verify', input: unknown) {
    this.assertEnabled()
    const body = input as any
    const allowed = action === 'request' ? ['confirm', 'confirmResend'] : ['code', 'confirmRecovery']
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) ||
      (action === 'request' ? body.confirm !== true || (body.confirmResend !== undefined && typeof body.confirmResend !== 'boolean') : typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || (body.confirmRecovery !== undefined && typeof body.confirmRecovery !== 'boolean'))) {
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
    const resend = action === 'request' && previous && body.confirmResend === true && canResendSms(previous, this.now())
    if (action === 'request' ? (!!previous && !resend) || (!previous && body.confirmResend === true) : previous?.status !== 'code_required' && !recovery) {
      throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    }
    const prepared = action === 'request' && !resend ? await this.provider({ action: 'prepare', draft }) : undefined
    if (action === 'request' && !resend && (!prepared?.store || prepared.error)) throw new MobileDeviceError(503, 'mobile_registration_disabled')
    const pending: RegistrationState = {
      ...previous, status: action === 'request' ? 'requesting' : 'verifying', updatedAt: this.now(),
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
      const response = await this.provider({ action, draft, store: pending.store, ...(action === 'verify' ? { code: body.code } : {}) })
      if (response.store) {
        const before = pending.store as any
        if (['noiseKeyPair', 'identityKeyPair', 'signedPreKey', 'registrationId'].some(field => JSON.stringify(response.store[field]) !== JSON.stringify(before[field])) ||
          response.store.device?.os !== draft.platform || response.store.device?.business !== (draft.accountType === 'business')) throw new Error('identity_changed')
      }
      if (response.error || !response.store) {
        result = { ...pending, status: 'blocked', error: response.error || 'provider_failed', diagnostic: sanitizeRegistrationDiagnostic(response.diagnostic) }
      } else if (action === 'request') {
        result = { ...pending, status: 'code_required', store: response.store, diagnostic: sanitizeRegistrationDiagnostic(response.diagnostic) }
      } else {
        const converted = await convertWhalibmobCredentials(response.store, {
          expectedCanonicalPhone: response.store.phoneNumber,
          advSecretKey: Buffer.from(pending.advSecret, 'base64'),
        })
        result = { ...pending, status: 'registered', store: response.store, canonicalPhone: converted.meJid!.split('@')[0] }
      }
    } catch { result = { ...pending, status: 'uncertain', error: 'provider_interrupted' } }
    result.updatedAt = this.now()
    if (Number(await save(encrypted, vault.seal(id, result))) !== 1) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
    return this.status(id)
  }
}
