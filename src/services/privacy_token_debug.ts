import { BufferJSON, isLidUser, isPnUser, jidNormalizedUser } from '@whiskeysockets/baileys'
import { BASE_KEY, getAuthIndexMembers, getAuthRaw } from './redis'
import { getLidForPnFromAuthCache, getPnForLidFromAuthCache } from './redis'

type TokenDebugEntry = {
  jid: string
  storage_jid: string
  key: string
  exists: boolean
  token_bytes: number
  timestamp?: string | number
  sender_timestamp?: string | number
}

const NCT_SALT_KEY = '__nct_salt__'

const parseAuthValue = (raw?: string): any => {
  if (!raw) return undefined
  return JSON.parse(raw, BufferJSON.reviver)
}

const byteLength = (value: any): number => {
  if (!value) return 0
  if (value instanceof Uint8Array) return value.length
  if (Buffer.isBuffer(value)) return value.length
  if (Array.isArray(value?.data)) return value.data.length
  if (typeof value === 'string') return Buffer.byteLength(value)
  return 0
}

const tokenAuthId = (jid: string) => `${jidNormalizedUser(jid)}`

const tokenAuthKey = (phone: string, id: string) => `${BASE_KEY}auth:${phone}:tctoken-${id}`

const readTokenEntry = async (phone: string, jid: string): Promise<TokenDebugEntry> => {
  const storageJid = tokenAuthId(jid)
  const raw = await getAuthRaw(`${phone}:tctoken-${storageJid}`)
  const parsed = parseAuthValue(raw)
  return {
    jid,
    storage_jid: storageJid,
    key: tokenAuthKey(phone, storageJid),
    exists: !!parsed,
    token_bytes: byteLength(parsed?.token),
    timestamp: parsed?.timestamp,
    sender_timestamp: parsed?.senderTimestamp,
  }
}

const expandCandidates = async (phone: string, rawTargets: string[]): Promise<string[]> => {
  const candidates = new Set<string>()
  for (const raw of rawTargets || []) {
    const value = `${raw || ''}`.trim()
    if (!value) continue
    const jid = value.includes('@') ? jidNormalizedUser(value) : `${value.replace(/\D/g, '')}@s.whatsapp.net`
    candidates.add(jid)
    if (isPnUser(jid)) {
      const lid = await getLidForPnFromAuthCache(phone, jid).catch(() => undefined)
      if (lid) candidates.add(jidNormalizedUser(lid))
    }
    if (isLidUser(jid)) {
      const pn = await getPnForLidFromAuthCache(phone, jid).catch(() => undefined)
      if (pn) candidates.add(jidNormalizedUser(pn))
    }
  }
  return Array.from(candidates)
}

export const getPrivacyTokenDebug = async (phone: string, rawTargets: string[] = []) => {
  const saltRaw = await getAuthRaw(`${phone}:tctoken-${NCT_SALT_KEY}`)
  const saltParsed = parseAuthValue(saltRaw)
  const authMembers = await getAuthIndexMembers(phone)
  const tokenKeyPrefix = tokenAuthKey(phone, '')
  const indexedTokenKeys = authMembers.filter((key) => `${key || ''}`.startsWith(tokenKeyPrefix))
  const targetJids = await expandCandidates(phone, rawTargets)
  const tokens = await Promise.all(targetJids.map((jid) => readTokenEntry(phone, jid)))

  return {
    phone,
    nct_salt: {
      key: tokenAuthKey(phone, NCT_SALT_KEY),
      exists: !!saltParsed?.nctSalt,
      bytes: byteLength(saltParsed?.nctSalt),
    },
    indexed_tctoken_keys: indexedTokenKeys.length,
    targets: tokens,
  }
}
