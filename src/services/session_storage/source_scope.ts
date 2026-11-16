import { privateSessionKeyOwner } from './private_keys'

/** One registry for compatibility import and verified source cleanup. Unknown domains fail closed. */
export const SESSION_COMPATIBILITY_DATA_FAMILIES = ['message', 'id', 'id_rev', 'key', 'message-status', 'jidmap', 'jid', 'contact-name', 'contact-info',
  'last-incoming', 'media', 'profile-picture', 'profile-picture-miss', 'profile-picture-webhook', 'profile-picture-refresh', 'group', 'poll-state',
  'transcription-reference', 'template', 'status-recipients', 'status-media', 'status-media-recovery', 'zapo-username-lid']

export function isSessionCompatibilityDataKey(key: string, phone: string): boolean {
  return SESSION_COMPATIBILITY_DATA_FAMILIES.some(domain => key === `unoapi-${domain}:${phone}` || key.startsWith(`unoapi-${domain}:${phone}:`))
    || privateSessionKeyOwner(key) === phone
}

/** Old broad snapshots may contain these exact Redis-only bootstrap/config records. */
export function isRetainedSessionControlKey(key: string, phone: string): boolean {
  return key === `unoapi-history-sync:${phone}:started` || key === `unoapi-webhook-history:${phone}`
}
