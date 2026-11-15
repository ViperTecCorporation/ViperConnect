export const METRIC_RANGES = ['1d', '7d', '30d', '90d', 'max'] as const
export type MetricRange = typeof METRIC_RANGES[number]
export const LIVE_MS = 180000
export const BUFFER_LIMIT = 120
export const COMPONENT_LIMIT = 128
export const validId = (id: string) => /^[a-f0-9]{24}$/.test(id)

export interface ResourcePoint {
  t: number
  n: number
  end?: number
  ramBytes?: number
  ramMaxBytes?: number
  cpuPercent?: number
  cpuMaxPercent?: number
  cpuN?: number
  cpuPartial?: boolean
  rssBytes?: number
  diskBytes?: number
  diskMaxBytes?: number
  diskFreeBytes?: number
  diskFreeMinBytes?: number
  partial?: boolean
}

export interface ResourceSample extends ResourcePoint {
  id: string
  name: string
  kind: string
  memoryGroup?: string
  cpuGroup?: string
  cpuSource?: 'container' | 'process' | 'redis-process' | 'rabbitmq-runtime' | 'sum'
  memorySource: 'container-working-set' | 'process-rss' | 'redis-rss' | 'rabbitmq-node'
  rabbitNodes?: number
  rabbitRunningNodes?: number
  rabbitMemoryAlarm?: boolean
  rabbitDiskAlarm?: boolean
  rabbitMemoryStrategy?: string
  rabbitMemoryLimitBytes?: number
  rabbitDiskFreeLimitBytes?: number
  rabbitQueues?: number
  rabbitConnections?: number
  rabbitChannels?: number
  rabbitConsumers?: number
  rabbitMessagesReady?: number
  rabbitMessagesUnacked?: number
  rabbitPublishRate?: number
  rabbitDeliverRate?: number
  heapUsedBytes?: number
  externalBytes?: number
  containerBytes?: number
  cacheBytes?: number
  limitBytes?: number
  redisUsedBytes?: number
  redisPeakBytes?: number
  redisFragmentation?: number
  redisKeys?: number
  redisDatasetBytes?: number
  redisOverheadBytes?: number
  diskPartial?: boolean
  diskShared?: boolean
  diskSampledAt?: number
  fsUsedBytes?: number
  fsTotalBytes?: number
  archiveState?: 'ready' | 'disabled' | 'error'
  archivedAt?: number
  droppedPoints?: number
}

export interface ResourceIndex {
  schema: 1
  firstAt?: number
  sample: ResourceSample
  points: ResourcePoint[]
}

export const pointOf = (sample: ResourcePoint): ResourcePoint => ({
  t: sample.t, end: sample.end || sample.t, n: sample.n, ramBytes: sample.ramBytes, ramMaxBytes: sample.ramMaxBytes ?? sample.ramBytes,
  rssBytes: sample.rssBytes, diskBytes: sample.diskBytes, diskMaxBytes: sample.diskMaxBytes ?? sample.diskBytes, partial: sample.partial,
  cpuPercent: sample.cpuPercent, cpuMaxPercent: sample.cpuMaxPercent ?? sample.cpuPercent, cpuN: sample.cpuPercent === undefined ? undefined : sample.cpuN ?? sample.n,
  cpuPartial: sample.cpuPartial,
  diskFreeBytes: sample.diskFreeBytes, diskFreeMinBytes: sample.diskFreeMinBytes ?? sample.diskFreeBytes,
})

/** Weighted means/maxima; disk is the last observed size, not bytes written. */
export function aggregatePoints(points: ResourcePoint[], time: number): ResourcePoint {
  const sorted = [...points].sort((a, b) => a.t - b.t), n = sorted.reduce((sum, p) => sum + p.n, 0)
  const average = (field: 'ramBytes' | 'rssBytes') => {
    const known = sorted.filter(p => typeof p[field] === 'number'), count = known.reduce((sum, p) => sum + p.n, 0)
    return count ? Math.round(known.reduce((sum, p) => sum + p[field]! * p.n, 0) / count) : undefined
  }
  const max = (field: 'ramMaxBytes' | 'diskMaxBytes' | 'cpuMaxPercent') => {
    const values = sorted.map(p => p[field]).filter((v): v is number => typeof v === 'number')
    return values.length ? Math.max(...values) : undefined
  }
  const cpuKnown = sorted.filter(p => typeof p.cpuPercent === 'number'), cpuN = cpuKnown.reduce((sum, p) => sum + (p.cpuN ?? p.n), 0)
  return { t: time, end: Math.max(...sorted.map(p => p.end || p.t)), n, ramBytes: average('ramBytes'), rssBytes: average('rssBytes'), ramMaxBytes: max('ramMaxBytes'),
    cpuPercent: cpuN ? Math.round(cpuKnown.reduce((sum, p) => sum + p.cpuPercent! * (p.cpuN ?? p.n), 0) / cpuN * 100) / 100 : undefined,
    cpuMaxPercent: max('cpuMaxPercent'), cpuN: cpuN || undefined,
    cpuPartial: cpuN ? sorted.some(p => p.cpuPartial || p.cpuPercent === undefined) : undefined,
    diskFreeBytes: sorted.filter(p => p.diskFreeBytes !== undefined).at(-1)?.diskFreeBytes,
    diskFreeMinBytes: sorted.some(p => p.diskFreeMinBytes !== undefined) ? Math.min(...sorted.map(p => p.diskFreeMinBytes).filter((v): v is number => typeof v === 'number')) : undefined,
    diskBytes: sorted.filter(p => p.diskBytes !== undefined).at(-1)?.diskBytes, diskMaxBytes: max('diskMaxBytes'), partial: sorted.some(p => p.partial) }
}
