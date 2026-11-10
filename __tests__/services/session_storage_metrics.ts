import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getStorageMetrics, getStorageMetricsComparison, measureRedisSession, measureSqliteSession, readCgroupMemoryMetrics, saveStorageMetricsSnapshot, snapshotStorageMetrics } from '../../src/services/session_storage/metrics'
import { getSessionSqlitePath } from '../../src/services/session_storage/database'

const phone = '999123456789'
const redis = () => ({ dbSize: jest.fn(async () => 10000), scan: jest.fn(async () => ({ cursor: 0, keys: [`unoapi-message:${phone}:conversation:id`, `unoapi-id:${phone}:id`, `unoapi-message:${phone}0:other:id`, 'unoapi-jidmap:global:lid_for_pn:999123456789'] })), sendCommand: jest.fn(async () => 256) })

test('Redis metrics read metadata only and scope an exact session instead of contact/global substring matches', async () => {
  const r = redis(), result = await measureRedisSession(r, phone)
  expect(result.scanComplete).toBe(true); expect(result.scannedKeys).toBe(4); expect(result.sampledKeys).toBe(2)
  expect(result.estimatedBytes).toBe(512)
  expect(result.families.map(value => value.family)).toEqual(['uno/message', 'uno/id'])
  for (const args of r.sendCommand.mock.calls) expect(args[0].slice(0, 2)).toEqual(['MEMORY', 'USAGE'])
  expect(JSON.stringify(result)).not.toContain('conversation:id')
})

test('partial Redis scan is bounded, estimated and does not imply exact session allocation', async () => {
  const r = redis(); r.scan.mockResolvedValue({ cursor: 1, keys: [`unoapi:zapo:msg:${phone}:id:message_bytes`] })
  const result = await measureRedisSession(r, phone, 'unoapi:zapo:', { pages: 2, samplesPerFamily: 1 })
  expect(r.scan).toHaveBeenCalledTimes(2); expect(result.partial).toBe(true); expect(result.estimated).toBe(true)
  expect(result.families[0].family).toBe('zapo/msg'); expect(result.sampledKeys).toBe(1)
  await expect(measureRedisSession(r, 'invalid')).rejects.toThrow('session_storage_phone_invalid')
  await expect(measureRedisSession(r, phone, '*')).rejects.toThrow('session_storage_prefix_invalid')
})

test('real SQLite metrics count/sample length only and measure database/WAL without exposing content', async () => {
  const baseStore = await mkdtemp(join(tmpdir(), 'viper-metrics-test-'))
  const config: any = { baseStore, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'offline', fixture: true } }
  const path = getSessionSqlitePath(phone, config); await mkdir(dirname(path), { recursive: true })
  const { DatabaseSync: Database } = require('node:sqlite'), db = new Database(path)
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE uno_kv(key TEXT PRIMARY KEY, value BLOB, expires_at INTEGER)')
    db.prepare('INSERT INTO uno_kv VALUES (?,?,?)').run('provider-to-uno', Buffer.from('synthetic-private-content'), 1999999999999)
    const result = await measureSqliteSession(phone, config)
    expect(result.files.databaseBytes).toBeGreaterThan(0); expect(result.files.walBytes).toBeGreaterThan(0)
    expect(result.records).toBe(1); expect(result.estimatedLogicalBytes).toBeGreaterThan(20)
    expect(result.cacheBudgetBytes).toBe(1048576); expect(result.cacheBudgetIsMeasurement).toBe(false)
    expect(result.cacheBudget).toEqual({ unoBytes: 1048576, sdkBytes: 0, sharedConnection: true, soft: true, measuredUsage: false })
    expect(result.sqliteEngine).toBe('node:sqlite'); expect(result.sqliteVersion).toMatch(/^3\.\d+\.\d+$/)
    expect(JSON.stringify(result)).not.toContain('synthetic-private-content'); expect(JSON.stringify(result)).not.toContain(path)
  } finally { db.close(); await rm(baseStore, { recursive: true, force: true }) }
})

test('fixture blocks external access; repeated metrics polls share cached storage sampling and RSS is not session-attributed', async () => {
  const config: any = { baseStore: '.', sessionStorage: { backend: 'redis', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'offline', fixture: true } }
  await expect(snapshotStorageMetrics(phone, config)).rejects.toThrow('session_storage_fixture_external_access_blocked')
  const r = redis(), dependency = { redis: r, sharedSessionCount: () => 7 }
  const [first, second]: any[] = await Promise.all([getStorageMetrics(phone, config, dependency), getStorageMetrics(phone, config, dependency)])
  expect(first.storage).toBe(second.storage); expect(r.dbSize).toHaveBeenCalledTimes(1)
  expect(first.worker).toMatchObject({ sharedSessionCount: 7, sharedProcess: true, attributedToSession: false })
  expect(first.worker.rssBytes).toBeGreaterThan(0)
  expect((await getStorageMetrics(phone, config, dependency)).storage).toBe(first.storage)
})

test('before/after comparison is exact-session scoped and stores metadata snapshots only', async () => {
  const id = randomUUID(), values = new Map<string, string>()
  const store = { get: jest.fn(async (key: string) => values.get(key) || null), eval: jest.fn(async (_lua: string, input: any) => { input.keys.forEach((key: string, i: number) => values.set(key, input.arguments[i])); return 1 }) }
  expect(await getStorageMetricsComparison(store, phone)).toEqual({ before: null, after: null })
  const metrics = await snapshotStorageMetrics(phone, {} as any, { redis: redis(), sharedSessionCount: () => 1 })
  await saveStorageMetricsSnapshot(store, phone, id, 'before', metrics)
  const comparison = await getStorageMetricsComparison(store, phone)
  expect(comparison.operationId).toBe(id); expect(comparison.before.storage.estimatedBytes).toBe(512); expect(comparison.after).toBeNull()
  await expect(saveStorageMetricsSnapshot(store, '999987654321', id, 'after', metrics)).rejects.toThrow('session_storage_metrics_scope_invalid')
})

test('five-second Redis polls refresh shared worker memory/clock without rescanning within one minute', async () => {
  const config: any = { baseStore: '.', sessionStorage: { backend: 'redis', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'offline', fixture: true } }
  let clock = Date.now(), rss = 100000
  const baseMemory = process.memoryUsage()
  jest.spyOn(Date, 'now').mockImplementation(() => clock)
  jest.spyOn(process, 'memoryUsage').mockImplementation(() => ({ ...baseMemory, rss: ++rss }))
  const r = redis(), dependency = { redis: r, sharedSessionCount: () => 7 }
  try {
    const first = await getStorageMetrics(phone, config, dependency)
    for (let i = 1; i <= 11; i++) {
      clock += 5000
      const next = await getStorageMetrics(phone, config, dependency)
      expect(next.worker.sampledAt).toBe(clock); expect(next.worker.rssBytes).toBeGreaterThan(first.worker.rssBytes)
      expect(next.worker.sharedSessionCount).toBe(7); expect(next.worker.attributedToSession).toBe(false)
      expect(next.storageSampledAt).toBe(first.storageSampledAt)
    }
    expect(r.dbSize).toHaveBeenCalledTimes(1)
    clock += 5001; await getStorageMetrics(phone, config, dependency)
    expect(r.dbSize).toHaveBeenCalledTimes(2)
  } finally { jest.restoreAllMocks() }
})

test('SQLite file/WAL stats refresh every poll but SQL table/count/length sampling remains cached for 60 seconds', async () => {
  const baseStore = await mkdtemp(join(tmpdir(), 'viper-metrics-poll-test-'))
  const config: any = { baseStore, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'offline', fixture: true } }
  const path = getSessionSqlitePath(phone, config); await mkdir(dirname(path), { recursive: true })
  const { DatabaseSync: Database } = require('node:sqlite'), db = new Database(path)
  let clock = Date.now()
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE uno_kv(key TEXT PRIMARY KEY,value BLOB)'); db.prepare('INSERT INTO uno_kv VALUES (?,?)').run('one', Buffer.from('one'))
    const prepares = jest.spyOn(Database.prototype, 'prepare'); jest.spyOn(Date, 'now').mockImplementation(() => clock)
    const first: any = await getStorageMetrics(phone, config, { sharedSessionCount: () => 2 })
    expect(first.storage.records).toBe(1)
    const countCalls = () => prepares.mock.calls.filter(call => String(call[0]).startsWith('SELECT COUNT(*)')).length
    expect(countCalls()).toBe(1)
    db.prepare('INSERT INTO uno_kv VALUES (?,?)').run('two', Buffer.alloc(65536, 255)); clock += 5000
    const second: any = await getStorageMetrics(phone, config, { sharedSessionCount: () => 2 })
    expect(second.storage.files.walBytes).toBeGreaterThan(first.storage.files.walBytes)
    expect(second.storage.fileSampledAt).toBe(clock); expect(second.storage.records).toBe(1); expect(countCalls()).toBe(1)
    clock += 55001
    const third: any = await getStorageMetrics(phone, config, { sharedSessionCount: () => 2 })
    expect(third.storage.records).toBe(2); expect(countCalls()).toBe(2)
  } finally { jest.restoreAllMocks(); db.close(); await rm(baseStore, { recursive: true, force: true }) }
})

test('cgroup memory separates all-process anon/file cache from RSS without per-session attribution', async () => {
  const read = jest.fn(async (path: string) => path.endsWith('memory.current') ? '838860800\n' : path.endsWith('memory.max') ? '2147483648\n' : 'anon 314572800\nfile 419430400\ninactive_file 209715200\nshmem 4096\nkernel 10485760\nslab 2048\n')
  const result = await readCgroupMemoryMetrics({ platform: 'linux', readFile: read })
  expect(result).toMatchObject({ currentBytes: 838860800, anonBytes: 314572800, fileBytes: 419430400, inactiveFileBytes: 209715200, limitBytes: 2147483648, sharedAcrossProcesses: true, attributedToSession: false })
  expect(read).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(result)).not.toContain('/sys/')
  expect(result?.note).toContain('Docker stats may subtract inactive_file')
})

test('unsupported/missing/invalid cgroup data is unavailable and unlimited memory is not reported as zero', async () => {
  const read = jest.fn(async () => 'not-a-number')
  expect(await readCgroupMemoryMetrics({ platform: 'win32', readFile: read })).toBeUndefined(); expect(read).not.toHaveBeenCalled()
  expect(await readCgroupMemoryMetrics({ platform: 'linux', readFile: async () => { throw new Error('private-filesystem-error') } })).toBeUndefined()
  expect(await readCgroupMemoryMetrics({ platform: 'linux', readFile: read })).toBeUndefined()
  const unlimited = await readCgroupMemoryMetrics({ platform: 'linux', readFile: async path => path.endsWith('memory.current') ? '99' : path.endsWith('memory.max') ? 'max' : 'anon 9\nfile 90\n' })
  expect(unlimited?.currentBytes).toBe(99); expect(unlimited?.limitBytes).toBeUndefined()
  expect(await readCgroupMemoryMetrics({ platform: 'linux', readFile: async path => path.endsWith('memory.current') ? '99999999999999999999' : 'anon 1\nfile 2\n' })).toBeUndefined()
})

test('five-second polling refreshes container memory independently of the expensive Redis sample cache', async () => {
  const config: any = { baseStore: '.', sessionStorage: { backend: 'redis', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'offline', fixture: true } }
  let current = 1000, clock = Date.now()
  jest.spyOn(Date, 'now').mockImplementation(() => clock)
  const r = redis(), cgroup = { platform: 'linux' as const, readFile: jest.fn(async (path: string) => path.endsWith('memory.current') ? String(current) : path.endsWith('memory.max') ? 'max' : 'anon 100\nfile 200\n') }
  try {
    const first = await getStorageMetrics(phone, config, { redis: r, sharedSessionCount: () => 4, cgroup })
    current = 2000; clock += 5000
    const second = await getStorageMetrics(phone, config, { redis: r, sharedSessionCount: () => 4, cgroup })
    expect(first.worker.container?.currentBytes).toBe(1000); expect(second.worker.container?.currentBytes).toBe(2000)
    expect(second.worker.container?.sampledAt).toBe(clock); expect(second.storageSampledAt).toBe(first.storageSampledAt)
    expect(r.dbSize).toHaveBeenCalledTimes(1); expect(second.worker.sharedSessionCount).toBe(4)
  } finally { jest.restoreAllMocks() }
})
