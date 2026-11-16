import { CpuUsageDelta, ProcessCpuSampler } from '../../src/services/resource_metrics/cpu'
import { aggregatePoints, pointOf } from '../../src/services/resource_metrics/types'
import { sampleRedis, normalizeVoipResourceSample } from '../../src/services/resource_metrics/sampler'
import { resourceTotal } from '../../src/services/resource_metrics/store'

test('CPU uses monotonic deltas, permits multicore and resets on restarts, invalid data or source change', () => {
  let at = 0; const cpu = new CpuUsageDelta(() => at)
  expect(cpu.read(1000000, 'container')).toBeUndefined()
  at = 1000; expect(cpu.read(3500000, 'container')).toBe(250)
  at = 2000; expect(cpu.read(3500000, 'container')).toBe(0)
  at = 3000; expect(cpu.read(10, 'container')).toBeUndefined()
  at = 4000; expect(cpu.read(100010, 'process')).toBeUndefined()
  expect(cpu.read(100010, 'process')).toBeUndefined()
  at = 5000; expect(cpu.read(NaN, 'process')).toBeUndefined()
  at = 6000; expect(cpu.read(1, 'process')).toBeUndefined()
})

test('process CPU uses cgroup totals including children, with explicit process fallback', async () => {
  const read = jest.fn().mockResolvedValue('usage_usec 1000000\nuser_usec 100000\n')
  const cpu = new ProcessCpuSampler(read)
  expect(await cpu.sample(true)).toEqual({ cpuSource: 'container', cpuPercent: undefined, cpuMaxPercent: undefined })
  read.mockResolvedValueOnce('malformed'); expect((await cpu.sample(true)).cpuSource).toBe('process')
  read.mockRejectedValueOnce(new Error('not supported')); expect((await cpu.sample(true)).cpuSource).toBe('process')
  expect((await cpu.sample(false)).cpuSource).toBe('process'); expect(read).toHaveBeenCalledTimes(3)
})

test('CPU rollups preserve fractional means, peaks and known sample weights through old missing samples', () => {
  const first = aggregatePoints([pointOf({ t: 1, n: 1 }), pointOf({ t: 2, n: 1, cpuPercent: 12.25 })], 0)
  expect(first).toMatchObject({ n: 2, cpuN: 1, cpuPercent: 12.25, cpuMaxPercent: 12.25, cpuPartial: true })
  const combined = aggregatePoints([first, pointOf({ t: 3, n: 1, cpuPercent: 100.5 })], 0)
  expect(combined).toMatchObject({ n: 3, cpuN: 2, cpuPercent: 56.38, cpuMaxPercent: 100.5 })
  expect(aggregatePoints([{ t: 1, n: 1 }], 0).cpuPercent).toBeUndefined()
})

test('Redis CPU measures server counters rather than telemetry requests and tolerates restricted INFO cpu', async () => {
  let at = 0, seconds = 2
  const redis = { sendCommand: jest.fn(async (args: string[]) => args[0] === 'DBSIZE' ? 1 : args[1] === 'memory' ? 'used_memory_rss:100\n' : args[1] === 'cpu' ? `used_cpu_user:${seconds}\nused_cpu_sys:1\n` : '') }
  const cpu = new CpuUsageDelta(() => at)
  expect((await sampleRedis(redis, 'test', cpu)).cpuPercent).toBeUndefined()
  at = 1000; seconds = 4; expect((await sampleRedis(redis, 'test', cpu)).cpuPercent).toBe(200)
  redis.sendCommand.mockImplementation(async args => { if (args[1] === 'cpu') throw new Error('restricted'); return args[1] === 'memory' ? 'used_memory_rss:100\n' : 1 })
  expect(await sampleRedis(redis, 'test', cpu)).toMatchObject({ ramBytes: 100, cpuPercent: undefined })
})

test('CPU totals deduplicate containers independently from RAM and flag missing/expired workers', () => {
  const base = { t: Date.now(), n: 1, kind: 'worker', memorySource: 'process-rss' as const, ramBytes: 10 }
  const rows = [{ ...base, id: 'a'.repeat(24), name: 'a', cpuGroup: 'shared', cpuPercent: 100 }, { ...base, id: 'b'.repeat(24), name: 'b', cpuGroup: 'shared', cpuPercent: 120 }, { ...base, id: 'c'.repeat(24), name: 'c', cpuPercent: 20.5 }]
  expect(resourceTotal(rows)).toMatchObject({ cpuPercent: 140.5, cpuPartial: false })
  expect(resourceTotal([...rows, { ...base, id: 'd'.repeat(24), name: 'd' }])).toMatchObject({ cpuPercent: 140.5, cpuPartial: true })
  expect(resourceTotal([{ ...rows[0], t: Date.now() - 200000 }])).toMatchObject({ cpuPercent: undefined, cpuPartial: true })
})

test('optional VoIP CPU fields are numeric-only, bounded below and backwards compatible', () => {
  const sample = { id: 'a'.repeat(24), kind: 'voip', t: Date.now(), ramBytes: 100, cpuPercent: 250.5, cpuMaxPercent: 300, cpuGroup: 'b'.repeat(24), cpuSource: 'container' }
  expect(normalizeVoipResourceSample(sample)).toMatchObject({ cpuPercent: 250.5, cpuMaxPercent: 300, cpuSource: 'container', cpuGroup: 'b'.repeat(24) })
  expect(normalizeVoipResourceSample({ ...sample, cpuPercent: -1, cpuMaxPercent: Infinity }).cpuPercent).toBeUndefined()
  expect(normalizeVoipResourceSample({ ...sample, cpuPercent: '250' }).cpuPercent).toBeUndefined()
})
