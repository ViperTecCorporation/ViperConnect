import type { Store } from '../store'
import type { ZapoMessageMetadataResolver } from '../zapo/zapo_message_metadata'
import { getBinMessage, normalizeMessageContent } from '../transformer/message_type'
import { jidToPhoneNumber, normalizeLidJid } from '../transformer/jid'
import { BASE_URL } from '../../defaults'
import logger from '../logger'
import { isEncryptedWhatsAppMediaUrl } from './interactive_media'

/** Recover only media quoted from this session's own status, never send a WA message. */
export class StatusReplyMedia {
  private readonly pending = new Map<string, Promise<any>>()

  async resolve(phone: string, message: any, store: Store, metadata: ZapoMessageMetadataResolver,
    lookupParticipant?: (lid: string) => Promise<string | undefined>) {
    const context = getBinMessage(message)?.message?.contextInfo
    if (message?.key?.fromMe || context?.remoteJid !== 'status@broadcast' || !context.stanzaId) return
    const participant = `${context.participant || ''}`.trim()
    let participantPhone = participant
    if (participant.endsWith('@lid')) {
      try {
        // Only the native contact record of this session may establish LID ownership.
        participantPhone = await lookupParticipant?.(normalizeLidJid(participant) || participant) || ''
      } catch {
        logger.warn('STATUS_REPLY_MEDIA identity unavailable phone=%s id=%s', phone, context.stanzaId)
        return { id: context.stanzaId, available: false }
      }
    }
    if (!/^\+?\d+(?:@s\.whatsapp\.net)?$/.test(participantPhone) || jidToPhoneNumber(participantPhone, '') !== jidToPhoneNumber(phone, '')) return
    const key = `${phone}:${context.stanzaId}`
    let operation = this.pending.get(key)
    if (!operation) {
      operation = this.prepare(phone, message, context, store, metadata)
      this.pending.set(key, operation)
    }
    try { return await operation }
    catch {
      // No raw errors: CDN URLs and media keys must not leak into logs.
      logger.warn('STATUS_REPLY_MEDIA unavailable phone=%s id=%s', phone, context.stanzaId)
      return { id: context.stanzaId, available: false }
    } finally { this.pending.delete(key) }
  }

  private async prepare(phone: string, reply: any, context: any, store: Store, metadata: ZapoMessageMetadataResolver) {
    const id = await store.dataStore.loadProviderId(context.stanzaId) || context.stanzaId
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return { id: context.stanzaId, available: false }
    let quoted = context.quotedMessage
    if (!quoted || !Object.keys(quoted).length) {
      const original = await store.dataStore.loadMessage('status@broadcast', id)
      quoted = original?.message
    }
    // Do not unwrap view-once or ephemeral media to recover a protected quote.
    if (quoted?.viewOnceMessage || quoted?.viewOnceMessageV2 || quoted?.viewOnceMessageV2Extension || quoted?.ephemeralMessage) return { id, available: false }
    const content = normalizeMessageContent(quoted)
    const type = ['imageMessage', 'videoMessage'].find(property => content?.[property])
    const media = type && content?.[type]
    if (!type || !media || media.viewOnce) return { id, available: false }
    let saved: any = await store.mediaStore.getMedia(BASE_URL, id)
    if (saved?.url && isEncryptedWhatsAppMediaUrl(saved.url)) saved = undefined
    if (!saved?.url) {
      const synthetic: any = await metadata.resolve(phone, {
        key: { id, remoteJid: 'status@broadcast', fromMe: true },
        message: { [type]: { ...media } }, messageTimestamp: reply.messageTimestamp,
      })
      if (!synthetic.__unoapiMediaBytes?.length) throw new Error('status_media_bytes_unavailable')
      if (!store.mediaStore.saveDownloadedMedia) throw new Error('status_media_storage_unavailable')
      await store.mediaStore.saveDownloadedMedia(synthetic, Buffer.from(synthetic.__unoapiMediaBytes))
      saved = await store.mediaStore.getMedia(BASE_URL, id)
    }
    if (!saved?.url || isEncryptedWhatsAppMediaUrl(saved.url)) throw new Error('status_media_storage_unavailable')
    return { id, type, available: true, caption: media.caption || '',
      media: { url: saved.url, mime_type: saved.mime_type, file_name: saved.filename } }
  }
}
