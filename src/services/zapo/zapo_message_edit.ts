import { proto, type WaMessageKey, type WaSendMessageContent, type WaStoreSession } from 'zapo-js'
import type { DataStore } from '../data_store'
import { SendError } from '../send_error'

/** Never turn an unknown/missing media original into a text edit. */
export function buildZapoEditContent(original: proto.IMessage, body: string): WaSendMessageContent {
  let message = original
  for (let depth = 0; depth < 12; depth++) {
    if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) {
      throw new SendError(422, 'message_edit_view_once_unsupported')
    }
    const inner = message.ephemeralMessage?.message || message.documentWithCaptionMessage?.message
      || message.deviceSentMessage?.message || message.editedMessage?.message
      || (message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ? message.protocolMessage.editedMessage : undefined)
    if (!inner) break
    message = inner
  }
  for (const kind of ['imageMessage', 'videoMessage', 'documentMessage'] as const) {
    const media = message[kind]
    if (!media) continue
    if ('viewOnce' in media && media.viewOnce) throw new SendError(422, 'message_edit_view_once_unsupported')
    if (!media.mediaKey || media.mediaKey.length !== 32 || !media.fileSha256 || media.fileSha256.length !== 32
      || !media.fileEncSha256 || media.fileEncSha256.length !== 32 || !(media.directPath || media.url)) {
      throw new SendError(422, 'message_edit_original_media_incomplete')
    }
    // Raw Proto.IMessage preserves the encrypted media descriptors, without a new upload.
    const copy = proto.Message.decode(proto.Message.encode({ [kind]: media }).finish())
    copy[kind]!.caption = body
    return copy
  }
  if (typeof message.conversation === 'string' || typeof message.extendedTextMessage?.text === 'string') {
    return { type: 'text', text: body }
  }
  throw new SendError(422, 'message_edit_original_type_unsupported')
}

export class ZapoMessageEdit {
  constructor(private readonly cache: DataStore, private readonly store?: WaStoreSession) {}

  async original(key: WaMessageKey): Promise<proto.IMessage> {
    const record = await this.store?.messages.getById(key.id)
    if (record?.messageBytes?.length) {
      if (record.fromMe === false) throw new SendError(400, 'message_edit_original_not_from_me')
      if (record.id !== key.id || record.threadJid !== key.remoteJid) throw new SendError(409, 'message_edit_original_identity_mismatch')
      try { return proto.Message.decode(record.messageBytes) }
      catch { throw new SendError(422, 'message_edit_original_content_invalid') }
    }
    const cached = await this.cache.loadMessageExact?.(key.remoteJid, key.id) || await this.cache.loadMessage(key.remoteJid, key.id)
    if (!cached?.message) throw new SendError(404, 'message_edit_original_content_not_found')
    if (cached.key?.fromMe === false) throw new SendError(400, 'message_edit_original_not_from_me')
    if ((cached.key?.id && cached.key.id !== key.id) || (cached.key?.remoteJid && cached.key.remoteJid !== key.remoteJid)) {
      throw new SendError(409, 'message_edit_original_identity_mismatch')
    }
    return cached.message
  }
}
