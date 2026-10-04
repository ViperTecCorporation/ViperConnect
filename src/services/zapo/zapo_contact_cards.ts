/* eslint-disable @typescript-eslint/no-explicit-any */
import { contactPhoneLookupNumbers } from './zapo_contact_phone'
import logger from '../logger'

// Only contact-card numbers, never the delivery envelope. Keep unconfirmed
// numbers usable as ordinary address-book contacts (including non-WhatsApp ones).
export async function normalizeZapoContactCards(payload: any, resolvePhone: (phone: string) => Promise<string>): Promise<any> {
  if (payload?.type !== 'contacts' || !Array.isArray(payload.contacts)) return payload
  const resolved = new Map<string, string | undefined>()
  let changed = 0
  const contacts: any[] = []
  for (const contact of payload.contacts) {
    if (!Array.isArray(contact?.phones)) { contacts.push(contact); continue }
    const phones: any[] = []
    for (const item of contact.phones) {
      const digits = `${item?.wa_id || item?.phone || ''}`.replace(/\D/g, '')
      // Brazilian mobiles only. Do not rewrite landlines or foreign numbers.
      if (!/^55\d{2}(?:9[6-9]\d{7}|[6-9]\d{7})$/.test(digits)) { phones.push(item); continue }
      if (!resolved.has(digits)) {
        let canonical: string | undefined
        try {
          const jid = await resolvePhone(digits)
          const phone = jid.replace(/@s\.whatsapp\.net$/, '')
          if (/^\d+$/.test(phone) && contactPhoneLookupNumbers(digits).includes(phone)) canonical = phone
        } catch { /* An unavailable lookup must not prevent sharing a contact. */ }
        resolved.set(digits, canonical)
      }
      const canonical = resolved.get(digits)
      if (!canonical || canonical === digits) { phones.push(item); continue }
      // A distinct secondary phone must not be replaced by the wa_id's number.
      const phoneDigits = `${item?.phone || ''}`.replace(/\D/g, '')
      const samePhone = !phoneDigits || contactPhoneLookupNumbers(digits).includes(phoneDigits)
      phones.push({ ...item, wa_id: canonical, ...(samePhone ? { phone: `${`${item?.phone || ''}`.startsWith('+') ? '+' : ''}${canonical}` } : {}) })
      changed += 1
    }
    contacts.push({ ...contact, phones })
  }
  logger.info({ changed, queried: resolved.size }, 'ZAPO_CONTACT_CARD_CANONICAL')
  return { ...payload, contacts }
}
