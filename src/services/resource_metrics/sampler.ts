import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readCgroupMemoryMetrics } from '../session_storage/metrics'
import { measureDisk, DiskMeasurement } from './disk'
import type { ResourceSample } from './types'
import { CpuUsageDelta, ProcessCpuSampler } from './cpu'

export const resourceId = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 24)
export const inContainer = () => existsSync('/.dockerenv') || existsSync('/run/.containerenv')

/** Only measurement fields cross from the optional service into Redis/S3. */
export function normalizeVoipResourceSample(value: any): ResourceSample {
  if (!value || value.kind !== 'voip' || !/^[a-f0-9]{24}$/.test(value.id) || !Number.isFinite(value.ramBytes) || value.ramBytes < 0 || !Number.isFinite(value.t) || Math.abs(Date.now() - value.t) > 120000) throw new Error('resource_metrics_voip_sample_invalid')
  const sample: ResourceSample = { id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 160) : 'VoIP', kind: 'voip', t: value.t, n: 1,
    memorySource: value.memorySource === 'container-working-set' ? 'container-working-set' : 'process-rss' }
  for (const field of ['ramBytes', 'ramMaxBytes', 'cpuPercent', 'cpuMaxPercent', 'rssBytes', 'heapUsedBytes', 'externalBytes', 'containerBytes', 'cacheBytes', 'limitBytes', 'diskBytes', 'diskMaxBytes', 'diskSampledAt', 'fsUsedBytes', 'fsTotalBytes'] as const) {
    if (Number.isFinite(value[field]) && value[field] >= 0) sample[field] = value[field]
  }
  for (const field of ['diskPartial', 'diskShared', 'partial'] as const) if (typeof value[field] === 'boolean') sample[field] = value[field]
  if (/^[a-f0-9]{24}$/.test(value.memoryGroup || '')) sample.memoryGroup = value.memoryGroup
  if (/^[a-f0-9]{24}$/.test(value.cpuGroup || '')) sample.cpuGroup = value.cpuGroup
  if (value.cpuSource === 'container' || value.cpuSource === 'process') sample.cpuSource = value.cpuSource
  return sample
}

export class ProcessResourceSampler {
  private readonly cpu = new ProcessCpuSampler()
  private disk?: DiskMeasurement
  private diskUntil = 0
  private diskTask?: Promise<DiskMeasurement>
  readonly id: string
  constructor(private readonly role: string, private readonly roots: string[], private readonly name = process.env.RESOURCE_METRICS_INSTANCE_ID || `${process.env.UNOAPI_SERVER_NAME || 'server_1'} · ${role} · ${hostname()}`) {
    this.id = resourceId(process.env.RESOURCE_METRICS_INSTANCE_ID || `${name}:${inContainer() ? '' : process.pid}`)
  }
  async sample(): Promise<ResourceSample> {
    const now = Date.now(), memory = process.memoryUsage(), container = inContainer() ? await readCgroupMemoryMetrics() : undefined
    const cpu = await this.cpu.sample(inContainer())
    if (now >= this.diskUntil && !this.diskTask) {
      this.diskTask = measureDisk(this.roots, this.role !== 'voip').then(value => {
        this.disk = value; this.diskUntil = Date.now() + 10 * 60000; return value
      }).finally(() => { this.diskTask = undefined })
    }
    if (this.diskTask) await this.diskTask
    const ramBytes = container ? Math.max(0, container.currentBytes - (container.inactiveFileBytes || 0)) : memory.rss
    return { id: this.id, name: this.name, kind: this.role, t: now, n: 1, ramBytes, ramMaxBytes: ramBytes,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
      containerBytes: container?.currentBytes, cacheBytes: container?.fileBytes, limitBytes: container?.limitBytes,
      memoryGroup: container ? resourceId('container:' + hostname()) : undefined,
      memorySource: container ? 'container-working-set' : 'process-rss', ...cpu,
      cpuGroup: cpu.cpuSource === 'container' ? resourceId('container:' + hostname()) : undefined,
      ...this.disk, partial: this.disk?.diskPartial }
  }
}

export async function sampleRedis(redis: { sendCommand(args: string[]): Promise<any> }, stack: string, cpu?: CpuUsageDelta): Promise<ResourceSample> {
  const text = await redis.sendCommand(['INFO', 'memory']), persistence = await redis.sendCommand(['INFO', 'persistence'])
  let cpuInfo = ''
  try { cpuInfo = await redis.sendCommand(['INFO', 'cpu']) } catch { /* RAM/disk remain available if INFO cpu is restricted. */ }
  const fields = new Map<string, number>()
  for (const line of `${text}\n${persistence}\n${cpuInfo}`.split('\n')) {
    const match = /^([a-z_]+):([\d.]+)/.exec(line)
    if (match) fields.set(match[1], Number(match[2]))
  }
  const rss = fields.get('used_memory_rss')
  if (rss === undefined) throw new Error('resource_metrics_redis_memory_unavailable')
  const disk = fields.get('aof_current_size')
  const user = fields.get('used_cpu_user'), system = fields.get('used_cpu_sys')
  const cpuPercent = cpu?.read(user === undefined || system === undefined ? NaN : (user + system) * 1000000, `${stack}:redis`)
  return { id: resourceId(`${stack}:redis`), name: 'Redis', kind: 'redis', t: Date.now(), n: 1,
    memorySource: 'redis-rss', ramBytes: rss, ramMaxBytes: rss, rssBytes: rss,
    cpuPercent, cpuMaxPercent: cpuPercent, cpuSource: 'redis-process',
    redisUsedBytes: fields.get('used_memory'), redisPeakBytes: fields.get('used_memory_peak'), redisFragmentation: fields.get('mem_fragmentation_ratio'),
    redisDatasetBytes: fields.get('used_memory_dataset'), redisOverheadBytes: fields.get('used_memory_overhead'),
    redisKeys: Number(await redis.sendCommand(['DBSIZE'])), diskBytes: disk, diskMaxBytes: disk,
    diskPartial: true, partial: true, diskSampledAt: Date.now() }
}
