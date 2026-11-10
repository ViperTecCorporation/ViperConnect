import { downloadMediaMessage, proto } from 'zapo-js'
import { SendError } from '../send_error'
import { createZapoProxyOptions } from '../zapo/zapo_proxy'
import { SessionMessages } from './session_messages'
import { projectSessionMessage } from './session_message_projection'
import { unoIdKey, providerIdKey } from '../redis'
import { isSqliteSession } from '../session_storage/routing'
import { sessionStorageRpc } from '../session_storage/rpc'
import { readSessionLifecycleConfig, sessionLifecycleIdentity } from '../session_storage/lifecycle_transition'
import type { SessionMessageIndex } from './session_message_index'

const pending = new Map<string, Promise<{ file: string; mime_type: string; filename: string }>>()

export class SessionMessageMedia {
  constructor(private readonly messages: SessionMessages) {}
  async load(phone: string, id: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new SendError(400, 'invalid_message_id')
    // Recheck policy before sharing an in-flight result, including after a
    // backend/generation change or enabling the synthetic-runtime barrier.
    const config = await readSessionLifecycleConfig(phone, this.messages.loadConfig)
    const expected = sessionLifecycleIdentity(config)
    if (isSqliteSession(config)) {
      return this.shared(`${phone}:${expected}:${id}`, () => sessionStorageRpc<{ file: string; mime_type: string; filename: string }>(phone, config, 'query.media', [id]))
    }
    const index = await this.messages.index(phone)
    const providerId = await index.redis.get(providerIdKey(phone, id)) || id
    const unoId = await index.redis.get(unoIdKey(phone, providerId))
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerId)
      || providerId !== id && unoId !== id
      || unoId && (!/^[A-Za-z0-9_-]{1,200}$/.test(unoId) || await index.redis.get(providerIdKey(phone, unoId)) !== providerId)) {
      throw new SendError(503, 'session_storage_media_id_mapping_invalid')
    }
    await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
    const aliases = [...new Set([unoId, providerId, id].filter((value): value is string => !!value))]
    return this.shared(`${phone}:${expected}:${providerId}`, () => this.prepareRedis(phone, providerId, aliases, index, expected))
  }

  private async shared(key: string, prepare: () => Promise<{ file: string; mime_type: string; filename: string }>) {
    const existing = pending.get(key)
    if (existing) return existing
    const operation = prepare()
    pending.set(key, operation)
    try { return await operation } finally { pending.delete(key) }
  }

  private async prepareRedis(phone: string, id: string, aliases: string[], index: SessionMessageIndex, expected: string) {
    const record = (await index.records(phone, [id]))[0]
    if (!record) throw new SendError(404, 'message_not_found')
    const dto = projectSessionMessage(record)
    for (const alias of aliases) {
      const state = await index.redis.get(index.key(phone, `state:${alias}`))
      if (dto.type === 'view_once' || state && JSON.parse(state).type === 'revoked') throw new SendError(403, 'message_media_not_available')
    }
    if (!dto.media || !record.messageBytes) throw new SendError(404, 'message_has_no_media')
    const config = await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
    const { mediaStore, dataStore } = await config.getStore(phone, config)
    await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
    for (const mediaId of aliases) {
      const payload = await dataStore.loadMediaPayload(mediaId)
      if (!payload) continue
      const file = mediaStore.getFilePath(phone, mediaId, payload.mime_type || dto.media.mime_type, payload.filename)
      if (await mediaStore.hasMedia(file)) {
        await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
        return { file, mime_type: payload.mime_type || dto.media.mime_type, filename: dto.media.filename }
      }
    }
    const content = proto.Message.decode(record.messageBytes)
    const file = mediaStore.getFilePath(phone, id, dto.media.mime_type, dto.media.filename)
    if (!await mediaStore.hasMedia(file)) {
      await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
      const stream = await downloadMediaMessage(content, {
        maxBytes: 256 * 1024 * 1024, timeoutMs: 60000,
        proxy: createZapoProxyOptions(config.proxyUrl, undefined, { network: process.env.ZAPO_NETWORK_IP_FAMILY, mediaDownload: process.env.ZAPO_MEDIA_DOWNLOAD_IP_FAMILY })?.mediaDownload,
      })
      let saving = false
      try {
        await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
        saving = true
        if (await mediaStore.saveMediaStream(file, stream, dto.media.mime_type, false) !== true) throw new SendError(503, 'session_storage_media_save_failed')
      }
      catch (error) { if (saving) await mediaStore.removeMedia(file).catch(() => undefined); throw error }
      finally { stream.destroy() }
    }
    await readSessionLifecycleConfig(phone, this.messages.loadConfig, expected)
    return { file, mime_type: dto.media.mime_type, filename: dto.media.filename }
  }
}
