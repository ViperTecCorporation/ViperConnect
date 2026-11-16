import { downloadMediaMessage, proto } from 'zapo-js'
import type { Config } from '../config'
import { SendError } from '../send_error'
import { projectSessionMessage } from '../messages/session_message_projection'
import { createZapoProxyOptions } from '../zapo/zapo_proxy'
import { openSessionDatabase } from './database'
import { SqliteSessionQueries } from './sqlite_queries'
import { assertLocalStorageOwner, assertSessionEffectsAllowed, isSqliteSession } from './routing'

type Result = { file: string; mime_type: string; filename: string }
type MediaIdentity = { providerId: string; aliases: string[] }
const pending = new Map<string, Promise<Result>>()

function mediaIdentity(phone: string, config: Config, requestedId: string): MediaIdentity {
  const db = openSessionDatabase(phone, config)
  const read = (kind: string, id: string) => db.getValue(`unoapi-${kind}:${phone}:${id}`)?.toString()
  const providerId = read('id_rev', requestedId) || requestedId
  const unoId = read('id', providerId)
  // Only live, reciprocal mappings from this session may resolve a public ID.
  // Never scan another session or reuse an expired/one-sided ID reference.
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerId)
    || providerId !== requestedId && unoId !== requestedId
    || unoId && (!/^[A-Za-z0-9_-]{1,200}$/.test(unoId) || read('id_rev', unoId) !== providerId)) {
    throw new SendError(503, 'session_storage_media_id_mapping_invalid')
  }
  return { providerId, aliases: [...new Set([unoId, providerId, requestedId].filter((value): value is string => !!value))] }
}

/** Owner prepares shared media; only an internal S3 object key, never raw bytes, crosses RPC. */
export async function prepareSqliteSessionMedia(phone: string, config: Config, id: string): Promise<Result> {
  assertLocalStorageOwner(config)
  assertSessionEffectsAllowed(config)
  if (!isSqliteSession(config) || !config.useS3) throw new SendError(409, 'session_storage_media_requires_shared_s3')
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new SendError(400, 'invalid_message_id')
  const identity = mediaIdentity(phone, config, id)
  const key = `${phone}:${config.sessionStorage!.storageId}:${config.sessionStorage!.generation}:${identity.providerId}`
  const existing = pending.get(key)
  if (existing) return existing
  const work = prepare(phone, config, identity)
  pending.set(key, work)
  try { return await work } finally { pending.delete(key) }
}

async function prepare(phone: string, config: Config, identity: MediaIdentity): Promise<Result> {
  const { providerId: id, aliases } = identity
  const db = openSessionDatabase(phone, config), queries = new SqliteSessionQueries(phone, config)
  const record = queries.record(id)
  if (!record) throw new SendError(404, 'message_not_found')
  const dto = projectSessionMessage(record)
  let revoked = dto.type === 'revoked'
  for (const alias of aliases) {
    const state = db.getValue(`unoapi:zapo:panel:${phone}:state:${alias}`)
    if (state) { try { revoked ||= JSON.parse(state.toString()).type === 'revoked' } catch { throw new SendError(503, 'session_storage_media_state_invalid') } }
  }
  if (dto.type === 'view_once' || revoked) throw new SendError(403, 'message_media_not_available')
  if (!dto.media || !record.messageBytes) throw new SendError(404, 'message_has_no_media')
  const { mediaStore, dataStore } = await config.getStore(phone, config)
  for (const mediaId of aliases) {
    const payload = await dataStore.loadMediaPayload(mediaId)
    if (!payload) continue
    const mime = payload.mime_type || dto.media.mime_type
    const file = mediaStore.getFilePath(phone, mediaId, mime, payload.filename)
    if (await mediaStore.hasMedia(file)) return { file, mime_type: mime, filename: dto.media.filename }
  }
  const file = mediaStore.getFilePath(phone, id, dto.media.mime_type, dto.media.filename)
  if (!await mediaStore.hasMedia(file)) {
    const stream = await downloadMediaMessage(proto.Message.decode(record.messageBytes), {
      maxBytes: 256 * 1024 * 1024, timeoutMs: 60000,
      proxy: createZapoProxyOptions(config.proxyUrl, undefined, { network: process.env.ZAPO_NETWORK_IP_FAMILY, mediaDownload: process.env.ZAPO_MEDIA_DOWNLOAD_IP_FAMILY })?.mediaDownload,
    })
    try {
      if (await mediaStore.saveMediaStream(file, stream, dto.media.mime_type, false) !== true) throw new SendError(503, 'session_storage_media_save_failed')
    } catch (error) { await mediaStore.removeMedia(file).catch(() => undefined); throw error }
    finally { stream.destroy() }
  }
  return { file, mime_type: dto.media.mime_type, filename: dto.media.filename }
}
