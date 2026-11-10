import { createHash } from 'node:crypto'
import { decryptSessionStream } from '../session_transfer/archive_stream'
import { SessionStorageError } from './types'

const FORMAT = 'viperconnect-storage-backup-stream', LEGACY = 'viperconnect-session-stream-v2'
const FRAME_BYTES = 4 * 1024 * 1024, LINE_BYTES = 6 * 1024 * 1024
export type BackupProtection = 'none' | 'aes-256-gcm'
export type BackupFrame = { kind: 'meta'; value: any; protection: BackupProtection } | { kind: 'records'; value: any[] } | { kind: 'end'; count: number }
const invalid = (): never => { throw new SessionStorageError(409, 'session_storage_backup_stream_invalid') }
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value)
const shape = (value: any, keys: string) => object(value) && Object.keys(value).sort().join(',') === keys

/** Bounded parser shared by plain detection and legacy replay; never buffers an entire backup. */
async function* lines(source: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const pending = Buffer.allocUnsafe(LINE_BYTES)
  let length = 0
  for await (const part of source) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    let offset = 0
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset), chunk = bytes.subarray(offset, end < 0 ? bytes.length : end)
      if (length + chunk.length > LINE_BYTES) return invalid()
      chunk.copy(pending, length); length += chunk.length; offset = end < 0 ? bytes.length : end + 1
      if (end >= 0) {
        if (!length) return invalid()
        const text = pending.subarray(0, length).toString('utf8')
        if (!Buffer.from(text).equals(pending.subarray(0, length))) return invalid()
        yield text; length = 0
      }
    }
  }
  if (length) return invalid()
}

/** New automatic/storage backups are intentionally unencrypted; footer detects accidental corruption, not tampering. */
export async function* encodeBackupStream(meta: unknown, records: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
  const hash = createHash('sha256'); let index = 0, count = 0
  const line = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (bytes.length > FRAME_BYTES) throw new SessionStorageError(413, 'session_storage_backup_record_too_large')
    hash.update(bytes); return bytes
  }
  yield line({ format: FORMAT, version: 1, protection: 'none' })
  yield line({ index: index++, kind: 'meta', value: meta })
  let batch: unknown[] = [], size = 64
  for await (const record of records) {
    const serialized = JSON.stringify(record)
    if (serialized === undefined) return invalid()
    const length = Buffer.byteLength(serialized) + 1
    if (length > FRAME_BYTES - 128) throw new SessionStorageError(413, 'session_storage_backup_record_too_large')
    if (batch.length && (batch.length >= 100 || size + length > 1024 * 1024)) { yield line({ index: index++, kind: 'records', value: batch }); batch = []; size = 64 }
    batch.push(record); size += length; count++
    if (!Number.isSafeInteger(count)) return invalid()
  }
  if (batch.length) yield line({ index: index++, kind: 'records', value: batch })
  yield Buffer.from(JSON.stringify({ index, kind: 'end', count, sha256: hash.digest('hex') }) + '\n')
}

/** Auto-detects new plain format or the unchanged encrypted manual-transfer codec used by older backups. */
export async function* decodeBackupStream(source: AsyncIterable<Buffer | string>, password?: string): AsyncGenerator<BackupFrame> {
  const iterator = lines(source)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || Buffer.byteLength(first.value) > 2048) return invalid()
    let header: any
    try { header = JSON.parse(first.value) } catch { return invalid() }
    if (header?.format === LEGACY) {
      if (typeof password !== 'string' || !password) throw new SessionStorageError(409, 'session_storage_backup_legacy_key_required')
      const replay = async function* () { yield Buffer.from(first.value + '\n'); for (;;) { const next = await iterator.next(); if (next.done) break; yield Buffer.from(next.value + '\n') } }
      for await (const frame of decryptSessionStream(replay(), password)) yield frame.kind === 'meta' ? { ...frame, protection: 'aes-256-gcm' } : frame
      return
    }
    if (!shape(header, 'format,protection,version') || header.format !== FORMAT || header.version !== 1 || header.protection !== 'none') return invalid()
    const hash = createHash('sha256').update(first.value + '\n')
    let index = 0, count = 0, ended = false
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (ended || Buffer.byteLength(next.value) > FRAME_BYTES) return invalid()
      let frame: any
      try { frame = JSON.parse(next.value) } catch { return invalid() }
      if (!object(frame) || frame.index !== index || !Number.isSafeInteger(frame.index)) return invalid()
      if (frame.kind === 'end') {
        if (index === 0 || !shape(frame, 'count,index,kind,sha256') || frame.count !== count || frame.sha256 !== hash.digest('hex')) return invalid()
        ended = true; yield { kind: 'end', count }; continue
      }
      if (!shape(frame, 'index,kind,value') || (index === 0 ? frame.kind !== 'meta' : frame.kind !== 'records')) return invalid()
      hash.update(next.value + '\n'); index++
      if (frame.kind === 'records') {
        if (!Array.isArray(frame.value) || !frame.value.length || frame.value.length > 100) return invalid()
        count += frame.value.length; if (!Number.isSafeInteger(count)) return invalid()
        yield { kind: 'records', value: frame.value }
      } else yield { kind: 'meta', value: frame.value, protection: 'none' }
    }
    if (!ended) return invalid()
  } finally { await iterator.return?.(undefined) }
}
