import { isLidUser } from '@whiskeysockets/baileys'
import { formatJid, jidToPhoneNumber } from './transformer/jid'

export const profilePictureCacheIds = (jid: string): string[] => {
  const value = `${jid || ''}`.trim()
  if (!value) return []
  const normalized = value.includes('@') ? formatJid(value) : value
  const canonical = isLidUser(normalized) || normalized.endsWith('@g.us')
    ? normalized
    : jidToPhoneNumber(normalized)
  const legacy = jidToPhoneNumber(value)
  return Array.from(new Set([canonical, legacy].filter(Boolean)))
}
