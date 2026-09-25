export interface RegistrationDiagnostic {
  stage: 'prepare' | 'request' | 'verify'
  reason: string
  httpStatus?: number
  providerStatus?: string
  providerReason?: string
  providerPending?: string
  waitSeconds?: number
}
const reasons = ['unknown', 'code_expired', 'invalid_code', 'challenge_required', 'rate_limited', 'android_material', 'local_configuration', 'network', 'http_error', 'bad_token', 'old_version', 'bad_param', 'temporarily_unavailable', 'security_code', 'blocked', 'incorrect', 'mismatch', 'not_allowed']

/** Apply an allowlist again at the IPC/service boundary, including injected providers. */
export function sanitizeRegistrationDiagnostic(value: any): RegistrationDiagnostic | undefined {
  if (!value || !['prepare', 'request', 'verify'].includes(value.stage) || ![...reasons, 'provider_response'].includes(value.reason)) return undefined
  const result: RegistrationDiagnostic = { stage: value.stage, reason: value.reason, ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) }
  if (Number.isSafeInteger(value.waitSeconds) && value.waitSeconds > 0 && value.waitSeconds <= 2147483647) result.waitSeconds = value.waitSeconds
  for (const field of ['providerStatus', 'providerReason', 'providerPending'] as const) {
    if (typeof value[field] === 'string' && /^[a-z][a-z_]{1,47}$/.test(value[field])) result[field] = value[field]
  }
  return result
}
