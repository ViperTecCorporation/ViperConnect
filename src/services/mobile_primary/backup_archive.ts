import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { MobileDeviceError } from '../mobile_device_service'

export const BACKUP_MAX_BYTES = 16 * 1024 * 1024
const FORMAT = 'viperconnect-mobile-backup-v1'

export function validateBackupPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new MobileDeviceError(400, 'mobile_backup_password_required')
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
}

/** Portable AEAD envelope; never uses the originating stack token as its password. */
export async function encryptMobileBackup(value: unknown, password: string): Promise<string> {
  validateBackupPassword(password)
  const plaintext = Buffer.from(JSON.stringify(value))
  if (plaintext.length > BACKUP_MAX_BYTES / 2) throw new MobileDeviceError(413, 'mobile_backup_too_large')
  const salt = randomBytes(16), iv = randomBytes(12), key = await derive(password, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(FORMAT))
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return JSON.stringify({ format: FORMAT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
  } finally { plaintext.fill(0); key.fill(0) }
}

export async function decryptMobileBackup(archive: unknown, password: string): Promise<any> {
  validateBackupPassword(password)
  if (typeof archive !== 'string' || Buffer.byteLength(archive) > BACKUP_MAX_BYTES) throw new MobileDeviceError(413, 'mobile_backup_too_large')
  let key: Buffer | undefined, plaintext: Buffer | undefined
  try {
    const input = JSON.parse(archive)
    if (input.format !== FORMAT || Object.keys(input).sort().join(',') !== 'data,format,iv,salt,tag') throw new Error()
    const decode = (text: unknown, size?: number) => {
      if (typeof text !== 'string') throw new Error()
      const bytes = Buffer.from(text, 'base64')
      if (bytes.toString('base64') !== text || (size !== undefined && bytes.length !== size)) throw new Error()
      return bytes
    }
    const salt = decode(input.salt, 16), iv = decode(input.iv, 12), tag = decode(input.tag, 16), data = decode(input.data)
    if (data.length > BACKUP_MAX_BYTES / 2) throw new Error()
    key = await derive(password, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(FORMAT)); decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(data), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch { throw new MobileDeviceError(400, 'mobile_backup_invalid_or_wrong_password') }
  finally { key?.fill(0); plaintext?.fill(0) }
}
