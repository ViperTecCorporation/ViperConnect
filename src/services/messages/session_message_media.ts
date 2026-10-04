import { downloadMediaMessage, proto } from 'zapo-js'
import { SendError } from '../send_error'
import { createZapoProxyOptions } from '../zapo/zapo_proxy'
import { SessionMessages } from './session_messages'
import { projectSessionMessage } from './session_message_projection'
import { unoIdKey } from '../redis'

const pending = new Map<string, Promise<{ file: string; mime_type: string; filename: string }>>()

export class SessionMessageMedia {
  constructor(private readonly messages: SessionMessages) {}
  async load(phone: string, id: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new SendError(400, 'invalid_message_id')
    const key = `${phone}:${id}`
    const existing = pending.get(key)
    if (existing) return existing
    const operation = this.prepare(phone, id)
    pending.set(key, operation)
    try { return await operation } finally { pending.delete(key) }
  }

  private async prepare(phone: string, id: string) {
    const index = await this.messages.index(phone)
    const record = (await index.records(phone, [id]))[0]
    if (!record) throw new SendError(404, 'message_not_found')
    const dto = projectSessionMessage(record)
    const state = await index.redis.get(index.key(phone, `state:${id}`))
    if (dto.type === 'view_once' || state && JSON.parse(state).type === 'revoked') throw new SendError(403, 'message_media_not_available')
    if (!dto.media || !record.messageBytes) throw new SendError(404, 'message_has_no_media')
    const config = await this.messages.loadConfig(phone)
    const { mediaStore, dataStore } = await config.getStore(phone, config)
    const mappedId = await index.redis.get(unoIdKey(phone, id)) || id
    const candidates = [...new Set([mappedId, id])]
    for (const mediaId of candidates) {
      const payload = await dataStore.loadMediaPayload(mediaId)
      if (!payload) continue
      const file = mediaStore.getFilePath(phone, mediaId, payload.mime_type || dto.media.mime_type, payload.filename)
      if (await mediaStore.hasMedia(file)) return { file, mime_type: payload.mime_type || dto.media.mime_type, filename: dto.media.filename }
    }
    const content = proto.Message.decode(record.messageBytes)
    const file = mediaStore.getFilePath(phone, id, dto.media.mime_type, dto.media.filename)
    if (!await mediaStore.hasMedia(file)) {
      const stream = await downloadMediaMessage(content, {
        maxBytes: 256 * 1024 * 1024, timeoutMs: 60000,
        proxy: createZapoProxyOptions(config.proxyUrl, undefined, { network: process.env.ZAPO_NETWORK_IP_FAMILY, mediaDownload: process.env.ZAPO_MEDIA_DOWNLOAD_IP_FAMILY })?.mediaDownload,
      })
      try { await mediaStore.saveMediaStream(file, stream, dto.media.mime_type, false) }
      catch (error) { await mediaStore.removeMedia(file).catch(() => undefined); throw error }
      finally { stream.destroy() }
    }
    return { file, mime_type: dto.media.mime_type, filename: dto.media.filename }
  }
}
