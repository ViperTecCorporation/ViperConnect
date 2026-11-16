import { ResourceMetricsPanel } from '../../frontend/features/resource_metrics'
import { renderResourceChart, resourcePercent } from '../../frontend/features/resource_charts'
import { renderDashboard } from '../../frontend/pages/dashboard'
import { renderResourcesPage } from '../../frontend/pages/resources'
import { ViperConnectApp } from '../../frontend/app'

const overview = { archiveEnabled: true, prefix: 'metrics/v1/test/', components: [{ id: 'a'.repeat(24), name: '<worker>', kind: 'worker', t: Date.now(), n: 1, ramBytes: 104857600, live: true, diskBytes: 2048 }], redisUnavailable: false, archiveUnavailable: false }
test('whole summary card opens details; operational buttons exist only inside current service details', async () => {
  const api = { request: jest.fn().mockResolvedValue({ points: [], warnings: [], resolution: 'minute' }), serviceLogs: jest.fn().mockRejectedValue(new Error('synthetic source unavailable')) }
  const panel = new ResourceMetricsPanel(api as any, jest.fn()), id = overview.components[0].id
  panel.current = overview as any
  panel.control.overview = { configured: true, targets: [{ component: id, name: 'worker', backend: 'docker', available: true, logs: true, confirmation: 'proof', expiresAt: Date.now() + 60000 }] }
  const grid = panel.html()
  expect(grid).toContain('<button class="resource-card ')
  expect(grid).toContain('Ver detalhes')
  expect(grid).not.toContain('resources-control-open'); expect(grid).not.toContain('resources-logs-open')
  await panel.action('resources-open', id)
  expect(panel.dialog()).toContain('resources-control-open'); expect(panel.dialog()).toContain('resources-logs-open')
  expect(panel.dialog()).toContain('resource-periods'); expect(panel.dialog()).toContain('resource-charts')
  await panel.action('resources-logs-open', id)
  expect(panel.logs.opened).toBe(true); expect(panel.open).toBe(true)
  await panel.action('resources-logs-close')
  expect(panel.dialog()).toContain('Ações do serviço'); expect(panel.selected).toBe(id)
  expect(api.request).toHaveBeenCalledTimes(1)
  panel.control.action = jest.fn(async action => { panel.control.opened = action === 'resources-control-open' })
  await panel.action('resources-control-open', id); expect(panel.open).toBe(true)
  await panel.action('resources-control-close'); expect(panel.dialog()).toContain('resources-control-open')
  panel.current!.historicalComponents = [{ ...overview.components[0], id: 'b'.repeat(24), live: false } as any]
  await panel.action('resources-open', 'b'.repeat(24))
  expect(panel.dialog()).not.toContain('resources-control-open'); expect(panel.dialog()).not.toContain('resources-logs-open')
  panel.current!.components[0].kind = 'total'; await panel.action('resources-open', id)
  expect(panel.dialog()).not.toContain('resources-control-open'); panel.reset()
})
test('overview cards are escaped and clickable; dashboard links to the dedicated page only for admin', async () => {
  const panel = new ResourceMetricsPanel({ request: jest.fn().mockResolvedValue(overview) } as any, jest.fn())
  await panel.refresh()
  expect(panel.html()).toContain('&lt;worker&gt;'); expect(panel.html()).toContain('100.0 MiB'); expect(panel.html()).toContain('resources-open')
  const options = { sessions: [], query: '', status: 'all', loading: false, refreshIn: 15, visibleLimit: 20 }
  const dashboard = renderDashboard({ ...options, canManageResources: true })
  expect(dashboard).toMatch(/data-action="refresh"[^]*?<\/button><button[^>]+data-action="open-resources"/)
  expect(dashboard).toContain('Gerenciador de recursos')
  expect(dashboard).not.toContain('class="resource-overview"')
  expect(renderDashboard(options)).not.toContain('data-action="open-resources"')
  expect(renderResourcesPage(panel.html())).toContain('class="resource-overview"')
  expect(renderResourcesPage(panel.html())).toContain('data-action="go-dashboard"')
  expect(renderResourcesPage(panel.html())).not.toMatch(/sessions-section|dashboard-refresh|Resumo das sessões/)
})
test('S3 readings have date and last-measurement label, not a live claim', async () => {
  const panel = new ResourceMetricsPanel({ request: jest.fn().mockResolvedValue({ ...overview, redisUnavailable: true, components: overview.components.map(row => ({ ...row, live: false, source: 's3' })) }) } as any, jest.fn())
  await panel.refresh()
  expect(panel.html()).toContain('Última medição'); expect(panel.html()).not.toContain('resource-live')
  expect(panel.html()).toContain('recuperada do S3')
})

test('retired containers leave the card grid and keep clickable history in a collapsed list', async () => {
  const old = { ...overview.components[0], id: 'b'.repeat(24), name: '<retired-worker>', live: false, source: 's3' }
  const api = { request: jest.fn().mockResolvedValueOnce({ ...overview, historicalComponents: [old] }).mockResolvedValue({ points: [], range: '1d', resolution: 'minute', warnings: [] }) }
  const panel = new ResourceMetricsPanel(api as any, jest.fn())
  await panel.refresh()
  const html = panel.html(), grid = html.split('<div class="resource-cards">')[1].split('<details')[0]
  expect(grid).not.toContain('retired-worker')
  expect(html).toContain('<details class="resource-previous"><summary>Instâncias anteriores (1)')
  expect(html).not.toContain('<details class="resource-previous" open')
  expect(html).toContain('&lt;retired-worker&gt;')
  expect(html).toContain('Não entram no total atual')
  await panel.action('resources-open', old.id)
  expect(api.request).toHaveBeenLastCalledWith(`/admin/resources/${old.id}/history?range=1d`)
  expect(panel.dialog()).toContain('&lt;retired-worker&gt;')
  expect(panel.dialog()).toContain('S3 · Última medição')
})
test('period controls query all five ranges and closing ignores a late response', async () => {
  const api = { request: jest.fn().mockResolvedValue({ points: [], range: '1d', resolution: 'minute', warnings: [] }) }, panel = new ResourceMetricsPanel(api as any, jest.fn())
  panel.current = overview as any
  await panel.action('resources-open', 'a'.repeat(24))
  for (const range of ['1d', '7d', '30d', '90d', 'max']) { await panel.action('resources-period', range); expect(api.request).toHaveBeenLastCalledWith(`/admin/resources/${'a'.repeat(24)}/history?range=${range}`) }
  expect(panel.dialog()).toContain('aria-pressed="true"')
  let finish!: (value: any) => void
  api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = panel.action('resources-period', '1d'); await panel.action('resources-close'); finish({ points: [{ t: 1 }], warnings: [] }); await pending
  expect(panel.open).toBe(false); expect(panel.history).toBeUndefined()
})
test('old account responses cannot populate another login and errors do not invent zero', async () => {
  let finish!: (value: any) => void
  const panel = new ResourceMetricsPanel({ request: jest.fn(() => new Promise(resolve => { finish = resolve })) } as any, jest.fn())
  const pending = panel.refresh(); panel.reset(); finish(overview); await pending
  expect(panel.current).toBeUndefined()
  expect(panel.html()).not.toContain('0.0 MiB')
})
test('SVG charts are bounded responsive markup with real peaks and no values for missing metrics', () => {
  const points = [{ t: 100, n: 1, ramBytes: 1024, ramMaxBytes: 2048 }]
  expect(renderResourceChart(points, 'ramBytes', 'RAM', 'minute')).toContain('viewBox')
  expect(renderResourceChart(points, 'ramBytes', 'RAM', 'minute')).toContain('resource-chart__peak')
  expect(renderResourceChart(points, 'diskBytes', 'Disco', 'minute')).toContain('Ainda não há medições')
})

test('CPU cards and charts preserve percentages above 100 and do not turn missing CPU into zero', async () => {
  const panel = new ResourceMetricsPanel({ request: jest.fn().mockResolvedValue({ ...overview, components: overview.components.map(row => ({ ...row, cpuPercent: 250.5 })) }) } as any, jest.fn())
  await panel.refresh()
  expect(panel.html()).toContain('CPU <b>250,5%</b>')
  expect(resourcePercent(undefined)).toBe('—'); expect(resourcePercent(0)).toBe('0%')
  const chart = renderResourceChart([{ t: 1, n: 1, cpuPercent: 150.5, cpuMaxPercent: 250.5 }], 'cpuPercent', 'CPU', 'minute')
  expect(chart).toContain('250,5%'); expect(chart).not.toMatch(/MiB|250,5 B/)
  expect(renderResourceChart([{ t: 1, n: 1 }], 'cpuPercent', 'CPU', 'minute')).toContain('Ainda não há medições')
})

test('Rabbit cards expose alarms and free disk, not queue storage or false CPU percentages', async () => {
  const api = { request: jest.fn().mockResolvedValueOnce({ ...overview, components: [{ ...overview.components[0], kind: 'rabbitmq', name: 'RabbitMQ', memorySource: 'rabbitmq-node', diskBytes: undefined, diskFreeBytes: 300, rabbitMemoryAlarm: true, rabbitQueues: 5 }] }).mockResolvedValue({ points: [], warnings: [], resolution: 'minute' }) }
  const panel = new ResourceMetricsPanel(api as any, jest.fn())
  await panel.refresh()
  expect(panel.html()).toContain('resource-card--alarm'); expect(panel.html()).toContain('Disco livre')
  expect(panel.html()).toContain('CPU requer Prometheus')
  await panel.action('resources-open', overview.components[0].id)
  expect(panel.dialog()).toContain('Filas no cluster'); expect(panel.dialog()).not.toContain('Arquivos em disco')
  const chart = renderResourceChart([{ t: 1, n: 1, diskFreeBytes: 300, diskFreeMinBytes: 100 }], 'diskFreeBytes', 'Disco livre', 'minute')
  expect(chart).toContain('Mínimo <strong>100 B'); expect(chart).toContain('não tamanho das filas')
})

const click = (action: string) => ({ target: { closest: (selector: string) => selector === '[data-action]' ? { dataset: { action } } : null, matches: () => false } })
test.each(['admin', 'user', null])('resource page navigation requires admin (%s)', async role => {
  const app = Object.create(ViperConnectApp.prototype) as any
  app.identity = role ? { role } : null; app.view = 'dashboard'; app.selectedPhone = 'test'; app.render = jest.fn()
  app.resources = { refresh: jest.fn() }; app.manager = { reset: jest.fn() }; app.sessionStorage = { reset: jest.fn() }
  await app.handleClick(click('open-resources'))
  expect(app.view).toBe(role === 'admin' ? 'resources' : 'dashboard')
  expect(app.resources.refresh).toHaveBeenCalledTimes(role === 'admin' ? 1 : 0)
  if (role === 'admin') {
    expect(app.selectedPhone).toBe(''); expect(app.mobileOpen).toBe(false)
    await app.handleClick(click('go-dashboard')); expect(app.view).toBe('dashboard')
  }
})

test('resource polling is isolated from sessions, paused for hidden pages and open detail', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const documentState = { visibilityState: 'visible' }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentState })
  try {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.identity = { role: 'admin' }; app.view = 'resources'; app.api = { getToken: () => 'test' }
    app.resources = { refresh: jest.fn(), open: false }; app.loadSessions = jest.fn().mockResolvedValue(undefined); app.refreshIn = 1
    app.tickRefresh(); expect(app.resources.refresh).toHaveBeenCalledTimes(1)
    app.resources.open = true; app.tickRefresh(); expect(app.resources.refresh).toHaveBeenCalledTimes(1)
    app.resources.open = false; documentState.visibilityState = 'hidden'; app.tickRefresh(); expect(app.resources.refresh).toHaveBeenCalledTimes(1)
    expect(app.loadSessions).not.toHaveBeenCalled(); expect(app.refreshIn).toBe(1)
    documentState.visibilityState = 'visible'; app.view = 'dashboard'; app.mobileDevices = {}; app.sessionTransfers = {}
    app.tickRefresh(); expect(app.resources.refresh).toHaveBeenCalledTimes(1); expect(app.loadSessions).toHaveBeenCalledTimes(1)
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') }
})
test('restart status keeps polling inside details, but never rerenders an active log reader', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } })
  try {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.identity = { role: 'admin' }; app.view = 'resources'; app.api = { getToken: () => 'test' }
    app.resources = { open: true, refresh: jest.fn(), logs: { opened: false }, control: { poll: jest.fn() } }
    app.tickRefresh(); expect(app.resources.control.poll).toHaveBeenCalledTimes(1); expect(app.resources.refresh).not.toHaveBeenCalled()
    app.resources.logs.opened = true; app.tickRefresh(); expect(app.resources.control.poll).toHaveBeenCalledTimes(1)
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') }
})
