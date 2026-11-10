import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { decodeBackupStream, encodeBackupStream, type BackupProtection } from './backup_stream'
import { SessionStorageDescriptor, SessionStorageError, validateSessionPhone, validateStorageDescriptor } from './types'
import { requireSafeSqliteEngine } from './sqlite_engine'
import { assertSqliteWalSafeVersion } from './sqlite_safety'

export interface SqliteBackupManifest {
  id: string; version: 1; phone: string; storageId: string; generation: number
  createdAt: string; objectKey: string; bytes: number; sha256: string
  kind: 'linked-session' | 'mobile-primary'; status: 'ready'
  protection?: BackupProtection
}
export interface SessionBackupObjectStore {
  save(key: string, stream: Readable): Promise<void>
  open(key: string): Promise<Readable>
  remove?(key: string): Promise<void>
}
export interface SessionBackupIndex {
  put(manifest: SqliteBackupManifest): Promise<void>
  get(id: string): Promise<SqliteBackupManifest | undefined>
}

const CHUNK = 256 * 1024
const MAX_RESTORE_BYTES = 16 * 1024 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Actual SQLite online backup, not a copy of the live main file/WAL. */
export async function snapshotSqlite(source: string, destination: string) {
  if (resolve(source) === resolve(destination) || (await lstat(source)).isSymbolicLink()) throw new SessionStorageError(409, 'session_storage_snapshot_source_invalid')
  if (!await stat(source).then(value => value.isFile())) throw new SessionStorageError(409, 'session_storage_snapshot_source_invalid')
  const sqlite = requireSafeSqliteEngine()
  const reservation = await open(destination, 'wx', 0o600); await reservation.close()
  try {
    const db = new sqlite.DatabaseSync(source, { readOnly: true, timeout: 5000 })
    try { assertSqliteWalSafeVersion(db.prepare('SELECT sqlite_version() AS version').get()?.version); await sqlite.backup(db, destination, { rate: 100 }) } finally { db.close() }
    const check = new sqlite.DatabaseSync(destination, { readOnly: true })
    try { if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new SessionStorageError(409, 'session_storage_snapshot_invalid') } finally { check.close() }
  } catch (error) { await rm(destination, { force: true }); throw error }
}

async function fileDigest(path: string) {
  const hash = createHash('sha256'); let bytes = 0
  for await (const data of createReadStream(path)) { hash.update(data); bytes += data.length }
  return { bytes, sha256: hash.digest('hex') }
}

async function temporary<T>(action: (directory: string) => Promise<T>) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'viper-session-backup-'))
  try { return await action(directory) } finally {
    if (resolve(directory).startsWith(parent + sep) && basename(directory).startsWith('viper-session-backup-')) await rm(directory, { recursive: true, force: true })
  }
}

/** Dedicated backup namespace: no media-removal queue and no implicit 24h lifecycle. */
export class SessionSqliteBackups {
  constructor(readonly objects: SessionBackupObjectStore, readonly index: SessionBackupIndex) {}

  async backup(input: { phone: string; path: string; storage: SessionStorageDescriptor; password?: string; kind?: 'linked-session' | 'mobile-primary'; supplement?: Record<string, unknown>; validateSnapshot?(): Promise<boolean> }) {
    validateSessionPhone(input.phone); validateStorageDescriptor(input.storage)
    if (input.storage.backend !== 'sqlite' || !['active', 'offline'].includes(input.storage.state)) throw new SessionStorageError(409, 'session_storage_backup_requires_sqlite')
    if (input.kind === 'mobile-primary' && !input.supplement?.registration) throw new SessionStorageError(409, 'session_storage_mobile_registration_required')
    return temporary(async directory => {
      const path = join(directory, 'snapshot.sqlite')
      await snapshotSqlite(input.path, path)
      if (input.validateSnapshot && !await input.validateSnapshot()) throw new SessionStorageError(409, 'session_storage_backup_shared_state_changed')
      const digest = await fileDigest(path), id = randomUUID()
      const manifest: SqliteBackupManifest = { id, version: 1, phone: input.phone, storageId: input.storage.storageId, generation: input.storage.generation,
        createdAt: new Date().toISOString(), objectKey: `backups/session-storage/${input.phone}/${id}.viperstorage`, ...digest, kind: input.kind || 'linked-session', status: 'ready', protection: 'none' }
      const records = async function* () {
        let offset = 0
        for await (const chunk of createReadStream(path, { highWaterMark: CHUNK })) {
          yield { offset, data: chunk.toString('base64') }; offset += chunk.length
        }
      }
      const archive = encodeBackupStream({ kind: 'sqlite-session', version: 1, manifest, supplement: input.supplement || {} }, records())
      const stream = Readable.from(archive)
      try { await this.objects.save(manifest.objectKey, stream) } finally { stream.destroy(); await archive.return(undefined) }
      // A completed PUT is not proof of a readable, intact snapshot. Read the
      // uploaded object back through the same offline restore verifier before
      // publishing any ready index or replacing the last successful receipt.
      const verifier = new SessionSqliteBackups(this.objects, {
        put: async () => undefined,
        get: async id => id === manifest.id ? manifest : undefined,
      })
      await verifier.restore({ phone: input.phone, backupId: manifest.id, password: input.password, stagedPath: join(directory, 'verified.sqlite') })
      await this.index.put(manifest)
      return manifest
    })
  }

  /** Recovery material can be verified without a Redis index. Never publishes it or connects a session. */
  async restoreStandalone(input: { phone: string; manifest: SqliteBackupManifest; password?: string; stagedPath: string }) {
    return new SessionSqliteBackups(this.objects, {
      put: async () => undefined,
      get: async id => id === input.manifest.id ? input.manifest : undefined,
    }).restore({ phone: input.phone, backupId: input.manifest.id, password: input.password, stagedPath: input.stagedPath })
  }

  /** Restores to caller-owned staging only. Does not register an owner, connect, or overwrite files. */
  async restore(input: { phone: string; backupId: string; password?: string; stagedPath: string }) {
    validateSessionPhone(input.phone)
    if (!UUID.test(input.backupId)) throw new SessionStorageError(400, 'session_storage_backup_id_invalid')
    const expected = await this.index.get(input.backupId)
    if (!expected || expected.phone !== input.phone || expected.status !== 'ready' || expected.id !== input.backupId
      || expected.objectKey !== `backups/session-storage/${input.phone}/${input.backupId}.viperstorage`) throw new SessionStorageError(404, 'session_storage_backup_not_found')
    if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || expected.bytes > MAX_RESTORE_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || expected.protection !== undefined && !['none', 'aes-256-gcm'].includes(expected.protection)) throw new SessionStorageError(409, 'session_storage_backup_invalid')
    const file = await open(input.stagedPath, 'wx', 0o600)
    let source: Readable | undefined
    let frames: ReturnType<typeof decodeBackupStream> | undefined
    let complete = false, bytes = 0, meta: any
    const hash = createHash('sha256')
    try {
      source = await this.objects.open(expected.objectKey); frames = decodeBackupStream(source, input.password)
      for await (const frame of frames) {
        if (frame.kind === 'meta') {
          meta = frame.value
          if (frame.protection !== (expected.protection || 'aes-256-gcm') || meta?.kind !== 'sqlite-session' || meta.version !== 1 || !isDeepStrictEqual(meta.manifest, expected)
            || !meta.supplement || typeof meta.supplement !== 'object' || Array.isArray(meta.supplement)) throw new SessionStorageError(409, 'session_storage_backup_invalid')
        } else if (frame.kind === 'records') {
          if (!meta) throw new SessionStorageError(409, 'session_storage_backup_invalid')
          for (const record of frame.value) {
            if (!record || Object.keys(record).sort().join(',') !== 'data,offset' || record.offset !== bytes || typeof record.data !== 'string' || record.data.length > CHUNK * 2) throw new SessionStorageError(409, 'session_storage_backup_invalid')
            const data = Buffer.from(record.data, 'base64')
            if (!data.length || data.length > CHUNK || data.toString('base64') !== record.data || bytes + data.length > expected.bytes) throw new SessionStorageError(409, 'session_storage_backup_invalid')
            let written = 0
            while (written < data.length) {
              const step = (await file.write(data, written, data.length - written)).bytesWritten
              if (step === 0) throw new SessionStorageError(503, 'session_storage_restore_write_failed')
              written += step
            }
            hash.update(data); bytes += data.length
          }
        }
      }
      if (!meta || bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new SessionStorageError(409, 'session_storage_backup_invalid')
      if (expected.kind === 'mobile-primary' && !meta.supplement.registration) throw new SessionStorageError(409, 'session_storage_mobile_registration_required')
      await file.sync(); await file.close()
      const sqlite = requireSafeSqliteEngine(), db = new sqlite.DatabaseSync(input.stagedPath, { readOnly: true })
      try {
        assertSqliteWalSafeVersion(db.prepare('SELECT sqlite_version() AS version').get()?.version)
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new SessionStorageError(409, 'session_storage_snapshot_invalid')
      } finally { db.close() }
      complete = true
      return { manifest: expected, supplement: meta.supplement as Record<string, unknown>, autoConnect: false as const }
    } finally {
      await file.close().catch(() => {}); source?.destroy(); await frames?.return(undefined)
      if (!complete) await rm(input.stagedPath, { force: true })
    }
  }
}
