import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { SessionBackupObjectStore } from './backup'
import { decodeBackupStream, encodeBackupStream, type BackupProtection } from './backup_stream'
import { SessionStorageError } from './types'

const CHUNK = 256 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const INSTANCE = /^[A-Za-z0-9_.-]{1,100}$/

export interface RedisBackupManifest {
  id: string; version: 1; instanceId: string; createdAt: string
  objectKey: string; bytes: number; sha256: string; status: 'ready'
  scope: 'all-databases'; uploadVerified: true; rdbHeaderVerified: true
  protection?: BackupProtection
}
export interface RedisBackupIndex {
  put(manifest: RedisBackupManifest): Promise<void>
  get(id: string): Promise<RedisBackupManifest | undefined>
}
export interface RedisBackupProcess {
  run(executable: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string }>
  executableAvailable?(path: string): Promise<boolean>
}
export interface RedisRestorePreparation {
  instanceId: string; backupId: string; backupPassword?: string; destination: string
  confirmOffline: true; isDestinationOffline(): Promise<boolean>
}

/** No shell, no stdout/stderr logging, and no credential-bearing URL/password in argv. */
export const redisBackupProcess: RedisBackupProcess = {
  executableAvailable: async path => {
    try { await access(path, constants.X_OK); return (await stat(path)).isFile() } catch { return false }
  },
  run: (executable, args, options) => new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', settled = false, timedOut = false, forceTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => { timedOut = true; child.kill(); forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000); forceTimer.unref?.() }, options.timeoutMs)
    child.stdout.on('data', chunk => { if (output.length < 512) output += chunk.toString().slice(0, 512 - output.length) })
    child.stderr.on('data', () => { /* Drain, never retain provider errors that might contain connection details. */ })
    child.once('error', () => { clearTimeout(timer); clearTimeout(forceTimer); if (!settled) { settled = true; reject(new SessionStorageError(503, 'redis_backup_cli_failed')) } })
    child.once('close', code => { clearTimeout(timer); clearTimeout(forceTimer); if (!settled) { settled = true; if (timedOut) reject(new SessionStorageError(504, 'redis_backup_cli_timeout')); else if (code === 0) resolveRun({ stdout: output }); else reject(new SessionStorageError(503, 'redis_backup_cli_failed')) } })
  }),
}

function processEnvironment(auth?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
  if (auth !== undefined) env.REDISCLI_AUTH = auth
  return env
}

export async function redisBackupCapability(cliPath: string | undefined, runner: RedisBackupProcess = redisBackupProcess) {
  if (!cliPath) return { available: false, reason: 'redis_backup_cli_not_configured' }
  if (!isAbsolute(cliPath) || !/^(redis-cli|valkey-cli)(\.exe)?$/i.test(basename(cliPath))) return { available: false, reason: 'redis_backup_cli_path_invalid' }
  if (!runner.executableAvailable || !await runner.executableAvailable(cliPath)) return { available: false, reason: 'redis_backup_cli_unavailable' }
  return { available: true, reason: undefined }
}

/** --rdb always captures every Redis database, irrespective of URL /db. */
export function redisSnapshotArguments(redisUrl: string, destination: string, tlsCaFile?: string) {
  let url: URL
  try { url = new URL(redisUrl) } catch { throw new SessionStorageError(400, 'redis_backup_url_invalid') }
  const hostname = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || 6379)
  if (!['redis:', 'rediss:'].includes(url.protocol) || !hostname || (!isIP(hostname) && !/^[A-Za-z0-9.-]+$/.test(hostname)) || !Number.isInteger(port) || port < 1 || port > 65535
    || url.search || url.hash || !/^\/(\d+)?$/.test(url.pathname || '/')) throw new SessionStorageError(400, 'redis_backup_url_invalid')
  let username: string, password: string
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password) } catch { throw new SessionStorageError(400, 'redis_backup_url_invalid') }
  if (/[\x00-\x1f\x7f]/.test(username) || username.length > 128 || password.includes('\0') || password.length > 16384) throw new SessionStorageError(400, 'redis_backup_url_invalid')
  const args = ['-h', hostname, '-p', String(port)]
  if (username) args.push('--user', username)
  if (url.protocol === 'rediss:') { args.push('--tls'); if (!isIP(hostname)) args.push('--sni', hostname) }
  if (tlsCaFile) {
    if (url.protocol !== 'rediss:' || !isAbsolute(tlsCaFile)) throw new SessionStorageError(400, 'redis_backup_tls_configuration_invalid')
    args.push('--cacert', tlsCaFile)
  }
  args.push('--rdb', destination)
  return { args, env: processEnvironment(password || undefined) }
}

async function temporary<T>(action: (directory: string) => Promise<T>) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'viper-redis-backup-'))
  try { return await action(directory) } finally {
    if (resolve(directory).startsWith(parent + sep) && basename(directory).startsWith('viper-redis-backup-')) await rm(directory, { recursive: true, force: true })
  }
}

async function validateRdbHeader(path: string) {
  const file = await open(path, 'r'), header = Buffer.alloc(9)
  try { const result = await file.read(header, 0, header.length, 0); if (result.bytesRead !== 9 || !/^REDIS\d{4}$/.test(header.toString('ascii'))) throw new SessionStorageError(409, 'redis_backup_rdb_header_invalid') }
  finally { await file.close() }
}

async function digest(path: string) {
  const hash = createHash('sha256'); let bytes = 0
  for await (const data of createReadStream(path)) { hash.update(data); bytes += data.length }
  return { bytes, sha256: hash.digest('hex') }
}

function objectKey(instanceId: string, id: string) { return `backups/redis/${instanceId}/${id}.rdb.viperbackup` }

function validateManifest(value: any, instanceId: string, id: string): asserts value is RedisBackupManifest {
  if (!value || value.id !== id || value.instanceId !== instanceId || value.version !== 1 || value.status !== 'ready' || value.scope !== 'all-databases' || value.uploadVerified !== true || value.rdbHeaderVerified !== true
    || value.objectKey !== objectKey(instanceId, id) || !Number.isSafeInteger(value.bytes) || value.bytes < 10 || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isFinite(Date.parse(value.createdAt))
    || value.protection !== undefined && !['none', 'aes-256-gcm'].includes(value.protection)) throw new SessionStorageError(409, 'redis_backup_manifest_invalid')
}

async function verifyArchive(source: Readable, password: string | undefined, expected: Pick<RedisBackupManifest, 'id' | 'instanceId' | 'bytes' | 'sha256' | 'createdAt' | 'protection'>, output?: Awaited<ReturnType<typeof open>>) {
  const frames = decodeBackupStream(source, password), hash = createHash('sha256'); let bytes = 0, header = false
  try {
    for await (const frame of frames) {
      if (frame.kind === 'meta') {
        const meta = frame.value
        if (frame.protection !== (expected.protection || 'aes-256-gcm') || !meta || meta.kind !== 'redis-rdb' || meta.version !== 1 || meta.id !== expected.id || meta.instanceId !== expected.instanceId || meta.bytes !== expected.bytes || meta.sha256 !== expected.sha256 || meta.createdAt !== expected.createdAt
          || (meta.protection || 'aes-256-gcm') !== (expected.protection || 'aes-256-gcm')) throw new SessionStorageError(409, 'redis_backup_manifest_invalid')
        header = true
      } else if (frame.kind === 'records') {
        if (!header) throw new SessionStorageError(409, 'redis_backup_archive_invalid')
        for (const record of frame.value) {
          if (!record || Object.keys(record).sort().join(',') !== 'data,offset' || record.offset !== bytes || typeof record.data !== 'string' || record.data.length > CHUNK * 2) throw new SessionStorageError(409, 'redis_backup_archive_invalid')
          const chunk = Buffer.from(record.data, 'base64')
          if (!chunk.length || chunk.length > CHUNK || chunk.toString('base64') !== record.data || bytes + chunk.length > expected.bytes) throw new SessionStorageError(409, 'redis_backup_archive_invalid')
          if (output) { let offset = 0; while (offset < chunk.length) { const written = (await output.write(chunk, offset, chunk.length - offset)).bytesWritten; if (!written) throw new SessionStorageError(503, 'redis_backup_restore_write_failed'); offset += written } }
          hash.update(chunk); bytes += chunk.length
        }
      }
    }
    if (!header || bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new SessionStorageError(409, 'redis_backup_archive_invalid')
  } finally { source.destroy(); await frames.return(undefined) }
}

export class RedisGlobalBackups {
  constructor(readonly objects: SessionBackupObjectStore, readonly index: RedisBackupIndex, readonly runner: RedisBackupProcess = redisBackupProcess) {}

  async backup(input: { enabled: true; confirmAllDatabases: true; cliPath: string; redisUrl: string; backupPassword?: string; instanceId: string; tlsCaFile?: string; timeoutMs?: number }) {
    if (input.enabled !== true || input.confirmAllDatabases !== true) throw new SessionStorageError(409, 'redis_backup_opt_in_required')
    if (!INSTANCE.test(input.instanceId)) throw new SessionStorageError(400, 'redis_backup_instance_invalid')
    const capability = await redisBackupCapability(input.cliPath, this.runner)
    if (!capability.available) throw new SessionStorageError(503, capability.reason!)
    let version: { stdout: string }
    try { version = await this.runner.run(input.cliPath, ['--version'], { env: processEnvironment(), timeoutMs: 5000 }) }
    catch (error) { throw error instanceof SessionStorageError ? error : new SessionStorageError(503, 'redis_backup_cli_failed') }
    if (!/^(redis-cli|valkey-cli)\s+\d+\./i.test(version.stdout.trim())) throw new SessionStorageError(503, 'redis_backup_cli_incompatible')
    return temporary(async directory => {
      const path = join(directory, 'snapshot.rdb'), reservation = await open(path, 'wx', 0o600); await reservation.close()
      const options = redisSnapshotArguments(input.redisUrl, path, input.tlsCaFile)
      if (input.tlsCaFile) { try { if (!(await stat(input.tlsCaFile)).isFile()) throw new Error() } catch { throw new SessionStorageError(503, 'redis_backup_tls_ca_unavailable') } }
      try {
        await this.runner.run(input.cliPath, options.args, { env: options.env, timeoutMs: Math.max(1000, Math.min(input.timeoutMs || 600000, 1800000)) })
        await validateRdbHeader(path)
        const bytes = await digest(path), id = randomUUID(), createdAt = new Date().toISOString()
        const manifest: RedisBackupManifest = { id, version: 1, instanceId: input.instanceId, createdAt, objectKey: objectKey(input.instanceId, id), ...bytes, status: 'ready', scope: 'all-databases', uploadVerified: true, rdbHeaderVerified: true, protection: 'none' }
        const records = async function* () { let offset = 0; for await (const chunk of createReadStream(path, { highWaterMark: CHUNK })) { yield { offset, data: chunk.toString('base64') }; offset += chunk.length } }
        const archive = encodeBackupStream({ kind: 'redis-rdb', version: 1, id, instanceId: input.instanceId, createdAt, protection: 'none', ...bytes }, records()), stream = Readable.from(archive)
        try { await this.objects.save(manifest.objectKey, stream) } finally { stream.destroy(); await archive.return(undefined) }
        await verifyArchive(await this.objects.open(manifest.objectKey), input.backupPassword, manifest)
        // Non-secret sidecar survives loss of the Redis index itself. It contains no source URL/auth.
        await this.objects.save(manifest.objectKey + '.manifest.json', Readable.from([JSON.stringify(manifest)]))
        await this.index.put(manifest)
        return manifest
      } catch (error) { throw error instanceof SessionStorageError ? error : new SessionStorageError(503, 'redis_backup_failed') }
    })
  }

  /** Prepares a new offline file only. Never RESTORE, replace dump.rdb/AOF, restart, or activate sessions. */
  async prepareRestore(input: RedisRestorePreparation) {
    try { return await this.prepareRestoreFile(input) }
    catch (error) {
      if (error instanceof SessionStorageError) throw error
      if ((error as any)?.code === 'EEXIST') throw new SessionStorageError(409, 'redis_backup_restore_destination_exists')
      throw new SessionStorageError(503, 'redis_backup_restore_failed')
    }
  }

  private async prepareRestoreFile(input: RedisRestorePreparation) {
    if (!INSTANCE.test(input.instanceId) || !UUID.test(input.backupId) || !isAbsolute(input.destination) || input.confirmOffline !== true || !await input.isDestinationOffline()) throw new SessionStorageError(409, 'redis_backup_restore_offline_confirmation_required')
    let manifest = await this.index.get(input.backupId)
    if (!manifest) {
      const source = await this.objects.open(objectKey(input.instanceId, input.backupId) + '.manifest.json'); const chunks: Buffer[] = []; let bytes = 0
      try { for await (const chunk of source) { bytes += chunk.length; if (bytes > 16384) throw new SessionStorageError(409, 'redis_backup_manifest_invalid'); chunks.push(Buffer.from(chunk)) } manifest = JSON.parse(Buffer.concat(chunks).toString()) }
      finally { source.destroy() }
    }
    validateManifest(manifest, input.instanceId, input.backupId)
    const file = await open(input.destination, 'wx', 0o600); let complete = false
    try {
      await verifyArchive(await this.objects.open(manifest.objectKey), input.backupPassword, manifest, file)
      await file.sync(); await file.close(); await validateRdbHeader(input.destination); complete = true
      return { prepared: true, backupId: manifest.id, bytes: manifest.bytes, sha256: manifest.sha256, activatesRedis: false, requiresOfflineRedisValidation: true,
        warning: 'Before operator activation, validate with redis-check-rdb and invalidate stale leases/owners/running tasks; no live service was changed.' }
    } finally { await file.close().catch(() => {}); if (!complete) await rm(input.destination, { force: true }) }
  }
}

/** Polling is installed by the coordinator, not by this module. Shared claims prevent replica duplicates. */
export class RedisGlobalBackupScheduler {
  private running = false
  constructor(readonly runtime: { enabled(): boolean; claimWindow(window: number): Promise<boolean>; finishWindow?(window: number, success: boolean): Promise<void>; backup(): Promise<void> }) {}
  async tick(now = Date.now()) {
    if (!Number.isFinite(now) || now < 0) throw new SessionStorageError(400, 'redis_backup_window_invalid')
    if (this.running || !this.runtime.enabled()) return { status: 'skipped' as const }
    this.running = true
    const window = Math.floor(now / 43200000)
    let claimed = false
    try {
      if (!await this.runtime.claimWindow(window)) return { status: 'skipped' as const }
      claimed = true
      await this.runtime.backup()
      await this.runtime.finishWindow?.(window, true)
      return { status: 'ready' as const }
    } catch (error) {
      if (claimed) await this.runtime.finishWindow?.(window, false).catch(() => {})
      return { status: 'failed' as const, code: error instanceof SessionStorageError ? error.code : 'redis_backup_failed' }
    }
    finally { this.running = false }
  }
}
