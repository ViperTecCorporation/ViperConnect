import type { SessionDatabase } from './database'
import type { MessageStatus } from '../data_store'
import { DATA_TTL } from '../../defaults'
import { messageRetentionMs } from '../messages/message_retention'
import { SessionStorageError } from './types'
import { normalizeWhatsAppJid } from '../whatsapp_jid'

const statuses = new Set(['scheduled', 'pending', 'without-whatsapp', 'invalid-phone-number', 'error', 'failed', 'sent', 'delivered', 'read', 'played', 'accepted', 'deleted'])

/** Same aliases and absolute deadlines for DataStore, bulk and owner RPC writes. */
export function setSqliteRetainedMessageStatus(db: SessionDatabase, phone: string, id: string, status: MessageStatus) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || !statuses.has(status)) throw new SessionStorageError(400, 'session_storage_message_status_invalid')
  const key = (kind: string, value: string) => `unoapi-${kind}:${phone}:${value}`
  const read = (kind: string, value: string) => db.getValue(key(kind, value))?.toString()
  db.transaction(() => {
    let deadline = Date.now() + messageRetentionMs(DATA_TTL * 1000)
    const aliases = [...new Set([id, read('id_rev', id), read('id', id)].filter((value): value is string => !!value))]
    for (const alias of aliases) {
      const oldExpiry = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [key('message-status', alias)])?.expires_at
      if (typeof oldExpiry === 'number') deadline = Math.min(deadline, oldExpiry)
      const raw = read('key', alias), metadata = raw ? JSON.parse(raw) : undefined
      if (metadata?.remoteJid) {
        const jid = metadata.remoteJid.includes('@') ? normalizeWhatsAppJid(metadata.remoteJid) : `${metadata.remoteJid.replace(/\D/g, '')}@s.whatsapp.net`
        for (const messageId of new Set([alias, metadata.id].filter(Boolean))) {
          const expiry = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [key('message', `${jid}:${messageId}`)])?.expires_at
          if (typeof expiry === 'number') deadline = Math.min(deadline, expiry)
        }
      }
    }
    db.putValue(key('message-status', id), status, { expiresAt: deadline, encoding: 'string', keepEarlierExpiry: true })
  })
}
