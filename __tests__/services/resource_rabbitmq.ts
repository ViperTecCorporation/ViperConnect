import { RabbitManagement } from '../../src/services/rabbitmq_management'
import { rabbitResourceSample } from '../../src/services/resource_metrics/rabbitmq'
import { aggregatePoints, pointOf } from '../../src/services/resource_metrics/types'
import { resourceTotal } from '../../src/services/resource_metrics/store'

const options = { baseUrl: 'http://rabbitmq:15672', username: 'synthetic', password: 'synthetic', vhost: '/', queuePrefix: 'test' }
const snapshot = () => ({ nodes: [{ name: 'rabbit@node', running: true, mem_used: 100, mem_limit: 1000, mem_alarm: false, mem_calculation_strategy: 'rss', disk_free: 500, disk_free_limit: 50, disk_free_alarm: false }], overview: {
  object_totals: { queues: 10, connections: 2, channels: 4, consumers: 8 }, queue_totals: { messages_ready: 3, messages_unacknowledged: 1 },
  message_stats: { publish_details: { rate: 2.5 }, deliver_get_details: { rate: 3.5 } },
} })

test('Rabbit monitoring uses two bounded-column GETs, never queue message retrieval or mutation', async () => {
  const value = snapshot(), fetcher = jest.fn(async (url: any) => new Response(JSON.stringify(`${url}`.includes('/api/nodes?') ? value.nodes : value.overview)))
  const manager = new RabbitManagement(options, fetcher as typeof fetch)
  expect(await manager.resourceSnapshot()).toEqual(value)
  expect(fetcher).toHaveBeenCalledTimes(2)
  for (const [url, init] of fetcher.mock.calls as any) {
    expect(url).toContain('?columns='); expect(url).not.toContain('/api/queues'); expect(init.method || 'GET').toBe('GET')
    expect(init.body).toBeUndefined(); expect(init.signal).toBeInstanceOf(AbortSignal)
  }
})

test('Rabbit permission errors and malformed snapshots are explicit, never successful zero measurements', async () => {
  await expect(new RabbitManagement(options, (async () => new Response('{}', { status: 403 })) as typeof fetch).resourceSnapshot()).rejects.toMatchObject({ status: 403 })
  await expect(new RabbitManagement(options, (async () => new Response('[]')) as typeof fetch).resourceSnapshot()).rejects.toThrow('rabbit_metrics_invalid')
})

test('Rabbit sample whitelists cluster metrics, RAM and free disk without inventing CPU or data-size', () => {
  const value = snapshot(); (value.nodes[0] as any).token = 'never-persist'; (value.overview as any).definitions = { secret: 'never-persist' }
  const sample = rabbitResourceSample(value, 'test')
  expect(sample).toMatchObject({ kind: 'rabbitmq', memorySource: 'rabbitmq-node', ramBytes: 100, diskFreeBytes: 500, rabbitMemoryStrategy: 'rss', rabbitQueues: 10, rabbitMessagesReady: 3, rabbitPublishRate: 2.5, partial: false })
  expect(sample.cpuPercent).toBeUndefined(); expect(sample.diskBytes).toBeUndefined(); expect(sample.rssBytes).toBeUndefined()
  expect(JSON.stringify(sample)).not.toMatch(/never-persist|rabbit@node|definitions/)
  expect(resourceTotal([sample])).toMatchObject({ ramBytes: 100, cpuPercent: undefined, cpuPartial: true })
})

test('Rabbit cluster aggregation sums known running RAM, takes minimum free disk and exposes alarms/down nodes', () => {
  const value = snapshot(); value.nodes.push({ ...value.nodes[0], name: 'rabbit@two', mem_used: 200, disk_free: 300, mem_alarm: true })
  value.nodes.push({ ...value.nodes[0], name: 'rabbit@down', running: false })
  expect(rabbitResourceSample(value, 'test')).toMatchObject({ ramBytes: 300, diskFreeBytes: 300, rabbitNodes: 3, rabbitRunningNodes: 2, rabbitMemoryAlarm: true, partial: true })
  const down = rabbitResourceSample({ ...value, nodes: value.nodes.map(node => ({ ...node, running: false })) }, 'test')
  expect(down.ramBytes).toBeUndefined(); expect(down.diskFreeBytes).toBeUndefined(); expect(down.partial).toBe(true)
  value.nodes[0].disk_free = 0; expect(rabbitResourceSample(value, 'test').diskFreeBytes).toBe(0)
})

test('free disk rollups preserve last observation and minimum, not an average or bytes consumed', () => {
  const points = [pointOf({ t: 1, n: 1, diskFreeBytes: 500 }), pointOf({ t: 2, n: 1, diskFreeBytes: 100 }), pointOf({ t: 3, n: 1, diskFreeBytes: 300 })]
  expect(aggregatePoints(points, 0)).toMatchObject({ diskFreeBytes: 300, diskFreeMinBytes: 100, diskBytes: undefined })
  expect(aggregatePoints([{ t: 1, n: 1 }], 0).diskFreeBytes).toBeUndefined()
})
