import type { Config } from '../config'
import { zapoStoreRegistry } from '../zapo/zapo_store_registry'
import { sessionStorageRpc } from './rpc'
import { assertLocalStorageOwner, isSqliteSession, isStorageWorker, storageOwner } from './routing'
import { SendError } from '../send_error'
import type { ContactSyncPage } from './contact_sync_query'

export type SessionContact = { jid?: string; lid?: string; phoneNumber?: string; displayName?: string; pushName?: string; username?: string; lastUpdatedMs?: number }
const identity = (value: unknown) => typeof value === 'string' && /^\d+(?::\d+)?@(?:lid|s\.whatsapp\.net)$/.test(value) ? value.replace(/:\d+(?=@)/, '') : undefined
const limited = (value: unknown, maximum = 200) => typeof value === 'string' ? value.slice(0, maximum) : undefined

/** Never return the SDK object itself: only public, session-scoped contact fields cross RPC. */
export function publicSessionContact(value: any): SessionContact | null {
  if (!value || typeof value !== 'object') return null
  const jid = identity(value.jid), lid = identity(value.lid)
  const phoneNumber = typeof value.phoneNumber === 'string' && /^\d{7,15}(?:@s\.whatsapp\.net)?$/.test(value.phoneNumber) ? value.phoneNumber : undefined
  if (!jid && !lid && !phoneNumber) return null
  return { ...(jid ? { jid } : {}), ...(lid?.endsWith('@lid') ? { lid } : {}), ...(phoneNumber ? { phoneNumber } : {}),
    ...(typeof value.displayName === 'string' ? { displayName: limited(value.displayName) } : {}),
    ...(typeof value.pushName === 'string' ? { pushName: limited(value.pushName) } : {}),
    ...(typeof value.username === 'string' ? { username: limited(value.username, 64) } : {}),
    ...(typeof value.lastUpdatedMs === 'number' && Number.isFinite(value.lastUpdatedMs) ? { lastUpdatedMs: value.lastUpdatedMs } : {}) }
}

const lookupIdentity = (value: string) => {
  const jid = identity(value)
  if (jid) return jid
  if (/^\d{7,15}$/.test(value)) return `${value}@s.whatsapp.net`
  throw new SendError(400, 'session_storage_contact_identity_invalid')
}

/** Worker-side handler for query.contact. No network contact lookup and no alias guessing. */
export async function queryLocalSessionContact(phone: string, config: Config, input: string): Promise<SessionContact | null> {
  assertLocalStorageOwner(config)
  const jid = lookupIdentity(input), contacts = zapoStoreRegistry.get(config, phone).session(phone).contacts
  const contact = jid.endsWith('@lid') ? await contacts.getByJid(jid)
    : await contacts.getByPhoneNumber(jid.replace(/@s\.whatsapp\.net$/, '')) || await contacts.getByPhoneNumber(jid)
  return publicSessionContact(contact)
}

/** The broker and HTTP process must not instantiate a worker-local SQLite store. */
export function sessionContacts(phone: string, config: Config, rpc: typeof sessionStorageRpc = sessionStorageRpc) {
  const read = async (value: string) => {
    const jid = lookupIdentity(value)
    if (isSqliteSession(config) && (!isStorageWorker() || config.sessionStorage!.owner !== storageOwner())) {
      return publicSessionContact(await rpc<SessionContact | null>(phone, config, 'query.contact', [jid]))
    }
    return queryLocalSessionContact(phone, config, jid)
  }
  const syncPage = async (query: { cursor?: string; limit?: number } = {}): Promise<ContactSyncPage> => {
    if (!isSqliteSession(config)) throw new SendError(409, 'session_storage_contact_sync_requires_sqlite')
    if (!isStorageWorker() || config.sessionStorage!.owner !== storageOwner()) {
      return rpc<ContactSyncPage>(phone, config, 'query.contact-sync', [query])
    }
    return (await import('./contact_sync_query.js')).queryLocalContactSyncPage(phone, config, query)
  }
  return { getByJid: read, getByPhoneNumber: read, syncPage }
}
