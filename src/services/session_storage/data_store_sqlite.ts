import { proto } from 'zapo-js/proto'
import type { Config } from '../config'
import type { DataStore, MessageStatus } from '../data_store'
import type { WhatsAppMessage, WhatsAppMessageKey } from '../whatsapp_types'
import { createProviderDataStoreBase } from '../data_store_base'
import { DATA_TTL, DATA_URL_TTL, CONTACT_INFO_TTL_SEC, JIDMAP_TTL_SECONDS } from '../../defaults'
import { normalizeWhatsAppJid, isLidUser, isPnUser } from '../whatsapp_jid'
import { profilePictureCacheIds } from '../profile_picture_cache'
import { mergeGroupMetadataForCache } from '../groups/group_metadata_cache'
import { messageRetentionMs, messageTimestampMs } from '../messages/message_retention'
import { openSessionDatabase, type SqliteSessionConfig } from './database'
import { associatedMessageDeadline, extendNewMessageMappings } from './sqlite_mapping_retention'
import { setSqliteRetainedMessageStatus } from './message_status'
import { assertFreshSqliteWriteSelection, assertCurrentSqliteWriteSelection } from './write_fence'

const ttl = (seconds: number) => seconds > 0 ? Date.now() + seconds * 1000 : null
const unsupportedSnapshot = () => { throw new Error('session_storage_use_streaming_backup') }
const exactJid = (jid: string) => jid.includes('@') ? normalizeWhatsAppJid(jid) : `${jid.replace(/\D/g, '')}@s.whatsapp.net`

export function decodeSqliteMessage(value: Buffer | string): proto.IWebMessageInfo {
  const raw = Buffer.isBuffer(value) ? value.toString() : value
  if (raw.trim().startsWith('{')) return JSON.parse(raw, (_key, value) => value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value) as proto.IWebMessageInfo
  return proto.WebMessageInfo.decode(Buffer.from(raw, 'base64'))
}

/** Redis-compatible values live in their own namespace beside the official SDK tables. */
export async function getDataStoreSqlite(phone: string, config: Config & SqliteSessionConfig): Promise<DataStore> {
  openSessionDatabase(phone, config)
  const db = () => openSessionDatabase(phone, config)
  const key = (kind: string, suffix = '') => `unoapi-${kind}:${phone}${suffix ? `:${suffix}` : ''}`
  const text = (k: string): string | undefined => db().getValue(k)?.toString()
  const json = <T = any>(k: string): T | undefined => { const raw = text(k); return raw === undefined ? undefined : JSON.parse(raw) as T }
  const write = (k: string, value: unknown, expiresAt: number | null, jsonValue = true, keep = false) => db().putValue(k, jsonValue ? JSON.stringify(value) : `${value}`, { expiresAt, encoding: jsonValue ? 'json' : 'string', keepEarlierExpiry: keep })
  const aliases = (id: string) => [...new Set([id, text(key('id_rev', id)), text(key('id', id))].filter((value): value is string => !!value))]
  const scope = (session: string) => { if (session !== phone) throw new Error('session_storage_scope_mismatch') }
  const store = createProviderDataStoreBase()
  store.type = 'sqlite'
  store.writeToFile = unsupportedSnapshot; store.readFromFile = unsupportedSnapshot
  store.toJSON = unsupportedSnapshot; store.fromJSON = unsupportedSnapshot
  store.loadKey = async id => { for (const alias of aliases(id)) { const value = json<WhatsAppMessageKey>(key('key', alias)); if (value) return value } return undefined }
  store.setKey = async (id, value) => { write(key('key', id), value, ttl(DATA_TTL), true, true) }
  store.loadUnoId = async id => text(key('id', id))
  store.loadProviderId = async id => text(key('id_rev', id))
  store.setUnoId = async (provider, proposed) => db().transaction(() => {
    if (!provider || !proposed) throw new Error('session_storage_message_id_required')
    const forward = key('id', provider), existing = text(forward)
    const chosen = existing && existing !== provider ? existing : proposed
    const reverse = key('id_rev', chosen), previousProvider = text(reverse)
    if (previousProvider && previousProvider !== provider) throw new Error('session_storage_message_id_conflict')
    const oldDeadline = db().get('SELECT expires_at FROM uno_kv WHERE key=?', [forward])?.expires_at
    const deadline = typeof oldDeadline === 'number' && oldDeadline > Date.now() ? oldDeadline : ttl(DATA_TTL)
    write(forward, chosen, deadline, false, true)
    write(reverse, provider, deadline, false, true)
    const messageDeadline = associatedMessageDeadline(db(), phone, [provider, chosen])
    if (messageDeadline !== undefined) extendNewMessageMappings(db(), phone, provider, messageDeadline)
    return chosen
  })
  store.setMessage = async (jid: string, message: WhatsAppMessage) => {
    const id = message.key?.id
    if (!id) throw new Error('session_storage_message_id_required')
    const conversation = exactJid(jid), k = key('message', `${conversation}:${id}`)
    // Encode losslessly or fail; never replace unsupported/corrupt media with text.
    const encoded = Buffer.from(proto.WebMessageInfo.encode(message as proto.IWebMessageInfo).finish()).toString('base64')
    db().transaction(() => {
      const previous = text(k), old = previous ? decodeSqliteMessage(previous) : undefined
      if (old?.key && (Boolean(old.key.fromMe) !== Boolean(message.key.fromMe) || (old.key.participant || '') !== (message.key.participant || ''))) throw new Error('session_storage_message_author_conflict')
      const now = Date.now(), stamp = Math.min(messageTimestampMs(message.messageTimestamp, true) ?? now, messageTimestampMs(old?.messageTimestamp, true) ?? now, now)
      db().putValue(k, encoded, { encoding: 'protobuf-base64', expiresAt: stamp + messageRetentionMs(DATA_TTL * 1000), keepEarlierExpiry: true })
      const expiration = db().get('SELECT expires_at FROM uno_kv WHERE key=?', [k])?.expires_at
      if (typeof expiration === 'number') extendNewMessageMappings(db(), phone, id, expiration)
    })
  }
  store.loadMessageExact = async (jid, id) => {
    for (const alias of aliases(id)) { const raw = text(key('message', `${exactJid(jid)}:${alias}`)); if (raw) return decodeSqliteMessage(raw) }
    return undefined
  }
  store.loadMessage = store.loadMessageExact
  store.findMessageWithSecret = async (id, jids) => {
    let fallback: proto.IWebMessageInfo | undefined
    for (const jid of [...new Set(jids)]) { const message = await store.loadMessageExact!(jid, id); if (message?.message?.messageContextInfo?.messageSecret) return message; if (message && !fallback) fallback = message }
    return fallback
  }
  store.setMediaPayload = async (id, value) => { write(key('media', id), value, ttl(DATA_TTL)) }
  store.loadMediaPayload = async id => json(key('media', id))
  store.setImageUrl = async (jid, url) => { const [cacheId] = profilePictureCacheIds(jid); if (cacheId) write(key('profile-picture', cacheId), url, ttl(DATA_URL_TTL), false) }
  store.getImageUrl = async jid => {
    const mapped = isLidUser(jid) ? await store.getPnForLid!(phone, jid) : await store.getLidForPn!(phone, jid)
    for (const alias of [jid, mapped].filter((value): value is string => !!value)) for (const cacheId of profilePictureCacheIds(alias)) { const value = text(key('profile-picture', cacheId)); if (value) return value }
    return undefined
  }
  store.removeImageUrl = async jid => {
    const mapped = isLidUser(jid) ? await store.getPnForLid!(phone, jid) : await store.getLidForPn!(phone, jid)
    for (const alias of [jid, mapped].filter((value): value is string => !!value)) for (const cacheId of profilePictureCacheIds(alias)) db().deleteValue(key('profile-picture', cacheId))
  }
  store.loadImageUrl = async (jid, socket) => { const cached = await store.getImageUrl(jid); if (cached) return cached; const url = await socket.profilePictureUrl?.(jid, 'image'); if (url) await store.setImageUrl(jid, url); return url }
  store.getGroupMetada = async jid => json(key('group', jid))
  store.setGroupMetada = async (jid, value) => { write(key('group', jid), mergeGroupMetadataForCache(await store.getGroupMetada(jid), value), ttl(DATA_TTL)) }
  store.loadGroupMetada = async (jid, socket) => { const cached = await store.getGroupMetada(jid); if (cached) return cached; const result = await socket.groupMetadata?.(jid); if (result) await store.setGroupMetada(jid, result); return result }
  store.getJid = async jid => text(key('jid', jid))
  store.setJid = async (jid, value) => { write(key('jid', jid), value, null, false) }
  store.setJidIfNotFound = async (jid, value) => { db().putValue(key('jid', jid), value, { nx: true }) }
  store.loadJid = async (jid, socket) => { const cached = await store.getJid(jid); if (cached) return cached; if (isLidUser(jid)) return normalizeWhatsAppJid(jid); const result = await socket.onWhatsApp?.(jid); const resolved = result?.[0]?.exists ? result[0].jid : undefined; if (resolved) await store.setJid(jid, resolved); return resolved }
  store.getContactName = async jid => json<any>(key('contact-info', jid))?.name || text(key('contact-name', jid))
  store.setContactName = async (jid, name) => { write(key('contact-name', jid), name, null, false) }
  store.getContactInfo = async jid => json(key('contact-info', jid))
  store.setContactInfo = async (jid, info) => {
    const normalized = exactJid(jid), merged = { ...info }
    const pn = info.pnJid || (isPnUser(normalized) ? normalized : await store.getPnForLid!(phone, normalized))
    const lid = info.lidJid || (isLidUser(normalized) ? normalized : await store.getLidForPn!(phone, normalized))
    if (pn) { merged.pnJid = pn; merged.pn = pn.split('@')[0] }
    if (lid) merged.lidJid = lid
    for (const alias of new Set([jid, pn, lid].filter((value): value is string => !!value))) write(key('contact-info', alias), merged, ttl(CONTACT_INFO_TTL_SEC))
  }
  store.getLastIncomingKey = async jid => json(key('last-incoming', jid))
  store.setLastIncomingKey = async (jid, value) => { write(key('last-incoming', jid), value, ttl(DATA_TTL)) }
  store.getPnForLid = async (session, lid) => { scope(session); return text(key('jidmap', `pn_for_lid:${normalizeWhatsAppJid(lid)}`)) || text(key('jidmap', `pn:${normalizeWhatsAppJid(lid)}`)) }
  store.getLidForPn = async (session, pn) => { scope(session); return text(key('jidmap', `lid_for_pn:${exactJid(pn)}`)) || text(key('jidmap', `lid:${exactJid(pn)}`)) }
  store.setJidMapping = async (session, pn, lid) => {
    scope(session); pn = exactJid(pn); lid = normalizeWhatsAppJid(lid)
    if (!isPnUser(pn) || !isLidUser(lid)) throw new Error('session_storage_invalid_jid_mapping')
    db().transaction(() => { write(key('jidmap', `pn_for_lid:${lid}`), pn, ttl(JIDMAP_TTL_SECONDS), false); write(key('jidmap', `lid_for_pn:${pn}`), lid, ttl(JIDMAP_TTL_SECONDS), false) })
  }
  store.removeJidMapping = async (session, pn, lid) => { scope(session); pn = exactJid(pn); lid = normalizeWhatsAppJid(lid); db().transaction(() => { for (const suffix of [`pn_for_lid:${lid}`, `pn:${lid}`]) if (text(key('jidmap', suffix)) === pn) db().deleteValue(key('jidmap', suffix)); for (const suffix of [`lid_for_pn:${pn}`, `lid:${pn}`]) if (text(key('jidmap', suffix)) === lid) db().deleteValue(key('jidmap', suffix)) }) }
  store.setStatus = async (id: string, status: MessageStatus) => {
    await assertFreshSqliteWriteSelection(phone, config)
    assertCurrentSqliteWriteSelection(phone, config)
    setSqliteRetainedMessageStatus(db(), phone, id, status)
  }
  store.loadStatus = async id => { for (const alias of aliases(id)) { const value = text(key('message-status', alias)); if (value) return value } return undefined }
  // Credentials and global control-plane state are managed by the lifecycle service.
  // Neither a transport disconnect nor deregister is allowed to unlink this file.
  store.cleanSession = async () => undefined
  store.setTemplates = async templates => { write(key('template'), templates, null) }
  store.loadTemplates = async () => json<object[]>(key('template')) || [{ id: 1, name: 'hello', status: 'APPROVED', category: 'UTILITY', components: [{ text: '{{hello}}', type: 'BODY', parameters: [{ type: 'text', text: 'hello' }] }] }]
  return store
}
