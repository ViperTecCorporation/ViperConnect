import type { Config } from '../config'
import { SendError } from '../send_error'
import { proto } from 'zapo-js/proto'

export const storageOwner = () => process.env.UNOAPI_STORAGE_WORKER_ID || process.env.UNOAPI_SERVER_NAME || 'server_1'
export const isSqliteSession = (config: Pick<Config, 'sessionStorage'>) => config.sessionStorage?.backend === 'sqlite'
export const isStorageWorker = () => process.env.UNOAPI_PROCESS_ROLE === 'worker'

export function assertSessionEffectsAllowed(config: Pick<Config, 'sessionStorage'>) {
  if (config.sessionStorage?.fixture || process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY === 'true') {
    throw new SendError(409, 'session_storage_fixture_external_effects_forbidden')
  }
  if (['migrating', 'restoring'].includes(config.sessionStorage?.state || '')) {
    throw new SendError(409, 'session_storage_operation_in_progress')
  }
}

export function assertLocalStorageOwner(config: Pick<Config, 'sessionStorage'>) {
  if (!isSqliteSession(config)) return
  if (!isStorageWorker() || config.sessionStorage!.owner !== storageOwner()) {
    throw new SendError(409, 'session_storage_wrong_owner')
  }
}

/** AMQP JSON does not preserve Uint8Array/Buffer automatically. */
export function storageWireEncode(value: any, depth = 0): any {
  if (depth > 30) throw new SendError(400, 'session_storage_payload_too_deep')
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __storageBytes: Buffer.from(value).toString('base64') }
  if (value && typeof value.toNumber === 'function' && Number.isInteger(value.low) && Number.isInteger(value.high) && typeof value.unsigned === 'boolean') {
    return { __storageLong: { low: value.low, high: value.high, unsigned: value.unsigned } }
  }
  if (Array.isArray(value)) return value.map(item => storageWireEncode(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storageWireEncode(item, depth + 1)]))
  return value
}

export function storageWireDecode(value: any, depth = 0): any {
  if (depth > 30) throw new SendError(400, 'session_storage_payload_too_deep')
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.__storageBytes === 'string') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.__storageBytes)) throw new SendError(400, 'session_storage_invalid_binary_frame')
    return Buffer.from(value.__storageBytes, 'base64')
  }
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && value.__storageLong) {
    const bits = value.__storageLong
    if (!Number.isInteger(bits.low) || bits.low < -2147483648 || bits.low > 2147483647 || !Number.isInteger(bits.high) || bits.high < -2147483648 || bits.high > 2147483647 || typeof bits.unsigned !== 'boolean') throw new SendError(400, 'session_storage_invalid_long_frame')
    // Recreate the exact 64-bit type through the official protobuf API, without
    // a lossy Number conversion or a new dependency on a particular Long package.
    const decoded = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode({ messageTimestamp: bits }).finish()).messageTimestamp as any
    if (!decoded || typeof decoded !== 'object' || typeof decoded.toNumber !== 'function') throw new SendError(503, 'session_storage_long_codec_unavailable')
    decoded.unsigned = bits.unsigned
    return decoded
  }
  if (Array.isArray(value)) return value.map(item => storageWireDecode(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storageWireDecode(item, depth + 1)]))
  return value
}

export const DATA_STORE_OPERATIONS = new Set([
  'loadKey', 'setKey', 'loadMessage', 'loadMessageExact', 'findMessageWithSecret', 'setUnoId',
  'setMediaPayload', 'loadMediaPayload', 'setImageUrl', 'removeImageUrl', 'getImageUrl',
  'setGroupMetada', 'getGroupMetada', 'loadUnoId', 'loadProviderId', 'setStatus', 'loadStatus',
  'getJid', 'setJid', 'setMessage', 'getContactName', 'setContactName', 'getContactInfo', 'setContactInfo',
  'getLastIncomingKey', 'setLastIncomingKey', 'loadTemplates', 'setTemplates',
  'getPnForLid', 'getLidForPn', 'setJidMapping', 'removeJidMapping',
])
