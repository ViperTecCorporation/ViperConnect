import { resourceId } from './sampler'
import type { ResourceSample } from './types'

const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Whitelist cluster/node counters; never retain names, definitions or message data. */
export function rabbitResourceSample(snapshot: { nodes: any[]; overview: any }, stack: string): ResourceSample {
  const { nodes, overview } = snapshot
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 128) throw new Error('resource_metrics_rabbitmq_sample_invalid')
  const running = nodes.filter(node => node?.running === true)
  const known = (field: string) => running.map(node => node[field]).filter(numeric)
  const sum = (field: string) => { const values = known(field); return values.length ? values.reduce((a, b) => a + b, 0) : undefined }
  const minimum = (field: string) => { const values = known(field); return values.length ? Math.min(...values) : undefined }
  const ramBytes = sum('mem_used'), free = minimum('disk_free')
  const sample: ResourceSample = {
    id: resourceId(`${stack}:rabbitmq`), name: 'RabbitMQ', kind: 'rabbitmq', t: Date.now(), n: 1,
    memorySource: 'rabbitmq-node', ramBytes, ramMaxBytes: ramBytes,
    diskFreeBytes: free, diskFreeMinBytes: free, diskSampledAt: Date.now(),
    rabbitNodes: nodes.length, rabbitRunningNodes: running.length,
    rabbitMemoryAlarm: nodes.some(node => node?.mem_alarm === true), rabbitDiskAlarm: nodes.some(node => node?.disk_free_alarm === true),
    rabbitMemoryLimitBytes: sum('mem_limit'), rabbitDiskFreeLimitBytes: minimum('disk_free_limit'),
    partial: running.length !== nodes.length || known('mem_used').length !== running.length || known('disk_free').length !== running.length,
  }
  const strategy = new Set(running.map(node => node.mem_calculation_strategy))
  sample.rabbitMemoryStrategy = strategy.size === 1 && ['rss', 'allocated'].includes([...strategy][0]) ? [...strategy][0] : 'mixed-or-unknown'
  const fields = {
    rabbitQueues: overview?.object_totals?.queues, rabbitConnections: overview?.object_totals?.connections,
    rabbitChannels: overview?.object_totals?.channels, rabbitConsumers: overview?.object_totals?.consumers,
    rabbitMessagesReady: overview?.queue_totals?.messages_ready, rabbitMessagesUnacked: overview?.queue_totals?.messages_unacknowledged,
    rabbitPublishRate: overview?.message_stats?.publish_details?.rate, rabbitDeliverRate: overview?.message_stats?.deliver_get_details?.rate,
  }
  for (const field of Object.keys(fields) as (keyof typeof fields)[]) if (numeric(fields[field])) sample[field] = fields[field]
  return sample
}
