import { SendError } from './send_error'

// Zapo 1.9.0 protocol/privacy: values differ by setting; never use a global enum.
export const privacyValues: Record<string, readonly string[]> = {
  lastSeen: ['all', 'contacts', 'contact_blacklist', 'none'], online: ['all', 'none', 'match_last_seen'],
  profilePicture: ['all', 'contacts', 'contact_blacklist', 'none'], about: ['all', 'contacts', 'contact_blacklist', 'none'],
  readReceipts: ['all', 'none'], groupAdd: ['all', 'contacts', 'contact_blacklist'], callAdd: ['all', 'known', 'contacts'],
  messages: ['all', 'contacts'], defenseMode: ['off', 'on_standard'],
  linkedProfiles: ['all', 'contacts', 'contact_blacklist', 'none'], pix: ['all', 'contacts', 'contact_blacklist', 'none'],
}
export const privacyExceptions = ['about', 'groupAdd', 'lastSeen', 'profilePicture', 'linkedProfiles', 'pix']
export const privacyDurations = [0, 86400, 604800, 7776000]
export function validatePrivacyInput(value: any) {
  const fail = (): never => { throw new SendError(400, 'invalid_profile_privacy') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const operations = { setting: ['operation', 'setting', 'value'], exceptions: ['operation', 'setting', 'add', 'remove'],
    block: ['operation', 'jid'], unblock: ['operation', 'jid'], timer: ['operation', 'duration'], status: ['operation', 'mode', 'userJids'] }
  if (typeof value.operation !== 'string' || !Object.prototype.hasOwnProperty.call(operations, value.operation)) fail()
  const allowed = operations[value.operation] as string[]
  if (Object.keys(value).some(k => !allowed.includes(k))) fail()
  const jid = (v: unknown) => typeof v === 'string' && /^\d{5,20}(?:@(?:s\.whatsapp\.net|lid))?$/.test(v)
  if (value.operation === 'status') {
    if (!['CONTACTS', 'DENY_LIST', 'ALLOW_LIST'].includes(value.mode)) fail()
    if (!Array.isArray(value.userJids) || value.userJids.length > 100 || !value.userJids.every(jid)) fail()
    if (value.mode === 'CONTACTS' ? value.userJids.length !== 0 : value.userJids.length === 0) fail()
  }
  if (value.operation === 'setting' && (typeof value.setting !== 'string' || !Object.prototype.hasOwnProperty.call(privacyValues, value.setting) || !privacyValues[value.setting].includes(value.value))) fail()
  if (value.operation === 'timer' && !privacyDurations.includes(value.duration)) fail()
  if (['block', 'unblock'].includes(value.operation) && !jid(value.jid)) fail()
  if (value.operation === 'exceptions') {
    if (!privacyExceptions.includes(value.setting)) fail()
    for (const key of ['add', 'remove']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 100 || !value[key].every(jid))) fail()
    if (!(value.add?.length || value.remove?.length)) fail()
    if (value.add?.some((id: string) => value.remove?.includes(id))) fail()
  }
}
