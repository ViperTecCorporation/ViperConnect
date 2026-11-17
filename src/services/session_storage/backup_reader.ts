import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Readable } from 'node:stream'
import type { SessionBackupObjectStore, SqliteBackupManifest } from './backup'
import { decodeBackupStream } from './backup_stream'
import { SessionStorageError } from './types'

export const SQLITE_BACKUP_CHUNK_BYTES = 256 * 1024

/** Verify every decoded byte against a trusted manifest. An optional sequential
 * sink reconstructs a restore file; readback of a locally checked snapshot needs
 * no second SQLite copy. This does not replace SQLite validation of an import. */
export async function readSqliteBackupArchive(objects: Pick<SessionBackupObjectStore, 'open'>, expected: SqliteBackupManifest,
  password?: string, write?: (data: Buffer) => Promise<void>): Promise<Record<string, unknown>> {
  let source: Readable | undefined, frames: ReturnType<typeof decodeBackupStream> | undefined
  let bytes = 0, meta: any
  const hash = createHash('sha256')
  try {
    source = await objects.open(expected.objectKey); frames = decodeBackupStream(source, password)
    for await (const frame of frames) {
      if (frame.kind === 'meta') {
        meta = frame.value
        if (frame.protection !== (expected.protection || 'aes-256-gcm') || meta?.kind !== 'sqlite-session' || meta.version !== 1
          || !isDeepStrictEqual(meta.manifest, expected) || !meta.supplement || typeof meta.supplement !== 'object' || Array.isArray(meta.supplement)) throw new SessionStorageError(409, 'session_storage_backup_invalid')
      } else if (frame.kind === 'records') {
        if (!meta) throw new SessionStorageError(409, 'session_storage_backup_invalid')
        for (const record of frame.value) {
          if (!record || Object.keys(record).sort().join(',') !== 'data,offset' || record.offset !== bytes || typeof record.data !== 'string' || record.data.length > SQLITE_BACKUP_CHUNK_BYTES * 2) throw new SessionStorageError(409, 'session_storage_backup_invalid')
          const data = Buffer.from(record.data, 'base64')
          if (!data.length || data.length > SQLITE_BACKUP_CHUNK_BYTES || data.toString('base64') !== record.data || bytes + data.length > expected.bytes) throw new SessionStorageError(409, 'session_storage_backup_invalid')
          await write?.(data)
          hash.update(data); bytes += data.length
        }
      }
    }
    if (!meta || bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new SessionStorageError(409, 'session_storage_backup_invalid')
    if (expected.kind === 'mobile-primary' && !meta.supplement.registration) throw new SessionStorageError(409, 'session_storage_mobile_registration_required')
    return meta.supplement
  } finally { source?.destroy(); await frames?.return(undefined) }
}
