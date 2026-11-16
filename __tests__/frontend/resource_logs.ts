import { ResourceLogsPanel } from '../../frontend/features/resource_logs'
import { ResourceMetricsPanel } from '../../frontend/features/resource_metrics'
import { ApiClient } from '../../frontend/core/api'

const id = 'a'.repeat(24), line = { id, text: '<script>alert(1)</script> áudio', timestamp: '2026-11-16T09:00:00Z', channel: 'stdout', level: 'info' }
const turn = () => new Promise(resolve => setTimeout(resolve, 10))
test('incremental UTF8 NDJSON is bounded, searchable state is retained, and export matches displayed lines only', async () => {
  const text = [{ type: 'connected', name: 'worker' }, { type: 'line', line }, { type: 'line', line }, { type: 'end', reason: 'source_closed' }].map(value => JSON.stringify(value)).join('\n') + '\n'
  const encoded = new TextEncoder().encode(text), body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < encoded.length; i += 5) controller.enqueue(encoded.slice(i, i + 5)); controller.close() } })
  const panel = new ResourceLogsPanel({ serviceLogs: jest.fn().mockResolvedValue(new Response(body)) } as any, jest.fn())
  panel.open(id, '<worker>'); await turn()
  expect(panel.lines).toHaveLength(1); expect(panel.exportText()).toContain('[info] [stdout] <script>')
  expect(panel.dialog()).toContain('&lt;script&gt;'); expect(panel.dialog()).not.toContain('<script>alert')
  panel.filters.tail = '100'
  for (let i = 0; i < 2500; i++) panel.append({ ...line, id: i.toString(16).padStart(24, '0'), text: 'x'.repeat(1000) })
  expect(panel.lines).toHaveLength(100); expect(panel.dropped).toBeGreaterThan(2000)
  expect(panel.exportText()).not.toContain('alert(1)')
  panel.filters.tail = '2000'
  for (let i = 3000; i < 5000; i++) panel.append({ ...line, id: i.toString(16).padStart(24, '0'), text: 'x'.repeat(32000) })
  expect(panel.lines.length).toBeLessThan(20)
  panel.reset()
})
test('pause, hidden tabs, close/logout and changing filters cancel the stream; late login data cannot reappear', async () => {
  let resolve!: (value: Response) => void
  const api = { serviceLogs: jest.fn().mockImplementation(() => new Promise<Response>(finish => { resolve = finish })) }
  const panel = new ResourceLogsPanel(api as any, jest.fn()); panel.open(id, 'worker')
  const oldSignal = api.serviceLogs.mock.calls[0][2]
  panel.reset(); resolve(new Response('')); await turn()
  expect(oldSignal.aborted).toBe(true); expect(panel.lines).toEqual([]); expect(panel.opened).toBe(false)
  api.serviceLogs.mockResolvedValue(new Response(new ReadableStream({ start() {} })))
  panel.open(id, 'worker'); panel.draft('include', 'audio'); const form = new FormData(); form.set('tail', '100'); form.set('include', 'audio'); form.set('exclude', 'ignore'); form.set('level', 'error'); form.set('channel', 'stderr')
  const first = api.serviceLogs.mock.calls[1][2]; panel.submit(form)
  expect(first.aborted).toBe(true); expect(api.serviceLogs.mock.calls[2][1]).toContain('include=audio')
  panel.pause(); expect(api.serviceLogs.mock.calls[2][2].aborted).toBe(true)
  panel.action('resources-logs-close'); expect(panel.opened).toBe(false)
})
test('DOM update uses textContent rather than HTML and does not rerender the whole app on every line', () => {
  const output = { textContent: '', scrollTop: 9, scrollHeight: 200 }, status = { textContent: '' }, feedback = { textContent: '', hidden: false }
  const nodes = { '[data-resource-log-output]': output, '[data-resource-log-status]': status, '[data-resource-log-error]': feedback }
  const render = jest.fn(), panel = new ResourceLogsPanel({} as any, render, () => ({ querySelector: selector => nodes[selector] || null }) as any)
  panel.opened = true; panel.append(line); panel.paint()
  expect(output.textContent).toContain('<script>'); expect(output.scrollTop).toBe(200); expect(render).not.toHaveBeenCalled()
  panel.follow = false; output.scrollTop = 5; panel.paint(); expect(output.scrollTop).toBe(5)
  panel.action('resources-logs-clear'); expect(panel.lines).toEqual([]); panel.reset()
})
test('historical/total/unmapped cards cannot select a log source; allowed current services may be offline', async () => {
  const panel = new ResourceMetricsPanel({ serviceLogs: jest.fn().mockRejectedValue(new Error('source unavailable')) } as any, jest.fn())
  panel.current = { components: [{ id, kind: 'total', live: false }] } as any
  panel.control.overview = { configured: true, targets: [{ component: id, name: 'test', backend: 'docker', available: false, logs: true }] }
  await panel.action('resources-logs-open', id); expect(panel.logs.opened).toBe(false)
  panel.current!.components[0].kind = 'worker'; await panel.action('resources-logs-open', id); await turn()
  expect(panel.logs.opened).toBe(true); expect(panel.logs.state).toBe('error'); panel.reset()
})
test('browser API authenticates streams in the header and discards a response after an account switch', async () => {
  const fetcher = jest.fn().mockResolvedValue(new Response('ok', { headers: { 'Content-Type': 'application/x-ndjson' } })), api = new ApiClient('http://localhost', fetcher)
  api.setToken('admin-test'); const response = await api.serviceLogs(id, 'tail=100', new AbortController().signal)
  expect(await response.text()).toBe('ok'); expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer admin-test')
  let finish!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = api.serviceLogs(id, '', new AbortController().signal); api.setToken('new-login'); finish(new Response('private', { headers: { 'Content-Type': 'application/x-ndjson' } }))
  await expect(pending).rejects.toThrow('Sessão alterada')
})
