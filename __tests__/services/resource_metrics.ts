import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureDisk } from '../../src/services/resource_metrics/disk'
import { ResourceArchive, MetricsObjects } from '../../src/services/resource_metrics/archive'
import { ResourceMetricsQuery } from '../../src/services/resource_metrics/query'
import { ResourceMetricsStore, resourceTotal } from '../../src/services/resource_metrics/store'
import { aggregatePoints, BUFFER_LIMIT, ResourceSample } from '../../src/services/resource_metrics/types'
import { normalizeVoipResourceSample, ProcessResourceSampler, resourceId, sampleRedis } from '../../src/services/resource_metrics/sampler'

const sample = (t = Date.now(), ramBytes = 100): ResourceSample => ({ id: 'a'.repeat(24), name: 'worker', kind: 'worker', t, n: 1, ramBytes, ramMaxBytes: ramBytes, rssBytes: ramBytes, diskBytes: 20, memorySource: 'process-rss' })
const objects = () => {
  const values = new Map<string, any>()
  const store: MetricsObjects = { get: jest.fn(async key => structuredClone(values.get(key))), put: jest.fn(async (key, value) => { values.set(key, structuredClone(value)) }), indexes: jest.fn(async () => [...values.keys()].filter(k => k.startsWith('index/')).map(k => k.slice(6, -5))) }
  return { values, store }
}

test('rollups preserve weighted mean, peak, last disk and unknown readings', () => {
  const value = aggregatePoints([{ t: 1, n: 2, ramBytes: 100, ramMaxBytes: 180, diskBytes: 200, diskMaxBytes: 200 }, { t: 2, n: 1, ramBytes: 400, ramMaxBytes: 400, diskBytes: 180, diskMaxBytes: 180 }], 0)
  expect(value).toMatchObject({ n: 3, ramBytes: 200, ramMaxBytes: 400, diskBytes: 180, diskMaxBytes: 200 })
  expect(aggregatePoints([{ t: 1, n: 1 }], 0).ramBytes).toBeUndefined()
})

test('totals exclude expired readings and deduplicate a unified container', () => {
  const rows = [{ ...sample(), memoryGroup: 'shared' }, { ...sample(), id: 'b'.repeat(24), ramBytes: 150, memoryGroup: 'shared', kind: 'voip' }, { ...sample(), id: 'c'.repeat(24), kind: 'redis' }, sample(Date.now() - 200000)]
  expect(resourceTotal(rows)).toMatchObject({ ramBytes: 250, partial: true })
  expect(resourceTotal([]).ramBytes).toBeUndefined()
})

test('archives replay idempotently and retain minute/hour/day/month history', async () => {
  const { values, store } = objects(), archive = new ResourceArchive(store), base = Date.UTC(2026, 10, 10, 12)
  const points = [{ ...sample(base, 100), cpuPercent: 12.5, cpuMaxPercent: 12.5 }, { ...sample(base + 60000, 300), cpuPercent: 250, cpuMaxPercent: 250 }]
  await archive.save(points); await archive.save(points)
  expect(values.get(`${points[0].id}/hours/2026-11-10T12.json`).points).toHaveLength(2)
  expect(values.get(`${points[0].id}/days/2026-11-10.json`).points[0]).toMatchObject({ n: 2, ramBytes: 200, ramMaxBytes: 300 })
  expect(values.get(`${points[0].id}/months/2026-11.json`).points[0]).toMatchObject({ cpuN: 2, cpuPercent: 131.25, cpuMaxPercent: 250 })
  expect((await archive.index(points[0].id))?.points[0]).toMatchObject({ cpuN: 2, cpuPercent: 131.25, cpuMaxPercent: 250 })
  expect((await archive.index(points[0].id))?.points).toHaveLength(1)
})

test('archive failure is explicit and does not acknowledge Redis data', async () => {
  const { store } = objects(); (store.put as jest.Mock).mockRejectedValueOnce(new Error('s3 down'))
  await expect(new ResourceArchive(store).save([sample()])).rejects.toThrow('s3 down')
})

test('Redis failure falls back to S3 with original timestamp and never labels it live', async () => {
  const { store } = objects(), archive = new ResourceArchive(store), old = sample(Date.now() - 600000)
  await archive.save([old])
  const query = new ResourceMetricsQuery({ stack: 'test', samples: jest.fn().mockRejectedValue(new Error('redis down')) } as any, archive)
  const value = await query.current()
  expect(value.redisUnavailable).toBe(true)
  expect(value.components[0]).toMatchObject({ id: old.id, t: old.t, source: 's3', live: false, ramBytes: 100 })
})

test('missing Redis sample is recovered from S3 even when Redis itself works', async () => {
  const { store } = objects(), archive = new ResourceArchive(store)
  await archive.save([sample()])
  const query = new ResourceMetricsQuery({ stack: 'test', samples: async () => [] } as any, archive)
  expect((await query.current()).components[0]).toMatchObject({ source: 's3', live: false })
})

test('RabbitMQ metrics and free disk history survive S3 fallback, or remain visibly missing without access', async () => {
  const { store } = objects(), archive = new ResourceArchive(store)
  const rabbit = { ...sample(), kind: 'rabbitmq', memorySource: 'rabbitmq-node' as const, diskBytes: undefined, diskFreeBytes: 500, rabbitMessagesReady: 3 }
  await archive.save([rabbit])
  const query = new ResourceMetricsQuery({ stack: 'test', samples: async () => { throw new Error('redis down') }, buffer: async () => [] } as any, archive, false, true)
  expect((await query.current()).components.find(s => s.kind === 'rabbitmq')).toMatchObject({ source: 's3', live: false, diskFreeBytes: 500, rabbitMessagesReady: 3 })
  expect((await query.history(rabbit.id, 'max')).points[0]).toMatchObject({ diskFreeBytes: 500, diskFreeMinBytes: 500 })
  const missing = new ResourceMetricsQuery({ stack: 'test', samples: async () => [] } as any, new ResourceArchive(), false, true)
  const row = (await missing.current()).components[0]
  expect(row).toMatchObject({ kind: 'rabbitmq', live: false }); expect(row.ramBytes).toBeUndefined()
})

test('VoIP container recreation shows only the newest instance without deleting its prior history', async () => {
  const { store } = objects(), archive = new ResourceArchive(store), now = Date.now()
  const old = { ...sample(now - 240000), kind: 'voip', cpuPercent: 10 }, current = { ...sample(now), id: 'b'.repeat(24), kind: 'voip', cpuPercent: 20 }
  await archive.save([old])
  const query = new ResourceMetricsQuery({ stack: 'test', samples: async () => [old, current] } as any, archive, true)
  const value = await query.current()
  expect(value.components.filter(s => s.kind === 'voip')).toHaveLength(1)
  expect(value.components.find(s => s.kind === 'voip')?.id).toBe(current.id)
  expect(value.components.find(s => s.kind === 'total')).toMatchObject({ cpuPercent: 20, cpuPartial: false })
  expect((await archive.index(old.id))?.sample.id).toBe(old.id)
})

test('all periods recover S3 history without Redis; invalid scope is rejected', async () => {
  const { store } = objects(), archive = new ResourceArchive(store), now = Date.now()
  await archive.save([sample(now - 60000), sample(now - 600000)])
  const query = new ResourceMetricsQuery({ stack: 'test', buffer: async () => { throw new Error('redis down') } } as any, archive)
  for (const range of ['1d', '7d', '30d', '90d', 'max'] as const) {
    const value = await query.history(sample().id, range)
    expect(value.points.length).toBeGreaterThan(0); expect(value.points.length).toBeLessThanOrEqual(600)
    expect(value.warnings).toContain('redis_unavailable')
  }
  await expect(query.history('../secret', 'max')).rejects.toThrow('query_invalid')
})

test('recent-only history is visibly partial on S3 failure and does not invent zeroes', async () => {
  const { store } = objects(); (store.get as jest.Mock).mockRejectedValue(new Error('s3 down'))
  const query = new ResourceMetricsQuery({ buffer: async () => [sample()] } as any, new ResourceArchive(store))
  expect(await query.history(sample().id, '1d')).toMatchObject({ partial: true, warnings: ['s3_unavailable'], points: [expect.objectContaining({ ramBytes: 100 })] })
})

test('history accepts readings collected while an async query is running, but not arbitrary future dates', async () => {
  const now = Date.now(), query = new ResourceMetricsQuery({ buffer: async () => [sample(now + 100), sample(now + 120000)] } as any, new ResourceArchive())
  const value = await query.history(sample().id, '1d')
  expect(value.points).toHaveLength(1); expect(value.points[0].ramBytes).toBe(100)
})

test('Redis writes have a strict buffer bound, expiration, request cancellation and no keyspace scan', async () => {
  const redis = { isReady: true, sendCommand: jest.fn().mockResolvedValue(0) }, store = new ResourceMetricsStore(redis, 'test')
  await store.save(sample())
  const args = redis.sendCommand.mock.calls[0] as any[]
  expect(args[0][0]).toBe('EVAL'); expect(args[0][1]).toContain(`-${BUFFER_LIMIT + 1}`); expect(args[0][1]).toContain('EXPIRE')
  expect(args[1].signal).toBeInstanceOf(AbortSignal)
  redis.isReady = false
  await expect(store.samples()).rejects.toThrow('redis_unavailable')
  expect(redis.sendCommand).toHaveBeenCalledTimes(1)
})

test('identical history requests share work and at most eight distinct queries run at once', async () => {
  let finish!: (value: ResourceSample[]) => void
  const buffer = jest.fn(() => new Promise<ResourceSample[]>(resolve => { finish = resolve }))
  const query = new ResourceMetricsQuery({ buffer } as any, new ResourceArchive())
  const first = query.history(sample().id, '1d'), second = query.history(sample().id, '1d')
  expect(buffer).toHaveBeenCalledTimes(1)
  finish([sample()]); expect(await first).toEqual(await second)
  await query.history(sample().id, '1d'); expect(buffer).toHaveBeenCalledTimes(1)
  const blocked = new ResourceMetricsQuery({ buffer: () => new Promise(() => undefined) } as any, new ResourceArchive())
  for (let i = 0; i < 8; i++) void blocked.history(i.toString(16).padStart(24, '0'), 'max')
  await expect(blocked.history('f'.repeat(24), 'max')).rejects.toThrow('resource_metrics_busy')
})

test('Redis details distinguish resident RAM, logical allocation and AOF disk', async () => {
  const redis = { sendCommand: jest.fn(async (args: string[]) => args[0] === 'DBSIZE' ? 3 : args[1] === 'memory' ? 'used_memory:100\r\nused_memory_rss:200\r\nused_memory_peak:150\r\nmem_fragmentation_ratio:2.0\r\n' : 'aof_current_size:300\r\n') }
  expect(await sampleRedis(redis, 'test')).toMatchObject({ ramBytes: 200, redisUsedBytes: 100, diskBytes: 300, diskPartial: true, redisKeys: 3 })
})

test('VoIP sample whitelists numeric metrics and rejects unknown timestamps/measurements', () => {
  const input = { ...sample(), kind: 'voip', token: 'synthetic-secret-not-a-metric' }
  expect(normalizeVoipResourceSample(input)).not.toHaveProperty('token')
  expect(normalizeVoipResourceSample(input)).toMatchObject({ kind: 'voip', ramBytes: 100 })
  expect(() => normalizeVoipResourceSample({ ...input, ramBytes: undefined })).toThrow('sample_invalid')
  expect(() => normalizeVoipResourceSample({ ...input, t: Date.now() + 130000 })).toThrow('sample_invalid')
})

test('an explicit instance ID remains stable rather than appending the process PID', () => {
  const previous = process.env.RESOURCE_METRICS_INSTANCE_ID
  try {
    process.env.RESOURCE_METRICS_INSTANCE_ID = 'synthetic-stable-worker'
    expect(new ProcessResourceSampler('worker', []).id).toBe(resourceId('synthetic-stable-worker'))
  } finally {
    if (previous === undefined) delete process.env.RESOURCE_METRICS_INSTANCE_ID
    else process.env.RESOURCE_METRICS_INSTANCE_ID = previous
  }
})

test('disk measures file sizes, deduplicates nested roots, never reads contents and marks bounded scans partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-metrics-'))
  try {
    await mkdir(join(root, 'session')); await writeFile(join(root, 'session', 'data'), Buffer.alloc(1024))
    expect(await measureDisk([root, join(root, 'session')])).toMatchObject({ diskBytes: 1024, diskPartial: false })
    expect((await measureDisk([root], false, 1000, 1)).diskPartial).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
