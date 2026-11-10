import { v4 as uuid } from 'uuid'
import {
  CONTACT_SYNC_ENABLED,
  CONTACT_SYNC_INTERVAL_MS,
  CONTACT_SYNC_SCAN_COUNT,
  CONTACT_SYNC_PENDING_POLL_MS,
  CONTACT_SYNC_PENDING_TTL_SEC,
} from '../defaults'
import logger from '../services/logger'
import { Outgoing } from '../services/outgoing'
import { BASE_KEY, delContactSyncPending, getRedis, getSessionPhones, redisGet, redisSetAndExpire, redisSetIfNotExists } from '../services/redis'
import { jidToPhoneNumber } from '../services/transformer'
import type { getConfig } from '../services/config'
import { readSessionLifecycleConfig, sessionLifecycleIdentity } from '../services/session_storage/lifecycle_transition'
import { sessionContacts } from '../services/session_storage/contacts_gateway'
import { SendError } from '../services/send_error'
import { assertSessionConfigRegistered } from '../services/session_storage/connection_registration'

export type ContactSyncItem = {
  wa_id: string
  profile: {
    name: string
    phone: string
    username?: string
  }
}

const CONTACT_SYNC_MESSAGE_BODY = 'contacts.update'
const CONTACT_SYNC_LOCK_KEY = `${BASE_KEY}contact-sync:lock`
const CONTACT_SYNC_LOCK_PREFIX = `${BASE_KEY}contact-sync:lock:`
const CONTACT_SYNC_LOCK_BUFFER_SEC = 60
const CONTACT_SYNC_PAGE_SIZE = 100
const CONTACT_SYNC_PENDING_PREFIX = `${BASE_KEY}contact-sync:pending:`
const CONTACT_SYNC_SCHEDULE_PREFIX = `${BASE_KEY}contact-sync:schedule:`
const CONTACT_SYNC_SCHEDULE_MIN_SEC = 4 * 60 * 60
const CONTACT_SYNC_SCHEDULE_MAX_SEC = 12 * 60 * 60

const getScheduleTtlSec = () =>
  Math.floor(CONTACT_SYNC_SCHEDULE_MIN_SEC +
    (Math.random() * (CONTACT_SYNC_SCHEDULE_MAX_SEC - CONTACT_SYNC_SCHEDULE_MIN_SEC + 1)))

const scheduleKeyForPhone = (phone: string) => `${CONTACT_SYNC_SCHEDULE_PREFIX}${phone}`

const normalizeDigits = (value?: string) => `${value || ''}`.replace(/\D/g, '')

export const buildContactSyncPayload = (phone: string, contacts: ContactSyncItem[]) => {
  const timestamp = `${Math.floor(Date.now() / 1000)}`
  const from = contacts.find((c) => c.wa_id !== phone)?.wa_id || contacts[0]?.wa_id || phone
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: phone,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: phone,
                phone_number_id: phone,
              },
              contacts,
              messages: [
                {
                  from,
                  id: uuid(),
                  timestamp,
                  text: { body: CONTACT_SYNC_MESSAGE_BODY },
                  type: 'text',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

const parseContactInfoKey = (key: string) => {
  const prefix = `${BASE_KEY}contact-info:`
  if (!key.startsWith(prefix)) return undefined
  const rest = key.substring(prefix.length)
  const sep = rest.indexOf(':')
  if (sep < 0) return undefined
  const phone = rest.substring(0, sep)
  const jid = rest.substring(sep + 1)
  return { phone, jid }
}

const normalizeUsername = (value?: string) => `${value || ''}`.trim().replace(/^@/, '').toLowerCase()

export const resolveContactFromInfo = (jid: string, info: any, usernameIndex: Record<string, string> = {}) => {
  if (jid === 'status@broadcast') return undefined
  if (jid.includes('@lid')) return undefined
  const name = `${info?.name || ''}`.trim()
  let pn = normalizeDigits(info?.pn)
  if (!pn) {
    const pnJid = `${info?.pnJid || ''}`
    if (pnJid.endsWith('@s.whatsapp.net')) {
      pn = normalizeDigits(jidToPhoneNumber(pnJid, ''))
    }
  }
  if (!pn) {
    if (jid.endsWith('@s.whatsapp.net')) {
      pn = normalizeDigits(jidToPhoneNumber(jid, ''))
    } else {
      pn = normalizeDigits(jid)
    }
  }
  if (!pn) return undefined
  const rawLid = `${info?.lidJid || (jid.endsWith('@lid') ? jid : '')}`.trim()
  const lid = rawLid.endsWith('@lid') ? `${rawLid.split('@')[0].split(':')[0]}@lid` : ''
  const username = normalizeUsername(info?.username || (lid ? usernameIndex[`lid:${lid}`] : '')) || undefined
  return { pn, name, username }
}

export class ContactSyncJob {
  private outgoing: Outgoing

  constructor(outgoing: Outgoing,
    private readonly readConfig: getConfig = phone => module.require('../services/config_redis').getConfigRedis(phone),
    private readonly listSessions = getSessionPhones,
    private readonly contactGateway = sessionContacts,
  ) {
    this.outgoing = outgoing
  }

  private async sendContacts(phone: string, contacts: ContactSyncItem[], expected: string): Promise<void> {
    for (let i = 0; i < contacts.length; i += CONTACT_SYNC_PAGE_SIZE) {
      const page = contacts.slice(i, i + CONTACT_SYNC_PAGE_SIZE)
      if (!page.length) continue
      await readSessionLifecycleConfig(phone, this.readConfig, expected)
      const payload = buildContactSyncPayload(phone, page)
      await this.outgoing.send(phone, payload)
      logger.info('CONTACT_SYNC sent: phone=%s contacts=%s', phone, page.length)
    }
  }

  private upsertContact(bucket: Map<string, ContactSyncItem>, jid: string, info: any, usernameIndex: Record<string, string> = {}) {
    const resolved = resolveContactFromInfo(jid, info, usernameIndex)
    if (!resolved) return
    const existing = bucket.get(resolved.pn)
    if (!existing) {
      bucket.set(resolved.pn, {
        wa_id: resolved.pn,
        profile: {
          name: resolved.name,
          phone: resolved.pn,
          ...(resolved.username ? { username: resolved.username } : {}),
        },
      })
    } else {
      if (resolved.name && !existing.profile.name) existing.profile.name = resolved.name
      if (resolved.username && !existing.profile.username) existing.profile.username = resolved.username
    }
  }

  private async loadContactsForPhone(phone: string, expected: string): Promise<Map<string, ContactSyncItem>> {
    const config = await readSessionLifecycleConfig(phone, this.readConfig, expected)
    if (config.sessionStorage?.backend === 'sqlite') {
      const bucket = new Map<string, ContactSyncItem>(), contacts = this.contactGateway(phone, config)
      let cursor: string | undefined
      const visited = new Set<string>()
      do {
        await readSessionLifecycleConfig(phone, this.readConfig, expected)
        const page = await contacts.syncPage({ ...(cursor ? { cursor } : {}), limit: CONTACT_SYNC_PAGE_SIZE })
        if (!page || !Array.isArray(page.contacts) || page.contacts.length > 200) throw new SendError(503, 'session_storage_contact_sync_page_invalid')
        for (const row of page.contacts) this.upsertContact(bucket, row.jid, { pn: row.pn, name: row.name, username: row.username })
        if (!page.has_more) break
        if (!page.next_cursor || visited.has(page.next_cursor)) throw new SendError(503, 'session_storage_contact_sync_page_invalid')
        visited.add(page.next_cursor); cursor = page.next_cursor
      } while (true)
      return bucket
    }
    const redis: any = await getRedis()
    const bucket = new Map<string, ContactSyncItem>()
    const usernameIndex: Record<string, string> = await redis
      .hGetAll(`${BASE_KEY}zapo-username-lid:${phone}`)
      .catch(() => ({}))
    const pattern = `${BASE_KEY}contact-info:${phone}:*`
    const count = Math.max(10, CONTACT_SYNC_SCAN_COUNT || 500)
    let cursor = '0'
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await redis.scan(cursor, { MATCH: pattern, COUNT: count })
      cursor = (typeof res.cursor !== 'undefined') ? `${res.cursor}` : `${res[0]}`
      const keys: string[] = Array.isArray(res.keys) ? res.keys : (res[1] || [])
      if (!keys.length) continue
      const values = await redis.mGet(keys)
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]
        const raw = values?.[i]
        if (!raw) continue
        const parsed = parseContactInfoKey(key)
        if (!parsed || parsed.phone !== phone) continue
        let info: any
        try { info = JSON.parse(raw) } catch { continue }
        this.upsertContact(bucket, parsed.jid, info, usernameIndex)
      }
    } while (cursor !== '0')
    return bucket
  }

  public async runForPhone(phone: string): Promise<boolean> {
    if (!CONTACT_SYNC_ENABLED || CONTACT_SYNC_INTERVAL_MS <= 0) return false    
    if (!process.env.REDIS_URL) return false
    const config = await readSessionLifecycleConfig(phone, this.readConfig)
    assertSessionConfigRegistered(config)
    const expected = sessionLifecycleIdentity(config)
    try {
      const scheduled = await redisGet(scheduleKeyForPhone(phone))
      if (scheduled) {
        logger.debug('CONTACT_SYNC skip: schedule active for %s', phone)
        return false
      }
    } catch {}
    const lockTtlSec = Math.max(60, CONTACT_SYNC_PENDING_TTL_SEC)
    const lockKey = `${CONTACT_SYNC_LOCK_PREFIX}${phone}`
    const acquired = await redisSetIfNotExists(lockKey, `${Date.now()}`, lockTtlSec)
    if (!acquired) {
      logger.debug('CONTACT_SYNC skip: lock is held for %s', phone)
      return false
    }
    const bucket = await this.loadContactsForPhone(phone, expected)
    const contacts = Array.from(bucket.values())
    if (!contacts.length) return false
    await this.sendContacts(phone, contacts, expected)
    try { await redisSetAndExpire(scheduleKeyForPhone(phone), `${Date.now()}`, getScheduleTtlSec()) } catch {}
    return true
  }

  public async run(): Promise<void> {
    if (!CONTACT_SYNC_ENABLED || CONTACT_SYNC_INTERVAL_MS <= 0) return
    if (!process.env.REDIS_URL) return
    const lockTtlSec = Math.max(60, Math.ceil(CONTACT_SYNC_INTERVAL_MS / 1000) - CONTACT_SYNC_LOCK_BUFFER_SEC)
    const acquired = await redisSetIfNotExists(CONTACT_SYNC_LOCK_KEY, `${Date.now()}`, lockTtlSec)
    if (!acquired) {
      logger.debug('CONTACT_SYNC skip: lock is held')
      return
    }
    for (const phone of await this.listSessions()) {
      try { await this.runForPhone(phone) }
      catch (error) { logger.warn({ phone, code: (error as any)?.title || (error as any)?.code || 'contact_sync_failed' }, 'CONTACT_SYNC session skipped') }
    }
  }

  public async runPending(): Promise<void> {
    if (!CONTACT_SYNC_ENABLED || CONTACT_SYNC_INTERVAL_MS <= 0) return
    if (!process.env.REDIS_URL) return
    const redis: any = await getRedis()
    const pattern = `${CONTACT_SYNC_PENDING_PREFIX}*`
    const count = Math.max(10, CONTACT_SYNC_SCAN_COUNT || 500)
    let cursor = '0'
    const phones = new Set<string>()
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await redis.scan(cursor, { MATCH: pattern, COUNT: count })
      cursor = (typeof res.cursor !== 'undefined') ? `${res.cursor}` : `${res[0]}`
      const keys: string[] = Array.isArray(res.keys) ? res.keys : (res[1] || [])
      for (const key of keys || []) {
        if (!key.startsWith(CONTACT_SYNC_PENDING_PREFIX)) continue
        const phone = key.substring(CONTACT_SYNC_PENDING_PREFIX.length)
        if (phone) phones.add(phone)
      }
    } while (cursor !== '0')
    for (const phone of phones) {
      const processed = await this.runForPhone(phone)
      if (processed) {
        await delContactSyncPending(phone)
      }
    }
  }
}

export const startContactSyncScheduler = (outgoing: Outgoing) => {
  if (!CONTACT_SYNC_ENABLED || CONTACT_SYNC_INTERVAL_MS <= 0) {
    logger.info('CONTACT_SYNC disabled')
    return
  }
  if (!process.env.REDIS_URL) {
    logger.info('CONTACT_SYNC skipped: REDIS_URL not set')
    return
  }
  const job = new ContactSyncJob(outgoing)
  let running = false
  let pendingRunning = false
  const runSafe = async () => {
    if (running) return
    running = true
    try {
      await job.run()
    } catch (error) {
      logger.warn(error as any, 'CONTACT_SYNC run failed')
    } finally {
      running = false
    }
  }
  const runPendingSafe = async () => {
    if (pendingRunning) return
    pendingRunning = true
    try {
      await job.runPending()
    } catch (error) {
      logger.warn(error as any, 'CONTACT_SYNC pending run failed')
    } finally {
      pendingRunning = false
    }
  }
  void runSafe()
  void runPendingSafe()
  const syncTimer = setInterval(() => void runSafe(), CONTACT_SYNC_INTERVAL_MS)
  const pendingTimer = setInterval(() => void runPendingSafe(), CONTACT_SYNC_PENDING_POLL_MS)
  syncTimer.unref?.()
  pendingTimer.unref?.()
}
