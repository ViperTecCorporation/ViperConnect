import { ResourceArchive } from './archive'
import { ResourceMetricsStore, resourceTotal, currentResourceComponents } from './store'
import { resourceId } from './sampler'
import { aggregatePoints, METRIC_RANGES, MetricRange, ResourcePoint, ResourceSample, LIVE_MS, pointOf, validId } from './types'

type HistoryResult = { id: string; range: MetricRange; from: number; to: number; points: ResourcePoint[]; warnings: string[]; resolution: string; archiveEnabled: boolean; partial: boolean }

export class ResourceMetricsQuery {
  private catalog: ResourceSample[] = []
  private until = 0
  private catalogTask?: Promise<void>
  private histories = new Map<string, { until: number; value: HistoryResult }>()
  private historyTasks = new Map<string, Promise<HistoryResult>>()
  constructor(readonly store: ResourceMetricsStore, readonly archive: ResourceArchive, private readonly voipEnabled = false, private readonly rabbitEnabled = false) {}

  private async archivedSamples() {
    if (!this.archive.objects || Date.now() < this.until) return this.catalog
    if (!this.catalogTask) this.catalogTask = (async () => {
      const ids = await this.archive.objects!.indexes(), samples: ResourceSample[] = []
      for (let offset = 0; offset < ids.length; offset += 4) {
        const values = await Promise.all(ids.slice(offset, offset + 4).map(id => this.archive.index(id)))
        for (const value of values) if (value?.schema === 1 && validId(value.sample?.id)) samples.push(value.sample)
      }
      this.catalog = samples; this.until = Date.now() + 60000
    })().finally(() => { this.catalogTask = undefined })
    await this.catalogTask
    return this.catalog
  }

  async current() {
    let samples: ResourceSample[] = [], redisUnavailable = false, archiveUnavailable = false
    try { samples = await this.store.samples() } catch { redisUnavailable = true }
    const source = new Map(samples.map(sample => [sample.id, 'redis']))
    try {
      for (const sample of await this.archivedSamples()) {
        const existing = samples.find(row => row.id === sample.id)
        if (!existing || existing.t < sample.t) {
          samples = samples.filter(row => row.id !== sample.id).concat(sample); source.set(sample.id, 's3')
        }
      }
    } catch { archiveUnavailable = true; this.until = Date.now() + 30000 }
    if (this.voipEnabled && !samples.some(row => row.kind === 'voip')) samples.push({
      id: resourceId(this.store.stack + ':voip-unavailable'), name: 'VoIP', kind: 'voip', t: 0, n: 0, memorySource: 'process-rss',
    })
    if (this.rabbitEnabled && !samples.some(row => row.kind === 'rabbitmq')) samples.push({
      id: resourceId(this.store.stack + ':rabbitmq'), name: 'RabbitMQ', kind: 'rabbitmq', t: 0, n: 0, memorySource: 'rabbitmq-node',
    })
    const current = currentResourceComponents(samples), currentIds = new Set(current.map(sample => sample.id))
    const historicalComponents = samples.filter(sample => sample.kind !== 'total' && !currentIds.has(sample.id))
      .map(sample => ({ ...sample, source: source.get(sample.id), live: false }))
    samples = current
    const live = samples.filter(sample => source.get(sample.id) === 'redis' && Date.now() - sample.t < LIVE_MS && sample.kind !== 'total')
    if (live.length) {
      const total = resourceTotal(samples.filter(sample => source.get(sample.id) === 'redis'))
      total.partial = total.partial || samples.some(s => s.kind !== 'total' && !live.some(row => row.id === s.id))
      total.cpuPartial = total.cpuPartial || samples.some(s => s.kind !== 'total' && !live.some(row => row.id === s.id))
      samples = samples.filter(sample => sample.kind !== 'total').concat(total); source.set(total.id, 'redis')
    }
    return { sampledAt: Date.now(), intervalSeconds: 60, redisUnavailable, archiveUnavailable,
      archiveEnabled: !!this.archive.objects, prefix: `metrics/v1/${this.store.stack}/`,
      historicalComponents,
      components: samples.map(sample => ({ ...sample, source: source.get(sample.id), live: sample.ramBytes !== undefined && source.get(sample.id) === 'redis' && Date.now() - sample.t < LIVE_MS })) }
  }

  async history(id: string, range: MetricRange) {
    if (!validId(id) || !METRIC_RANGES.includes(range)) throw new Error('resource_metrics_query_invalid')
    const key = `${id}:${range}`, cached = this.histories.get(key)
    if (cached && cached.until > Date.now()) return cached.value
    const running = this.historyTasks.get(key)
    if (running) return running
    if (this.historyTasks.size >= 8) throw new Error('resource_metrics_busy')
    const task = this.readHistory(id, range).then(value => {
      this.histories.delete(key); this.histories.set(key, { until: Date.now() + 15000, value })
      while (this.histories.size > 8) this.histories.delete(this.histories.keys().next().value!)
      return value
    }).finally(() => this.historyTasks.delete(key))
    this.historyTasks.set(key, task)
    return task
  }

  private async readHistory(id: string, range: MetricRange): Promise<HistoryResult> {
    const now = Date.now(), days = ({ '1d': 1, '7d': 7, '30d': 30, '90d': 90 } as const)[range]
    const from = days ? now - days * 86400000 : 0, warnings: string[] = []
    let archived: ResourcePoint[] = [], cutoff = 0
    if (this.archive.objects) try {
      const index = await this.archive.index(id); cutoff = index?.sample.t || 0
      if (range === 'max') archived = index?.points || []
      else {
        const step = range === '1d' ? 3600000 : 86400000
        const keys = new Set<string>()
        for (let time = Math.floor(Math.max(from, index?.firstAt || from) / step) * step; time <= now; time += step) {
          const iso = new Date(time).toISOString()
          keys.add(`${id}/${range === '1d' ? 'hours/' + iso.slice(0, 13) : range === '90d' ? 'months/' + iso.slice(0, 7) : 'days/' + iso.slice(0, 10)}.json`)
        }
        const files = [...keys]
        for (let offset = 0; offset < files.length; offset += 4) {
          const values = await Promise.all(files.slice(offset, offset + 4).map(key => this.archive.objects!.get(key)))
          for (const value of values) if (value?.schema === 1) archived.push(...value.points)
        }
      }
    } catch { warnings.push('s3_unavailable') }
    else warnings.push('s3_not_configured')
    let recent: ResourceSample[] = []
    try { recent = await this.store.buffer(id) } catch { warnings.push('redis_unavailable') }
    if (warnings.includes('s3_unavailable')) { archived = []; cutoff = 0 }
    const step = range === '1d' ? 60000 : range === '7d' || range === '30d' ? 3600000 : 86400000
    const bucketTime = (t: number) => range === 'max' ? Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1) : Math.floor(t / step) * step
    const covered = new Map(archived.map(p => [bucketTime(p.t), p.end || p.t]))
    const grouped = new Map<number, ResourcePoint[]>()
    for (const point of [...archived, ...recent.filter(p => p.t > Math.max(cutoff, covered.get(bucketTime(p.t)) || 0)).map(pointOf)]) {
      // An async read can return a sample taken after request start; tolerate
      // normal clock skew, not arbitrary future timestamps.
      if (point.t + step < from || point.t > now + 60000 || !Number.isFinite(point.t)) continue
      const t = bucketTime(point.t)
      grouped.set(t, [...grouped.get(t) || [], point])
    }
    let points = [...grouped].map(([t, values]) => aggregatePoints(values, t)).sort((a, b) => a.t - b.t)
    if (points.length > 600) {
      const size = Math.ceil(points.length / 600), reduced: ResourcePoint[] = []
      for (let i = 0; i < points.length; i += size) reduced.push(aggregatePoints(points.slice(i, i + size), points[i].t))
      points = reduced
    }
    return { id, range, from: from || points[0]?.t || now, to: now, points, warnings,
      resolution: range === 'max' ? 'month' : range === '90d' ? 'day' : range === '1d' ? 'minute' : 'hour',
      archiveEnabled: !!this.archive.objects, partial: warnings.length > 0 || points.some(p => p.partial) }
  }
}
