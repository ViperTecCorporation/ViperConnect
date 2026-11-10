import { SendError } from './send_error'

const protectedFields = new Set(['server', 'provider', 'owner', 'workerid', 'storageid', 'generation', 'storage', 'basestore',
  'getstore', 'useredis', 'uses3', 'connectiontype', 'zapowebclientprofile', 'coexistenceenabled',
  'getmessagemetadata', 'shouldignorejid', 'shouldignorekey', 'custommessagecharactersfunction', '__proto__', 'prototype', 'constructor'])

/** Template commands are public configuration patches, never storage/lifecycle control. */
export function commanderConfigPatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SendError(400, 'commander_config_invalid')
  const entries = Object.entries(value)
  for (const [key] of entries) {
    const normalized = key.toLowerCase()
    if (protectedFields.has(normalized) || /^(sessionstorage|mobileprimary|sessiontransfer)/.test(normalized)) {
      throw new SendError(400, 'commander_config_protected_fields')
    }
  }
  // Preserve the command's existing truthy-value patch semantics; validate every
  // supplied field first, including false/null protected values.
  return Object.fromEntries(entries.filter(([, field]) => !!field))
}
