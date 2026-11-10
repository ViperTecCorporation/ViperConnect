import { readFile, stat } from 'node:fs/promises'
import type { Config } from '../config'
import { getSessionSqlitePath } from './database'
import { storageRoot } from './capability'
import { SessionStorageError, SessionStorageRedis, validateSessionPhone } from './types'
import { assertSqliteWalSafeVersion } from './sqlite_safety'

const CACHE_MS = 60000
type StorageMetricsSnapshot = Awaited<ReturnType<typeof snapshotStorageMetrics>>
const cache = new Map<string, { expires: number; value: StorageMetricsSnapshot }>()
const inFlight = new Map<string, Promise<StorageMetricsSnapshot>>()

export interface CgroupMemoryReader {
  platform?: NodeJS.Platform
  readFile?(path: string): Promise<string>
}

function memoryNumber(value: string) {
  if (!/^\d+$/.test(value.trim())) return undefined
  const number = Number(value.trim())
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

/** Cgroup v2 only; absent/unsupported OS metadata is unavailable, never a fabricated zero. */
export async function readCgroupMemoryMetrics(reader: CgroupMemoryReader = {}) {
  if ((reader.platform || process.platform) !== 'linux') return undefined
  const read = reader.readFile || ((path: string) => readFile(path, 'utf8'))
  try {
    const [current, details, maximum] = await Promise.all([
      read('/sys/fs/cgroup/memory.current'), read('/sys/fs/cgroup/memory.stat'), read('/sys/fs/cgroup/memory.max').catch(() => 'max'),
    ])
    if (current.length > 40 || details.length > 65536 || maximum.length > 40) return undefined
    const currentBytes = memoryNumber(current), fields = new Map<string, number>()
    for (const line of details.split('\n')) {
      const match = /^(anon|file|inactive_file|shmem|kernel|slab)\s+(\d+)\s*$/.exec(line)
      if (match) { const number = memoryNumber(match[2]); if (number !== undefined) fields.set(match[1], number) }
    }
    const anonBytes = fields.get('anon'), fileBytes = fields.get('file')
    if (currentBytes === undefined || anonBytes === undefined || fileBytes === undefined) return undefined
    return { source: 'cgroup-v2' as const, currentBytes, anonBytes, fileBytes,
      inactiveFileBytes: fields.get('inactive_file'), shmemBytes: fields.get('shmem'), kernelBytes: fields.get('kernel'), slabBytes: fields.get('slab'),
      limitBytes: maximum.trim() === 'max' ? undefined : memoryNumber(maximum), sampledAt: Date.now(),
      sharedAcrossProcesses: true, attributedToSession: false,
      note: 'Cgroup total includes other processes and filesystem cache; file also includes tmpfs/shared memory. Inactive file is a reclamation indicator, not guaranteed free RAM. Docker stats may subtract inactive_file.' }
  } catch { return undefined }
}

export interface StorageMetricsRedis {
  dbSize(): Promise<number>
  scan(cursor: number, options: { COUNT: number }): Promise<{ cursor: number; keys: string[] }>
  sendCommand(args: string[]): Promise<unknown>
}

function sessionFamily(key: string, phone: string, prefix: string): string | undefined {
  if (key.startsWith(prefix)) {
    const rest = key.slice(prefix.length)
    const domains = ['appstate:idx:set', 'appstate:key:idx', 'signal:pk:avail', 'signal:pk:ids', 'msg:idx', 'sk:grp', 'signal:reg', 'signal:spk', 'signal:meta', 'signal:pk', 'signal:sess', 'signal:ident', 'appstate:key', 'appstate:col', 'appstate:idx', 'retry:out', 'retry:in', 'auth', 'sk', 'skd', 'privtoken', 'msg', 'contact', 'contact_pn', 'thread', 'panel', 'devlist', 'devlistalt', 'msgsecret', 'participants', 'chat_metadata']
    const domain = domains.find(d => rest === `${d}:${phone}` || rest.startsWith(`${d}:${phone}:`))
    return domain ? `zapo/${domain}` : undefined
  }
  const match = /^unoapi-([A-Za-z_-]+):([^:]+)(?::|$)/.exec(key)
  return match && match[2] === phone ? `uno/${match[1]}` : undefined
}

/** Bounded metadata-only sample. Never GET/HGETALL, no key names or values in its result. */
export async function measureRedisSession(redis: StorageMetricsRedis, phone: string, prefix = 'unoapi:zapo:', limits: { pages?: number; samplesPerFamily?: number; milliseconds?: number } = {}) {
  validateSessionPhone(phone)
  if (!/^[A-Za-z0-9_:]*$/.test(prefix)) throw new SessionStorageError(400, 'session_storage_prefix_invalid')
  const maxPages = Math.min(40, Math.max(1, limits.pages || 20)), maximum = Math.min(100, Math.max(1, limits.samplesPerFamily || 40)), budget = Math.min(3000, Math.max(50, limits.milliseconds || 1500))
  const started = Date.now(), databaseKeys = Number(await redis.dbSize()), seen = new Set<string>()
  const groups = new Map<string, { count: number; sample: string[] }>()
  let cursor = 0, pages = 0, scanComplete = false
  do {
    const page = await redis.scan(cursor, { COUNT: 500 }); cursor = Number(page.cursor); pages++
    for (const key of page.keys) {
      if (seen.has(key)) continue; seen.add(key)
      const family = sessionFamily(key, phone, prefix)
      if (!family) continue
      let group = groups.get(family); if (!group) { group = { count: 0, sample: [] }; groups.set(family, group) }
      group.count++
      if (group.sample.length < maximum) group.sample.push(key)
      else { const n = Math.floor(Math.random() * group.count); if (n < maximum) group.sample[n] = key }
    }
    scanComplete = cursor === 0
  } while (!scanComplete && pages < maxPages && seen.size < 30000 && Date.now() - started < budget)
  const expansion = scanComplete ? 1 : databaseKeys / Math.max(1, seen.size)
  const families: Array<{ family: string; observedKeys: number; sampledKeys: number; estimatedKeys: number; estimatedBytes: number }> = []
  let sampledKeys = 0
  for (const [family, group] of groups) {
    let sum = 0, n = 0
    for (let offset = 0; offset < group.sample.length; offset += 20) {
      if (Date.now() - started >= budget) break
      const values = await Promise.all(group.sample.slice(offset, offset + 20).map(key => redis.sendCommand(['MEMORY', 'USAGE', key, 'SAMPLES', '5'])))
      for (const value of values) if (typeof value === 'number' && value > 0) { sum += value; n++ }
    }
    const estimatedKeys = Math.round(group.count * expansion); sampledKeys += n
    families.push({ family, observedKeys: group.count, sampledKeys: n, estimatedKeys, estimatedBytes: n ? Math.round(sum / n * estimatedKeys) : 0 })
  }
  return { backend: 'redis' as const, estimated: true, partial: !scanComplete || families.some(f => !f.sampledKeys), scanComplete, scannedKeys: seen.size, databaseKeys, sampledKeys, elapsedMs: Date.now() - started,
    estimatedBytes: families.reduce((sum, family) => sum + family.estimatedBytes, 0), families,
    note: 'Bounded SCAN and MEMORY USAGE sample; excludes Redis global overhead and is not per-session resident RAM.' }
}

async function fileBytes(path: string) { return stat(path).then(value => value.size, error => { if (error.code === 'ENOENT') return 0; throw error }) }

async function sqliteFileMetrics(path: string) {
  const [databaseBytes, walBytes, shmBytes] = await Promise.all([fileBytes(path), fileBytes(path + '-wal'), fileBytes(path + '-shm')])
  return { databaseBytes, walBytes, shmBytes }
}

/** SQL reads only numeric lengths/counts. Full payloads and credentials never leave SQLite. */
export async function measureSqliteSession(phone: string, config: Pick<Config, 'baseStore' | 'sessionStorage'>) {
  validateSessionPhone(phone)
  const path = getSessionSqlitePath(phone, config)
  if (!await fileBytes(path)) throw new SessionStorageError(409, 'session_storage_database_missing')
  const { DatabaseSync } = module.require('node:sqlite'), db = new DatabaseSync(path, { readOnly: true })
  const start = Date.now(), tables: Array<{ table: string; records: number; sampledRecords: number; estimatedLogicalBytes: number }> = []
  let partial = false
  try {
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version
    assertSqliteWalSafeVersion(sqliteVersion)
    db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-1024; PRAGMA mmap_size=0;')
    const names: string[] = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 60").all().map((row: any) => row.name)
    for (const table of names) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,80}$/.test(table) || Date.now() - start > 1500) { partial = true; continue }
      const columns = db.prepare(`PRAGMA table_info('${table}')`).all().map((row: any) => row.name).filter((name: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,80}$/.test(name))
      const records = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n)
      if (!columns.length) continue
      const expression = columns.map((column: string) => `COALESCE(length(CAST("${column}" AS BLOB)),0)`).join('+')
      const lengths = db.prepare(`SELECT ${expression} AS bytes FROM "${table}" LIMIT 200`).all()
      tables.push({ table, records, sampledRecords: lengths.length, estimatedLogicalBytes: lengths.length ? Math.round(lengths.reduce((sum: number, row: any) => sum + row.bytes, 0) / lengths.length * records) : 0 })
    }
    return { backend: 'sqlite' as const, partial, measuredAt: Date.now(),
      files: await sqliteFileMetrics(path), fileSampledAt: Date.now(),
      pages: { count: db.prepare('PRAGMA page_count').get().page_count, sizeBytes: db.prepare('PRAGMA page_size').get().page_size, free: db.prepare('PRAGMA freelist_count').get().freelist_count },
      sqliteEngine: 'node:sqlite', sqliteVersion,
      cacheBudgetBytes: 1024 * 1024, cacheBudgetIsMeasurement: false,
      cacheBudget: { unoBytes: 1024 * 1024, sdkBytes: 0, sharedConnection: true, soft: true, measuredUsage: false },
      estimatedLogicalBytes: tables.reduce((sum, table) => sum + table.estimatedLogicalBytes, 0), records: tables.reduce((sum, table) => sum + table.records, 0), tables,
      note: 'File sizes are measured; logical bytes are sampled estimates, not RAM. Uno and SDK share one patched Node SQLite connection and a soft 1 MiB cache budget; this is not observed RSS or a per-session total RAM ceiling.' }
  } finally { db.close() }
}

type MetricsDependencies = { redis?: StorageMetricsRedis; sharedSessionCount?: () => number; cgroup?: CgroupMemoryReader }

async function sampleWorker(dependencies: MetricsDependencies) {
  const memory = process.memoryUsage()
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external,
    sampledAt: Date.now(), sharedSessionCount: dependencies.sharedSessionCount?.() ?? module.require('../client').clients.size, sharedProcess: true, attributedToSession: false,
    container: await readCgroupMemoryMetrics(dependencies.cgroup) }
}

export async function snapshotStorageMetrics(phone: string, config: Config, dependencies: MetricsDependencies = {}) {
  validateSessionPhone(phone)
  if (config.sessionStorage?.fixture && config.sessionStorage.backend !== 'sqlite' && !dependencies.redis) throw new SessionStorageError(409, 'session_storage_fixture_external_access_blocked')
  const worker = await sampleWorker(dependencies)
  const selected = config.sessionStorage?.backend || 'redis'
  if (selected === 'sqlite') {
    const baseStore = config.sessionStorage?.fixture ? config.baseStore : storageRoot()
    return { phone, worker, storage: await measureSqliteSession(phone, { ...config, baseStore }), sampledAt: Date.now() }
  }
  const redis = dependencies.redis || await module.require('../redis').getRedis()
  return { phone, worker, storage: await measureRedisSession(redis, phone), sampledAt: Date.now() }
}

async function refreshLiveMetrics(value: StorageMetricsSnapshot, config: Config, dependencies: MetricsDependencies) {
  const now = Date.now()
  const worker = await sampleWorker(dependencies)
  let storage = value.storage
  if (value.storage.backend === 'sqlite') {
    const files = await sqliteFileMetrics(getSessionSqlitePath(value.phone, { ...config, baseStore: config.sessionStorage?.fixture ? config.baseStore : storageRoot() }))
    if (!files.databaseBytes) throw new SessionStorageError(409, 'session_storage_database_missing')
    storage = { ...value.storage, files, fileSampledAt: Date.now() }
  }
  return { ...value, worker, storage, storageSampledAt: value.sampledAt, sampledAt: now }
}

/** Storage queries/sample at most once/minute; worker memory and O(1) file stats refresh on each poll. */
export async function getStorageMetrics(phone: string, config: Config, dependencies: MetricsDependencies = {}) {
  validateSessionPhone(phone)
  const key = `${phone}:${config.sessionStorage?.backend || 'redis'}:${config.sessionStorage?.storageId || 'legacy'}:${config.sessionStorage?.generation || 0}`
  const old = cache.get(key); if (old && old.expires > Date.now()) return refreshLiveMetrics(old.value, config, dependencies)
  const pending = inFlight.get(key); if (pending) return refreshLiveMetrics(await pending, config, dependencies)
  const promise = snapshotStorageMetrics(phone, config, dependencies).then(value => {
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(key, { expires: Date.now() + CACHE_MS, value }); return value
  }).finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise); return refreshLiveMetrics(await promise, config, dependencies)
}

/** Historical samples are retained as metrics only, never session payloads or filesystem paths. */
export async function saveStorageMetricsSnapshot(redis: SessionStorageRedis, phone: string, operationId: string, phase: 'before' | 'after', metrics: Awaited<ReturnType<typeof snapshotStorageMetrics>>) {
  validateSessionPhone(phone)
  if (!/^[0-9a-f-]{36}$/i.test(operationId) || !['before', 'after'].includes(phase) || metrics.phone !== phone) throw new SessionStorageError(400, 'session_storage_metrics_scope_invalid')
  const key = `unoapi-session-storage:metrics:${phone}:${operationId}:${phase}`
  await redis.eval("redis.call('SET',KEYS[1],ARGV[1],'EX',604800); redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1", { keys: [key, `unoapi-session-storage:metrics:${phone}:latest`], arguments: [JSON.stringify(metrics), operationId] })
}

export async function getStorageMetricsComparison(redis: SessionStorageRedis, phone: string) {
  validateSessionPhone(phone)
  const operationId = await redis.get(`unoapi-session-storage:metrics:${phone}:latest`)
  if (!operationId || !/^[0-9a-f-]{36}$/i.test(operationId)) return { before: null, after: null }
  const values = await Promise.all(['before', 'after'].map(phase => redis.get(`unoapi-session-storage:metrics:${phone}:${operationId}:${phase}`)))
  return { operationId, before: values[0] ? JSON.parse(values[0]) : null, after: values[1] ? JSON.parse(values[1]) : null }
}
