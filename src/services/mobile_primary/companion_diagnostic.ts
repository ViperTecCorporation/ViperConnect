/** Logs only classified failures, never provider text, QR, keys or raw stacks. */
export function companionDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  const known: Record<string, string> = {
    'worker_changed': 'worker_changed',
    'not_linked': 'not_linked',
    'mobile_companion_state_invalid': 'state_invalid',
    'mobile_companion_state_not_loaded': 'state_not_loaded',
    'mobile_companion_state_conflict': 'state_conflict',
    'mobile_companion_epoch_regression': 'epoch_regression',
    'mobile_registration_state_unreadable': 'state_unreadable',
    'client.mobile requires a mobile-primary session (connect via mobileTransport / a registered phone identity)': 'primary_required',
    'companion-host requires a registered primary session (no meJid)': 'primary_identity_missing',
    'no pending companion; a companion must request a pairing code for this account first': 'pending_companion_missing',
    'pair-device result missing <device jid>': 'device_jid_missing',
    'no active app-state sync key to share; the primary session is not initialized': 'app_state_key_missing',
  }
  const iq = /^companion-host\.(pair-device|primary-hello|revoke) iq failed \((\d{3}):/.exec(message)
  const reason = Object.prototype.hasOwnProperty.call(known, message) ? known[message]
    : iq ? 'provider_iq_rejected' : /timed?\s*out|timeout/i.test(message) ? 'timeout' : 'unclassified'
  const frames = error instanceof Error ? [...(error.stack || '').matchAll(/\/(WaMobileCoordinator|companion-host|companion_persistence|query)\.js:(\d+):(\d+)/g)] : []
  return {
    reason,
    ...(iq ? { stage: iq[1], providerCode: Number(iq[2]) } : {}),
    locations: frames.slice(0, 4).map(match => `${match[1]}.js:${match[2]}:${match[3]}`),
  }
}
