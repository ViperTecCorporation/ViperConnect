import { proto } from 'zapo-js'

const platforms = new Set(['e', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'link-code'])
export const safeCompanionPlatform = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? platforms.has(value) ? value : 'redacted' : undefined

/** Decode only known protobuf types at their explicit node tags. Never dump objects. */
export function companionProtoSummary(tag: string, content: unknown): object | undefined {
  if (!(content instanceof Uint8Array) || content.byteLength > 8192) return undefined
  try {
    if (tag === 'client-props') {
      const value = proto.ClientPairingProps.decode(content)
      const flags: Record<string, boolean> = {}
      for (const field of ['isChatDbLidMigrated', 'isSyncdPureLidSession', 'isSyncdSnapshotRecoveryEnabled', 'isHsThumbnailSyncEnabled'] as const) {
        if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] === 'boolean') flags[field] = value[field]!
      }
      return { clientPairingProps: flags, subscriptionPayloadPresent: !!value.subscriptionSyncPayload?.length }
    }
    if (tag === 'device-props') {
      const value = proto.DeviceProps.decode(content)
      const os = ['Android', 'iOS', 'Windows', 'Mac OS', 'Linux'].includes(value.os || '') ? value.os : value.os ? 'redacted' : undefined
      const platformType = Number.isInteger(value.platformType) && value.platformType! >= 0 && value.platformType! <= 30 ? value.platformType : undefined
      const version = [value.version?.primary, value.version?.secondary, value.version?.tertiary]
      return { deviceProps: { os, platformType, requireFullSync: value.requireFullSync,
        version: version.every(v => v === undefined || (Number.isSafeInteger(v) && v! >= 0 && v! < 1000000)) ? version : undefined,
        historySyncConfigPresent: !!value.historySyncConfig } }
    }
  } catch { return { protoDecodeFailed: true } }
  return undefined
}

export function companionAttributeValues(value: any): object {
  const out: Record<string, unknown> = {}
  const choices: Record<string, readonly string[]> = {
    type: ['get', 'set', 'result', 'error'], xmlns: ['md', 'w:sync:app:state', 'urn:xmpp:whatsapp:dirty'],
    stage: ['primary_hello', 'companion_hello', 'companion_finish', 'refresh_code'], algorithm: ['rsa2048'],
  }
  for (const [field, allowed] of Object.entries(choices)) if (allowed.includes(value?.[field])) out[field] = value[field]
  for (const field of ['code', 'version', 'ts', 'ts_s']) {
    if (/^\d{1,12}$/.test(value?.[field] || '')) out[field] = Number(value[field])
  }
  return out
}
