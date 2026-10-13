/** Session routing is distinct from the authenticated WhatsApp identity.
 * Old registrations retain their existing namespace until explicitly migrated. */
export function registrationSessionPhone(state: any, fallback: string): string {
  return state?.sessionPhone || state?.canonicalPhone || fallback
}

export function sameRegistrationPhone(phone: string, canonical: string): boolean {
  if (phone === canonical) return true
  return /^55\d{2}9\d{8}$/.test(phone) && canonical === phone.slice(0, 4) + phone.slice(5)
}
