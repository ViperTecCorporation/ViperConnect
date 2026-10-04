import { timingSafeEqual } from 'node:crypto'
import { X25519, type SignalKeyPair } from 'zapo-js/crypto'

// Only field names, never input values or underlying crypto exceptions, enter errors.
export class MobileCredentialError extends Error {
  constructor(public readonly field: string) { super(`mobile_credentials_invalid:${field}`) }
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileCredentialError(field)
  return value as Record<string, unknown>
}

export function text(value: unknown, field: string, maximum = 100): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new MobileCredentialError(field)
  return value
}

export function integer(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) throw new MobileCredentialError(field)
  return value
}

export function bytes(value: unknown, field: string, length: number): Buffer {
  let result: Buffer
  if (value instanceof Uint8Array) result = Buffer.from(value)
  else if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    result = Buffer.from(value, 'base64')
    if (result.toString('base64') !== value) throw new MobileCredentialError(field)
  } else throw new MobileCredentialError(field)
  if (result.length !== length) throw new MobileCredentialError(field)
  return result
}

export function keyPair(value: unknown, field: string): SignalKeyPair {
  const pair = record(value, field)
  const privKey = bytes(pair.private, `${field}.private`, 32)
  // The pinned whalibmob Store serializes Signal public keys as 0x05 + 32 bytes.
  const publicKey = bytes(pair.public, `${field}.public`, 33)
  if (publicKey[0] !== 5) throw new MobileCredentialError(`${field}.public`)
  const pubKey = Buffer.from(publicKey.subarray(1))
  let derived: Uint8Array
  try { derived = X25519.keyPairFromPrivateKey(privKey).pubKey }
  catch { throw new MobileCredentialError(field) }
  if (!timingSafeEqual(pubKey, derived)) throw new MobileCredentialError(field)
  return { privKey, pubKey }
}
