import { rabbitCpuCounters, RabbitCpuDelta, RabbitCpuSampler } from '../../src/services/resource_metrics/rabbitmq_cpu'

const text = (runtime = 100, wall = 1000, unit = 'seconds_total', node = 'rabbit@node') => `rabbitmq_identity_info{rabbitmq_node="${node}",rabbitmq_endpoint="aggregated"} 1\nerlang_vm_statistics_runtime_${unit} ${runtime}\nerlang_vm_statistics_wallclock_time_${unit} ${wall}\n`
const options = { baseUrl: 'http://rabbitmq:15672', username: 'synthetic', password: 'synthetic', vhost: '/', queuePrefix: 'test' }

test('Rabbit CPU parser accepts matching cumulative pairs in either exporter unit and ignores unrelated metrics', () => {
  expect(rabbitCpuCounters(text())).toEqual({ runtime: 100, wall: 1000, node: 'rabbit@node', unit: 'seconds_total' })
  expect(rabbitCpuCounters(text(100, 1000, 'milliseconds'))).toMatchObject({ unit: 'milliseconds' })
  expect(() => rabbitCpuCounters(text().replace('runtime_seconds_total', 'runtime_milliseconds'))).toThrow('unavailable')
  expect(() => rabbitCpuCounters(text() + 'erlang_vm_statistics_runtime_seconds_total 200\n')).toThrow('unavailable')
  expect(() => rabbitCpuCounters(text().replace(' 100\n', ' NaN\n'))).toThrow('unavailable')
  expect(() => rabbitCpuCounters('erlang_vm_statistics_runtime_seconds_total 0\n')).toThrow('unavailable')
})

test('Rabbit CPU ratios are independent of shared counter unit, support multicore and reset safely', () => {
  const delta = new RabbitCpuDelta()
  expect(delta.read(rabbitCpuCounters(text()))).toBeUndefined()
  expect(delta.read(rabbitCpuCounters(text(350, 1100)))).toBe(250)
  expect(delta.read(rabbitCpuCounters(text(350, 1200)))).toBe(0)
  expect(delta.read(rabbitCpuCounters(text(1, 2)))).toBeUndefined()
  expect(delta.read(rabbitCpuCounters(text(2, 2)))).toBeUndefined()
  expect(delta.read(rabbitCpuCounters(text(3, 3, 'milliseconds')))).toBeUndefined()
  expect(delta.read(rabbitCpuCounters(text(4, 4, 'milliseconds', 'rabbit@other')))).toBeUndefined()
  delta.reset(); expect(delta.read(rabbitCpuCounters(text(5, 5)))).toBeUndefined()
  const legacy = new RabbitCpuDelta()
  legacy.read(rabbitCpuCounters(text(100000, 1000000, 'milliseconds')))
  expect(legacy.read(rabbitCpuCounters(text(350000, 1100000, 'milliseconds')))).toBe(250)
})

test('Rabbit CPU scrape uses a bounded authenticated read and requires matching node identity', async () => {
  const fetcher = jest.fn().mockResolvedValueOnce(new Response(text())).mockResolvedValueOnce(new Response(text(120, 1100)))
  const sampler = new RabbitCpuSampler(options, fetcher, '')
  expect(await sampler.sample([{ name: 'rabbit@node', running: true }])).toMatchObject({ cpuSource: 'rabbitmq-runtime', cpuPercent: undefined, cpuPartial: false })
  expect(await sampler.sample([{ name: 'rabbit@node', running: true }])).toMatchObject({ cpuPercent: 20 })
  expect(fetcher.mock.calls[0][0]).toBe('http://rabbitmq:15692/metrics')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
  fetcher.mockResolvedValueOnce(new Response(text(140, 1200)))
  expect(await sampler.sample([{ name: 'rabbit@wrong', running: true }])).toEqual({})
  fetcher.mockResolvedValueOnce(new Response(text(160, 1300)))
  expect((await sampler.sample([{ name: 'rabbit@node', running: true }])).cpuPercent).toBeUndefined()
})

test('Rabbit CPU scrape fails closed on denied/unavailable/oversized responses, and multi-node CPU is partial', async () => {
  const fetcher = jest.fn().mockResolvedValueOnce(new Response('denied', { status: 403 })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('x'.repeat(1048577))).mockResolvedValueOnce(new Response(text()))
  const sampler = new RabbitCpuSampler(options, fetcher, 'https://metrics.internal/metrics')
  const nodes = [{ name: 'rabbit@node', running: true }, { name: 'rabbit@other', running: true }]
  for (let i = 0; i < 3; i++) expect(await sampler.sample(nodes)).toEqual({})
  expect(await sampler.sample(nodes)).toMatchObject({ cpuSource: 'rabbitmq-runtime', cpuPartial: true })
  expect(fetcher.mock.calls[0][0]).toBe('https://metrics.internal/metrics')
  expect(await new RabbitCpuSampler({ ...options, baseUrl: 'invalid' }, fetcher).sample(nodes)).toEqual({})
})
