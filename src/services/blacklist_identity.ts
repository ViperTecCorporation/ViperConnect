import { getConfigRedis } from './config_redis'
import { zapoStoreRegistry } from './zapo/zapo_store_registry'
import { contactPhoneLookupNumbers, normalizeContactPhoneNumber } from './zapo/zapo_contact_phone'

// Blacklist identities must not turn LID digits into phone numbers.
export const normalizeBlacklistIdentity = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  const jid = raw.match(/^\+?(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/i)
  if (jid) return jid[2].toLowerCase() === 'lid' ? `${jid[1]}@lid` : jid[1]
  if (/^\+?[\d\s()-]+$/.test(raw)) return raw.replace(/\D/g, '')
  return raw
}

export const blacklistTargets = (payload: any): string[] => {
  const value = payload?.entry?.[0]?.changes?.[0]?.value || {}
  const contact = value.contacts?.[0] || {}
  const message = value.messages?.[0] || value.smb_message_echoes?.[0] || {}
  const status = value.statuses?.[0] || {}
  const candidates = [payload?.to, contact.group_id, message.group_id, status.group_id,
    contact.wa_id, status.recipient_id, message.to, message.from]
    .map(normalizeBlacklistIdentity).filter(Boolean)
  // A group is the conversation; its sender is not an alias for that group.
  const group = candidates.find(id => id.endsWith('@g.us'))
  if (group) return [group]
  // Prefer the conversation's contact/recipient over an outgoing echo's own sender.
  const ids = [normalizeBlacklistIdentity(payload?.to || contact.wa_id || status.recipient_id || message.to || message.from)].filter(Boolean)
  const lids = [payload?.to_user_id || contact.user_id || status.recipient_user_id || status.user_id
    || message.to_user_id || message.from_user_id]
    .map(value => typeof value === 'string' && /^\d+$/.test(value) ? `${value}@lid` : value)
    .map(normalizeBlacklistIdentity).filter(Boolean)
  return [...new Set([...ids, ...lids])]
}

type Contact = { jid?: string; lid?: string; phoneNumber?: string }
export type BlacklistContacts = {
  getByJid(jid: string): Promise<Contact | null>
  getByPhoneNumber(phone: string): Promise<Contact | null>
}

export const resolveBlacklistAliases = async (
  session: string,
  targets: string[],
  lookup: (session: string) => Promise<BlacklistContacts | undefined> = getBlacklistContacts,
): Promise<string[]> => {
  const aliases = new Set(targets.map(normalizeBlacklistIdentity).filter(Boolean))
  const individuals = [...aliases].filter(id => /^\d+(@lid)?$/.test(id))
  if (!individuals.length) return [...aliases]
  const contacts = await lookup(session)
  const byPhone = async (pn: string) => await contacts?.getByPhoneNumber(pn)
    || await contacts?.getByPhoneNumber(`${pn}@s.whatsapp.net`)
  for (const id of individuals) {
    const isLid = id.endsWith('@lid')
    let contact = isLid ? await contacts?.getByJid(id) : await byPhone(id)
    // Exact identity wins; only a miss permits the existing Brazilian presentation fallback.
    if (!isLid && !contact) {
      for (const alternative of contactPhoneLookupNumbers(id).filter(pn => pn !== id)) {
        contact = await byPhone(alternative)
        if (contact) break
      }
    }
    const lid = normalizeBlacklistIdentity(contact?.lid || contact?.jid)
    const pn = normalizeBlacklistIdentity(contact?.phoneNumber)
    if (/^\d+@lid$/.test(lid)) aliases.add(lid)
    if (/^\d+$/.test(pn)) {
      aliases.add(pn)
      const presented = normalizeContactPhoneNumber(pn)
      if (presented && presented !== pn) {
        const owner = await byPhone(presented)
        const ownerLid = normalizeBlacklistIdentity(owner?.lid || owner?.jid)
        // Do not merge two independently stored contacts just because digits look similar.
        if (!owner || (lid.endsWith('@lid') && ownerLid === lid)) aliases.add(presented)
      }
    }
  }
  // Also check/delete legacy phone-JID keys; existing digits and LID keys stay valid.
  for (const id of [...aliases]) {
    if (/^\d+$/.test(id)) aliases.add(`${id}@s.whatsapp.net`)
  }
  return [...aliases]
}

async function getBlacklistContacts(session: string): Promise<BlacklistContacts | undefined> {
  const config = await getConfigRedis(session)
  if (config.provider !== 'zapo') return undefined
  return zapoStoreRegistry.get(config).session(session).contacts
}
