type ContactLookup = {
  getByJid(jid: string): Promise<{ phoneNumber?: string } | null>
}

type ResolveOptions = {
  attempts?: number
  delayMs?: number
}

const wait = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

export const normalizeZapoPhoneJid = (value: string) => {
  const digits = `${value || ''}`.split('@')[0].split(':')[0].replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : undefined
}

export const resolveZapoPhoneJid = async (
  contacts: ContactLookup | undefined,
  jid: string,
  options: ResolveOptions = {},
) => {
  if (!contacts || !jid.endsWith('@lid')) return undefined
  // The companion echo can arrive a few seconds before its PN/LID contact update.
  const attempts = Math.max(1, options.attempts ?? 40)
  const delayMs = Math.max(0, options.delayMs ?? 125)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const phoneNumber = `${(await contacts.getByJid(jid))?.phoneNumber || ''}`.trim()
    const phoneJid = normalizeZapoPhoneJid(phoneNumber)
    if (phoneJid) return phoneJid
    if (attempt + 1 < attempts && delayMs > 0) await wait(delayMs)
  }
  return undefined
}
