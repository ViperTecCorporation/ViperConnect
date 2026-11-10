import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { RedisGlobalBackups, RedisBackupManifest } from '../../src/services/session_storage/redis_backup'

const execute = promisify(execFile)
const integration = process.env.REDIS_BACKUP_TEST_CONTAINER ? test : test.skip

/** Opt-in only: a throwaway network-none Valkey with the exact ownership label and no mounts. */
integration('official Valkey --rdb captures all databases and encrypted roundtrip passes offline valkey-check-rdb', async () => {
  const container = process.env.REDIS_BACKUP_TEST_CONTAINER!
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('owned_container_id_required')
  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker'
  const run = async (args: string[]) => (await execute(docker, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout
  const inspection = JSON.parse(await run(['inspect', container]))[0]
  expect(inspection.Config.Labels['com.vipertec.codex-probe']).toBe('redis-global-backup-probe')
  expect(inspection.HostConfig.NetworkMode).toBe('none'); expect(inspection.Mounts).toEqual([]); expect(inspection.State.Running).toBe(true)
  expect((await run(['exec', container, 'valkey-cli', 'DBSIZE'])).trim()).toBe('0')
  await run(['exec', container, 'valkey-cli', '-n', '0', 'SET', 'synthetic:db0', 'fixture-zero'])
  await run(['exec', container, 'valkey-cli', '-n', '2', 'SET', 'synthetic:db2', 'fixture-two'])
  const objects = new Map<string, Buffer>(), manifests = new Map<string, RedisBackupManifest>()
  const store = { save: async (key: string, stream: Readable) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); objects.set(key, Buffer.concat(chunks)) }, open: async (key: string) => Readable.from([objects.get(key)!]) }
  const index = { put: async (value: RedisBackupManifest) => { manifests.set(value.id, value) }, get: async (id: string) => manifests.get(id) }
  const cli = join(tmpdir(), 'valkey-cli.exe')
  const runner = {
    executableAvailable: async () => true,
    run: async (_exe: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: await run(['exec', container, 'valkey-cli', '--version']) }
      const hostOutput = args[args.indexOf('--rdb') + 1], translated = [...args]
      translated[translated.indexOf('--rdb') + 1] = '/tmp/synthetic-global-backup.rdb'
      const stdout = await run(['exec', container, 'valkey-cli', ...translated])
      await run(['cp', `${container}:/tmp/synthetic-global-backup.rdb`, hostOutput])
      return { stdout }
    },
  }
  const service = new RedisGlobalBackups(store, index, runner), password = 'synthetic-global-backup-password'
  const result = await service.backup({ enabled: true, confirmAllDatabases: true, cliPath: cli, redisUrl: 'redis://127.0.0.1:6379/0', backupPassword: password, instanceId: 'isolated-valkey' })
  expect(result.uploadVerified).toBe(true); expect(result.scope).toBe('all-databases')
  const directory = await mkdtemp(join(tmpdir(), 'viper-real-rdb-restore-test-'))
  try {
    const path = join(directory, 'offline.rdb')
    const prepared = await service.prepareRestore({ instanceId: result.instanceId, backupId: result.id, backupPassword: password, destination: path, confirmOffline: true, isDestinationOffline: async () => true })
    expect(prepared.activatesRedis).toBe(false); expect((await readFile(path)).subarray(0, 5).toString()).toBe('REDIS')
    await run(['cp', path, `${container}:/tmp/verified-offline.rdb`])
    const checked = await run(['exec', container, 'valkey-check-rdb', '/tmp/verified-offline.rdb'])
    expect(checked).toMatch(/RDB looks OK/); expect(checked).toMatch(/2 keys read/)
    expect((await run(['exec', container, 'valkey-cli', '-n', '0', 'GET', 'synthetic:db0'])).trim()).toBe('fixture-zero')
    expect((await run(['exec', container, 'valkey-cli', '-n', '2', 'GET', 'synthetic:db2'])).trim()).toBe('fixture-two')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
