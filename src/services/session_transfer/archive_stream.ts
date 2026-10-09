import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { MobileDeviceError } from '../mobile_device_service'
import { validateBackupPassword } from '../mobile_primary/backup_archive'

const FORMAT = 'viperconnect-session-stream-v2'
export const FRAME_BYTES = 4 * 1024 * 1024
const LINE_BYTES = 6 * 1024 * 1024
const invalid = (): never => { throw new MobileDeviceError(400, 'mobile_backup_invalid_or_wrong_password') }
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))
})
const decode = (value: unknown, length?: number) => {
  if (typeof value !== 'string') return invalid()
  const result = Buffer.from(value, 'base64')
  if (result.toString('base64') !== value || length !== undefined && result.length !== length) return invalid()
  return result
}
const iv = (nonce: Buffer, index: number) => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) return invalid()
  const result = Buffer.alloc(12); nonce.copy(result); result.writeUInt32BE(index, 8); return result
}

/** Bounded line parser; accepts arbitrary transport chunk boundaries, never file.text(). */
export async function* backupLines(source: AsyncIterable<Buffer | string>, max = LINE_BYTES): AsyncGenerator<string> {
  const pending = Buffer.alloc(max)
  let length = 0
  for await (const input of source) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
    let offset = 0
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset)
      const part = bytes.subarray(offset, end < 0 ? bytes.length : end)
      if (length + part.length > max) return invalid()
      part.copy(pending, length); length += part.length
      offset = end < 0 ? bytes.length : end + 1
      if (end >= 0) { if (!length) return invalid(); yield pending.subarray(0, length).toString('utf8'); pending.fill(0, 0, length); length = 0 }
    }
  }
  if (length) return invalid() // terminal newline also detects truncated frames
}

/** Each frame authenticates the header and its sequence; a required final frame detects truncation. */
export async function* encryptSessionStream(meta: unknown, records: AsyncIterable<unknown>, password: string): AsyncGenerator<Buffer> {
  validateBackupPassword(password)
  const salt = randomBytes(16), nonce = randomBytes(8)
  const header = JSON.stringify({ format: FORMAT, salt: salt.toString('base64'), nonce: nonce.toString('base64') })
  const key = await derive(password, salt)
  let index = 0, count = 0
  const frame = (value: unknown) => {
    const plain = Buffer.from(JSON.stringify(value))
    if (plain.length > FRAME_BYTES) throw new MobileDeviceError(413, 'session_backup_record_too_large')
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv(nonce, index))
      cipher.setAAD(Buffer.from(header + ':' + index))
      const data = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.from(JSON.stringify({ index: index++, data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) + '\n')
    } finally { plain.fill(0) }
  }
  try {
    yield Buffer.from(header + '\n'); yield frame({ kind: 'meta', value: meta })
    let batch: unknown[] = [], size = 64
    for await (const record of records) {
      const length = Buffer.byteLength(JSON.stringify(record)) + 1
      if (length > FRAME_BYTES - 64) throw new MobileDeviceError(413, 'session_backup_record_too_large')
      if (batch.length && (batch.length >= 100 || size + length > 1024 * 1024)) { yield frame({ kind: 'records', value: batch }); batch = []; size = 64 }
      batch.push(record); size += length; count++
    }
    if (batch.length) yield frame({ kind: 'records', value: batch })
    yield frame({ kind: 'end', count })
  } finally { key.fill(0) }
}

export async function* decryptSessionStream(source: AsyncIterable<Buffer | string>, password: string): AsyncGenerator<any> {
  validateBackupPassword(password)
  const lines = backupLines(source)[Symbol.asyncIterator]()
  let key: Buffer | undefined
  try {
    const first = await lines.next()
    if (first.done) return invalid()
    const header = first.value, parsed = JSON.parse(header)
    if (parsed.format !== FORMAT || Object.keys(parsed).sort().join(',') !== 'format,nonce,salt') return invalid()
    const nonce = decode(parsed.nonce, 8); key = await derive(password, decode(parsed.salt, 16))
    let index = 0, count = 0, done = false
    for (;;) {
      const next = await lines.next()
      if (next.done) break
      if (done) return invalid()
      const input = JSON.parse(next.value)
      if (Object.keys(input).sort().join(',') !== 'data,index,tag' || input.index !== index) return invalid()
      const data = decode(input.data)
      if (data.length > FRAME_BYTES) return invalid()
      const decipher = createDecipheriv('aes-256-gcm', key, iv(nonce, index))
      decipher.setAAD(Buffer.from(header + ':' + index)); decipher.setAuthTag(decode(input.tag, 16))
      const plain = Buffer.concat([decipher.update(data), decipher.final()])
      let value: any
      try { value = JSON.parse(plain.toString('utf8')) } finally { plain.fill(0) }
      if (index === 0 ? value.kind !== 'meta' : !['records', 'end'].includes(value.kind)) return invalid()
      index++
      if (value.kind === 'records') {
        if (!Array.isArray(value.value) || !value.value.length || value.value.length > 100) return invalid()
        count += value.value.length
      }
      if (value.kind === 'end') { if (value.count !== count) return invalid(); done = true }
      yield value
    }
    if (!done) return invalid()
  } catch (error) {
    if (error instanceof MobileDeviceError) throw error
    return invalid()
  } finally { key?.fill(0); await lines.return?.(undefined) }
}
