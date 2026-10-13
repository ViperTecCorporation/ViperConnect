'use strict'

// Never return payload values except this explicit, bounded non-secret list.
function sanitizeRequestTrace(value) {
  if (!value || !['/code', '/exist', '/register'].includes(value.endpoint)) return undefined
  const out = { endpoint: value.endpoint }
  for (const name of ['cc', 'nationalDigits', 'mcc', 'mnc', 'sim_mcc', 'sim_mnc']) {
    if (/^\d{1,3}$/.test(String(value[name] ?? ''))) out[name] = String(value[name])
  }
  for (const name of ['method', 'os', 'version', 'lg', 'lc']) {
    if (/^[a-zA-Z0-9_.-]{1,32}$/.test(value[name] || '')) out[name] = value[name]
  }
  for (const name of ['business', 'tokenPresent', 'pushPresent', 'vnamePresent', 'bodyAttestationPresent', 'authorizationPresent', 'pacing', 'funnelTelemetry']) {
    if (typeof value[name] === 'boolean') out[name] = value[name]
  }
  return out
}

function requestTrace(endpoint, plaintext, device, version, bodyAtt) {
  const form = new URLSearchParams(plaintext)
  return sanitizeRequestTrace({
    endpoint, cc: form.get('cc'), nationalDigits: String((form.get('in') || '').length),
    method: form.get('method'), os: device?.os, business: !!device?.business, version,
    lg: form.get('lg'), lc: form.get('lc'), mcc: form.get('mcc'), mnc: form.get('mnc'),
    sim_mcc: form.get('sim_mcc'), sim_mnc: form.get('sim_mnc'),
    tokenPresent: !!form.get('token'), pushPresent: !!form.get('push_token'), vnamePresent: !!form.get('vname'),
    bodyAttestationPresent: !!bodyAtt?.bodyAttestation, authorizationPresent: !!bodyAtt?.authorizationHeader,
    pacing: process.env.WA_REG_PACING !== '0', funnelTelemetry: process.env.WA_FUNNEL_LOG !== '0',
  })
}
module.exports = { requestTrace, sanitizeRequestTrace }
