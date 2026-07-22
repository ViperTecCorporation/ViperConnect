import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import type { getConfig } from '../config'
import { getRedis } from '../redis'
import { SendError } from '../send_error'
import type { ContactDirectory, ContactDirectoryItem, ContactDirectoryPage, ContactDirectoryQuery } from '../contacts/contact_directory_types'

type RedisClient = Awaited<ReturnType<typeof getRedis>>
type RedisFactory = () => Promise<RedisClient>
type StoredContact = Record<string, string>

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

export const normalizeContactPhoneNumber = (value?: string): string | undefined => {
  const digits = `${value || ''}`.split('@')[0].split(':')[0].replace(/\D/g, '')
  if (!digits) return undefined
  if (!digits.startsWith('55') || digits.length !== 12) return digits

  const localNumber = digits.slice(4)
  const isMobile = /^[6-9]/.test(localNumber)
  return isMobile ? `${digits.slice(0, 4)}9${localNumber}` : digits
}

export const mapStoredZapoContact = (contact: StoredContact): ContactDirectoryItem | undefined => {
  const userId = `${contact.lid || contact.jid || ''}`.trim()
  if (!userId.endsWith('@lid')) return undefined

  return {
    user_id: userId,
    phone_number: normalizeContactPhoneNumber(contact.phone_number),
    display_name: `${contact.display_name || ''}`.trim() || undefined,
    push_name: `${contact.push_name || ''}`.trim() || undefined,
    last_updated_ms: Number(contact.last_updated_ms) || 0,
  }
}

const escapeRedisGlob = (value: string) => value.replace(/([*?\[\]\\])/g, '\\$1')

export class ZapoContactDirectory implements ContactDirectory {
  constructor(
    private readonly loadConfig: getConfig,
    private readonly redisFactory: RedisFactory = getRedis,
    private readonly prefix = ZAPO_REDIS_KEY_PREFIX,
  ) {}

  async list(phone: string, query: ContactDirectoryQuery = {}): Promise<ContactDirectoryPage> {
    const config = await this.loadConfig(phone)
    if (config.provider !== 'zapo') throw new SendError(409, 'contact_directory_requires_zapo_provider')

    const cursor = /^\d+$/.test(`${query.cursor || '0'}`) ? `${query.cursor || '0'}` : '0'
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit || DEFAULT_LIMIT)))
    const redis = await this.redisFactory()
    const result = await redis.scan(cursor, {
      MATCH: `${this.prefix}contact:${escapeRedisGlob(phone)}:*`,
      COUNT: limit,
    })
    const stored = await Promise.all((result.keys || []).map((key) => redis.hGetAll(key)))
    const contacts = stored
      .map(mapStoredZapoContact)
      .filter((contact): contact is ContactDirectoryItem => !!contact)
      .sort((left, right) => right.last_updated_ms - left.last_updated_ms)
    const nextCursor = `${result.cursor}`

    return {
      contacts,
      next_cursor: nextCursor,
      has_more: nextCursor !== '0',
    }
  }
}
