'use strict'

// Only short protocol identifiers from these three fields, never free text.
function protocolCode(value) {
  return typeof value === 'string' && /^[a-z][a-z_]{1,47}$/.test(value) ? value : undefined
}

function responseDiagnostic(value, stage) {
  const detail = { stage: ['prepare', 'request', 'verify'].includes(stage) ? stage : 'prepare', reason: 'unknown' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return detail
  for (const [source, target] of [['status', 'providerStatus'], ['reason', 'providerReason'], ['pending', 'providerPending']]) {
    const code = protocolCode(value[source])
    if (code) detail[target] = code
  }
  if (detail.providerReason || detail.providerPending) detail.reason = 'provider_response'
  // Requests in this adapter use SMS only. Match the pinned provider's waitHint.
  const seconds = v => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) > 0 && Number(v) <= 2147483647 ? Number(v) : undefined
  const waits = ['sms_wait', 'voice_wait', 'wa_old_wait', 'flash_wait', 'email_otp_wait', 'send_sms_wait', 'silent_auth_wait'].map(k => seconds(value[k]) || 0)
  const waitSeconds = seconds(value.sms_wait) || Math.max(...waits) || seconds(value.retry_after)
  if (waitSeconds) detail.waitSeconds = waitSeconds
  return detail
}

// Never return provider messages, bodies, phone numbers, OTPs or key material.
function diagnostic(error, stage) {
  const message = String(error?.message || '')
  let reason = 'unknown'
  if (/code expired or already used/i.test(message)) reason = 'code_expired'
  else if (/wrong code entered/i.test(message)) reason = 'invalid_code'
  else if (/captcha|two.factor|\bPIN\b|consent|app_store_age/i.test(message)) reason = 'challenge_required'
  else if (/too.many|too.recent|wait a few|already sent recently/i.test(message)) reason = 'rate_limited'
  else if (/APK|NO_APK_MATERIAL/i.test(message)) reason = 'android_material'
  else if (/source_mismatch|module_required|Cannot find module/i.test(message)) reason = 'local_configuration'
  else if (/ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i.test(message)) reason = 'network'
  else {
    const serverReason = /^Verification failed: ([a-z_]+)$/.exec(message)?.[1]
    if (['bad_token', 'old_version', 'bad_param', 'temporarily_unavailable', 'security_code', 'blocked', 'incorrect', 'mismatch', 'not_allowed'].includes(serverReason)) reason = serverReason
  }
  const match = /^HTTP ([1-5]\d{2})\b/.exec(message)
  const httpStatus = match ? Number(match[1]) : undefined
  if (httpStatus && reason === 'unknown') reason = 'http_error'
  return { stage: ['prepare', 'request', 'verify'].includes(stage) ? stage : 'prepare', reason, ...(httpStatus ? { httpStatus } : {}) }
}

function failure(error, stage) {
  const detail = diagnostic(error, stage)
  return { error: ['challenge_required', 'rate_limited'].includes(detail.reason) ? detail.reason : 'provider_failed', diagnostic: detail }
}
module.exports = { diagnostic, failure, protocolCode, responseDiagnostic }
