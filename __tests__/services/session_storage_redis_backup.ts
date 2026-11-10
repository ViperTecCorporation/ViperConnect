import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { RedisGlobalBackups, RedisGlobalBackupScheduler, redisBackupCapability, redisBackupProcess, redisSnapshotArguments, RedisBackupManifest } from '../../src/services/session_storage/redis_backup'
import { decodeBackupStream } from '../../src/services/session_storage/backup_stream'
import { encryptSessionStream } from '../../src/services/session_transfer/archive_stream'

const backupPassword = 'dedicated-synthetic-backup-key'
// Deliberately not advertised as a semantic Redis restore test: CLI is injected here.
const rdb = Buffer.concat([Buffer.from('REDIS0012'), Buffer.from([0, 255, 128, 0]), Buffer.alloc(700000, 42)])

function fixture() {
  const objects = new Map<string, Buffer>(), manifests = new Map<string, RedisBackupManifest>()
  const store = { save: jest.fn(async (key: string, source: Readable) => { const parts: Buffer[] = []; for await (const chunk of source) parts.push(Buffer.from(chunk)); objects.set(key, Buffer.concat(parts)) }), open: jest.fn(async (key: string) => Readable.from([objects.get(key)!])) }
  const index = { put: jest.fn(async (manifest: RedisBackupManifest) => { manifests.set(manifest.id, manifest) }), get: jest.fn(async (id: string) => manifests.get(id)) }
  const runner = { executableAvailable: jest.fn(async () => true), run: jest.fn(async (_exe: string, args: string[], _options: any) => { if (args[0] === '--version') return { stdout: 'valkey-cli 9.0.0' }; const output = args[args.indexOf('--rdb') + 1]; await writeFile(output, rdb); return { stdout: 'Transfer finished with success.' } }) }
  const input = { enabled: true as const, confirmAllDatabases: true as const, cliPath: join(tmpdir(), 'valkey-cli.exe'), redisUrl: 'redis://backup-user:synthetic%40password@127.0.0.1:6379/3', backupPassword, instanceId: 'synthetic-stack' }
  return { objects, manifests, store, index, runner, input, service: new RedisGlobalBackups(store, index, runner) }
}

async function legacyArchive(f: ReturnType<typeof fixture>, manifest: RedisBackupManifest) {
  const legacy = { ...manifest }, records: unknown[] = []; let meta: any
  delete legacy.protection
  for await (const frame of decodeBackupStream(Readable.from([f.objects.get(manifest.objectKey)!]))) {
    if (frame.kind === 'meta') { meta = { ...frame.value }; delete meta.protection }
    else if (frame.kind === 'records') records.push(...frame.value)
  }
  const parts: Buffer[] = [], source = async function* () { yield* records }
  for await (const part of encryptSessionStream(meta, source(), backupPassword)) parts.push(part)
  f.objects.set(manifest.objectKey, Buffer.concat(parts)); f.objects.set(manifest.objectKey + '.manifest.json', Buffer.from(JSON.stringify(legacy))); f.manifests.set(legacy.id, legacy)
  return legacy
}

test('snapshot CLI uses argv without credentials, AUTH only in a minimal environment, TLS and explicit all-database scope', () => {
  const out = join(tmpdir(), 'snapshot.rdb'), value = redisSnapshotArguments('rediss://operator:synthetic%40password@redis.internal:6380/9', out)
  expect(value.args).toEqual(['-h', 'redis.internal', '-p', '6380', '--user', 'operator', '--tls', '--sni', 'redis.internal', '--rdb', out])
  expect(value.env.REDISCLI_AUTH).toBe('synthetic@password')
  expect(value.env.SESSION_STORAGE_BACKUP_KEY).toBeUndefined(); expect(JSON.stringify(value.args)).not.toContain('password')
  expect(redisSnapshotArguments('redis://[::1]:6379/0', out).args).toContain('::1')
  for (const url of ['https://redis.internal', 'redis://localhost/0?password=x', 'redis://localhost/0#fragment', 'redis://localhost/not-a-db']) expect(() => redisSnapshotArguments(url, out)).toThrow('redis_backup_url_invalid')
  expect(() => redisSnapshotArguments('redis://localhost/0', out, '/ca.pem')).toThrow('redis_backup_tls_configuration_invalid')
})

test('CLI capability is explicit and backup is disabled unless operator opted in with all-database confirmation', async () => {
  expect(await redisBackupCapability(undefined)).toEqual({ available: false, reason: 'redis_backup_cli_not_configured' })
  expect((await redisBackupCapability('redis-cli')).reason).toBe('redis_backup_cli_path_invalid')
  expect((await redisBackupCapability(join(tmpdir(), 'redis-cli.exe'))).reason).toBe('redis_backup_cli_unavailable')
  const f = fixture()
  await expect(f.service.backup({ ...f.input, enabled: false } as any)).rejects.toThrow('redis_backup_opt_in_required')
  f.runner.executableAvailable.mockResolvedValueOnce(false)
  await expect(f.service.backup(f.input)).rejects.toThrow('redis_backup_cli_unavailable')
  expect(f.runner.run).not.toHaveBeenCalled()
})

test('new backup streams unencrypted RDB without any key, verifies readback, publishes sidecar and removes temporary files', async () => {
  const f = fixture(), result = await f.service.backup({ ...f.input, backupPassword: undefined })
  expect(result).toMatchObject({ status: 'ready', scope: 'all-databases', uploadVerified: true, bytes: rdb.length, protection: 'none' })
  expect(f.store.open).toHaveBeenCalledWith(result.objectKey)
  expect(f.objects.get(result.objectKey + '.manifest.json')!.toString()).not.toContain('password')
  expect(f.objects.get(result.objectKey)!.toString()).toContain('viperconnect-storage-backup-stream')
  expect(f.objects.get(result.objectKey)!.toString()).not.toContain('"salt"')
  expect(f.index.put).toHaveBeenCalledTimes(1)
  const snapshotArgs = f.runner.run.mock.calls[1][1], temp = snapshotArgs[snapshotArgs.indexOf('--rdb') + 1]
  expect(f.runner.run.mock.calls[1][2].env.REDISCLI_AUTH).toBe('synthetic@password')
  expect(JSON.stringify(snapshotArgs)).not.toContain('synthetic@password')
  await expect(stat(dirname(temp))).rejects.toHaveProperty('code', 'ENOENT')
})

test('corrupt uploaded archive and failed CLI never publish ready metadata and always remove temporary RDB', async () => {
  const f = fixture(); f.store.open.mockResolvedValueOnce(Readable.from(['truncated-object']))
  await expect(f.service.backup(f.input)).rejects.toThrow('session_storage_backup_stream_invalid')
  expect(f.index.put).not.toHaveBeenCalled()
  const args = f.runner.run.mock.calls[1][1], file = args[args.indexOf('--rdb') + 1]
  await expect(stat(dirname(file))).rejects.toHaveProperty('code', 'ENOENT')
  f.runner.run.mockRejectedValueOnce(new Error('raw-url-with-secret-password'))
  await expect(f.service.backup(f.input)).rejects.toThrow('redis_backup_cli_failed')
})

test('offline restore preparation survives a lost Redis index using S3 sidecar, preserves bytes and never activates Redis', async () => {
  const f = fixture(), manifest = await f.service.backup(f.input), directory = await mkdtemp(join(tmpdir(), 'viper-rdb-restore-test-'))
  f.index.get.mockResolvedValue(undefined)
  try {
    const destination = join(directory, 'prepared.rdb')
    const result = await f.service.prepareRestore({ instanceId: f.input.instanceId, backupId: manifest.id, destination, confirmOffline: true, isDestinationOffline: async () => true })
    expect(result).toMatchObject({ prepared: true, activatesRedis: false, requiresOfflineRedisValidation: true })
    expect(await readFile(destination)).toEqual(rdb)
    expect(f.runner.run).toHaveBeenCalledTimes(2)
    await expect(f.service.prepareRestore({ instanceId: f.input.instanceId, backupId: manifest.id, backupPassword, destination, confirmOffline: true, isDestinationOffline: async () => true })).rejects.toThrow('redis_backup_restore_destination_exists')
    await expect(f.service.prepareRestore({ instanceId: f.input.instanceId, backupId: manifest.id, backupPassword, destination: join(directory, 'no.rdb'), confirmOffline: true, isDestinationOffline: async () => false })).rejects.toThrow('redis_backup_restore_offline_confirmation_required')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

test('existing encrypted RDB restores with original key after index loss; missing key is explicit and old archive stays intact', async () => {
  const f = fixture(), manifest = await legacyArchive(f, await f.service.backup(f.input)), original = Buffer.from(f.objects.get(manifest.objectKey)!)
  const directory = await mkdtemp(join(tmpdir(), 'viper-rdb-restore-test-')); f.index.get.mockResolvedValue(undefined)
  const input = { instanceId: f.input.instanceId, backupId: manifest.id, confirmOffline: true as const, isDestinationOffline: async () => true }
  try {
    await expect(f.service.prepareRestore({ ...input, destination: join(directory, 'no-key.rdb') })).rejects.toThrow('session_storage_backup_legacy_key_required')
    await expect(f.service.prepareRestore({ ...input, backupPassword: 'wrong-synthetic-password', destination: join(directory, 'wrong-key.rdb') })).rejects.toThrow('redis_backup_restore_failed')
    const destination = join(directory, 'legacy.rdb')
    await expect(f.service.prepareRestore({ ...input, backupPassword, destination })).resolves.toHaveProperty('prepared', true)
    expect(await readFile(destination)).toEqual(rdb); expect(f.objects.get(manifest.objectKey)).toEqual(original)
    await expect(stat(join(directory, 'no-key.rdb'))).rejects.toHaveProperty('code', 'ENOENT')
    await expect(stat(join(directory, 'wrong-key.rdb'))).rejects.toHaveProperty('code', 'ENOENT')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)

test('plain Redis archive rejects forged legacy/encrypted labels and unknown protection even if a key is supplied', async () => {
  const f = fixture(), manifest = await f.service.backup({ ...f.input, backupPassword: 'short' }), directory = await mkdtemp(join(tmpdir(), 'viper-rdb-restore-test-'))
  try {
    for (const protection of [undefined, 'aes-256-gcm', 'unknown']) {
      f.manifests.set(manifest.id, { ...manifest, protection } as any)
      await expect(f.service.prepareRestore({ instanceId: f.input.instanceId, backupId: manifest.id, backupPassword, destination: join(directory, 'invalid.rdb'), confirmOffline: true, isDestinationOffline: async () => true })).rejects.toThrow('redis_backup_manifest_invalid')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('global backup scheduler is opt-in, single-concurrency and claims one shared window every 12 hours', async () => {
  let finish!: () => void
  const runtime = { enabled: jest.fn(() => false), claimWindow: jest.fn(async () => true), backup: jest.fn(async () => new Promise<void>(resolve => { finish = resolve })) }
  const scheduler = new RedisGlobalBackupScheduler(runtime)
  expect(await scheduler.tick(43200001)).toEqual({ status: 'skipped' }); expect(runtime.claimWindow).not.toHaveBeenCalled()
  runtime.enabled.mockReturnValue(true); const pending = scheduler.tick(43200001)
  await Promise.resolve(); expect(await scheduler.tick(43200001)).toEqual({ status: 'skipped' }); finish(); expect(await pending).toEqual({ status: 'ready' })
  expect(runtime.claimWindow).toHaveBeenCalledWith(1)
  runtime.claimWindow.mockResolvedValueOnce(false); expect(await scheduler.tick(43200001)).toEqual({ status: 'skipped' })
  runtime.backup.mockRejectedValueOnce(new Error('private-error'))
  expect(await scheduler.tick(86400001)).toEqual({ status: 'failed', code: 'redis_backup_failed' })
  await expect(scheduler.tick(NaN)).rejects.toThrow('redis_backup_window_invalid')
})

test('actual subprocess adapter bounds output, suppresses stderr and terminates only its own timed-out child', async () => {
  const env = { ...process.env }, result = await redisBackupProcess.run(process.execPath, ['-e', "process.stderr.write('synthetic-private-error');process.stdout.write('x'.repeat(2000))"], { env, timeoutMs: 5000 })
  expect(result.stdout.length).toBe(512); expect(JSON.stringify(result)).not.toContain('synthetic-private-error')
  await expect(redisBackupProcess.run(process.execPath, ['-e', 'process.exit(2)'], { env, timeoutMs: 5000 })).rejects.toThrow('redis_backup_cli_failed')
  await expect(redisBackupProcess.run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { env, timeoutMs: 50 })).rejects.toThrow('redis_backup_cli_timeout')
})
