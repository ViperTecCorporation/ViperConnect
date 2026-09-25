import type { WaAuthCredentials, WaMobileTransportDeviceInfo } from 'zapo-js/auth'
import { xeddsaVerify } from 'zapo-js/crypto'
import { bytes, integer, keyPair, MobileCredentialError, record, text } from './credential_validation.js'

export const WHALIBMOB_CREDENTIAL_SOURCE = '422a5d7ea67b9171fe2211c5605333624c7eaebc'

export interface MobileCredentialConversionOptions {
  // Must be the exact canonical phone returned by registration, not a UI-normalized PN.
  expectedCanonicalPhone: string
  // Caller-owned durable secret: never silently minted on each conversion.
  // whalibmob mobile JSON does not contain this required Zapo field.
  advSecretKey: Uint8Array
}

function deviceInfo(value: unknown, version: unknown): WaMobileTransportDeviceInfo {
  const device = record(value, 'device')
  if (device.os !== 'android' && device.os !== 'ios') throw new MobileCredentialError('device.os')
  if (typeof device.business !== 'boolean') throw new MobileCredentialError('device.business')
  const appVersion = text(version, 'version', 32)
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(appVersion)) throw new MobileCredentialError('version')
  return {
    os: device.os,
    manufacturer: text(device.manufacturer, 'device.manufacturer'),
    device: text(device.os === 'android' ? device.modelId : device.model, 'device.model'),
    deviceModelType: text(device.modelId, 'device.modelId'),
    osVersion: text(device.osVersion, 'device.osVersion'),
    osBuildNumber: text(device.osBuildNumber, 'device.osBuildNumber'),
    appVersion,
    business: device.business,
  }
}

/** Offline structural/cryptographic conversion only; does NOT prove server registration.
 * Accepts the fresh mobile Store/JSON from the pinned source, not six-part exports,
 * companion stores, or an established session with message/prekey history.
 * No disk, Redis, environment mutation, logging, or network I/O.
 */
export async function convertWhalibmobCredentials(input: unknown, options: MobileCredentialConversionOptions): Promise<WaAuthCredentials> {
  const source = record(input, 'store')
  if (source.registered !== true || source.codePending !== false) throw new MobileCredentialError('registration_state')
  const phone = text(source.phoneNumber, 'phoneNumber', 15)
  if (!/^[1-9]\d{7,14}$/.test(phone) || phone !== options.expectedCanonicalPhone) throw new MobileCredentialError('phoneNumber')
  // Do not silently discard identities/state from an already used account.
  if (source.advIdentity != null || source.me != null || source.signedIdentityKey != null) throw new MobileCredentialError('unsupported_session_state')
  const noiseKeyPair = keyPair(source.noiseKeyPair, 'noiseKeyPair')
  const identityKeyPair = keyPair(source.identityKeyPair, 'identityKeyPair')
  const signed = record(source.signedPreKey, 'signedPreKey')
  const signedPair = keyPair(signed, 'signedPreKey')
  const signature = bytes(signed.signature, 'signedPreKey.signature', 64)
  let valid = false
  try { valid = await xeddsaVerify(identityKeyPair.pubKey, Buffer.concat([Buffer.from([5]), signedPair.pubKey]), signature) }
  catch { /* Return a sanitized field error below. */ }
  if (!valid) throw new MobileCredentialError('signedPreKey.signature')
  const name = text(source.name, 'name', 80)
  return {
    noiseKeyPair,
    registrationInfo: {
      registrationId: integer(source.registrationId, 'registrationId', 16384),
      identityKeyPair,
    },
    signedPreKey: {
      keyId: integer(signed.id, 'signedPreKey.id', 0xffffff),
      keyPair: signedPair,
      signature,
    },
    advSecretKey: bytes(options.advSecretKey, 'advSecretKey', 32),
    meJid: `${phone}@s.whatsapp.net`,
    meDisplayName: name,
    pushName: name,
    deviceInfo: deviceInfo(source.device, source.version),
    // Existing one-time prekeys must not be claimed as uploaded by this converter.
    serverHasPreKeys: false,
  }
}
