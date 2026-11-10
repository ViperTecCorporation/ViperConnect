import { SessionStoragePanel, SessionStorageStatus, SessionStorageTask, normalizeStorageMetrics } from '../../frontend/features/session_storage'
import { ApiError } from '../../frontend/core/api'
import { renderSessionPage } from '../../frontend/pages/session'
import { renderDashboard } from '../../frontend/pages/dashboard'

const phone = '999123456789'
const status: SessionStorageStatus = { backend: 'redis', owner: 'lab-worker', state: 'active', generation: 1, capability: { sqliteAvailable: true, defaultBackend: 'redis' } }
const task: SessionStorageTask = { id: 'task-1', phone, kind: 'migration', status: 'queued' }
const confirm = () => { const data = new FormData(); data.set('confirm', 'on'); return data }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const disclosure = (html: string, action: string) => {
  const button = (html.match(/<button\b[^>]*>/g) || []).find(tag => tag.includes(`data-action="${action}"`)) || ''
  const target = /aria-controls="([^"]+)"/.exec(button)?.[1]
  const content = target ? (html.match(/<div\b[^>]*>/g) || []).find(tag => tag.includes(`id="${target}"`)) || '' : ''
  return { button, content, target }
}
const beforeTechnical = (html: string) => {
  const button = disclosure(html, 'storage-toggle-technical').button
  return button ? html.slice(0, html.indexOf(button)) : html
}
const plainText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

test('storage status loads explicit versioned route and renders owner without unsafe HTML', async () => {
  const api = { request: jest.fn().mockResolvedValue({ ...status, owner: '<worker>', fixture: true }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  expect(api.request).toHaveBeenCalledWith(`/v15.0/${phone}/storage`)
  expect(panel.html(phone)).toContain('&lt;worker&gt;')
  expect(panel.html(phone)).toMatch(/Dados de teste|Sessão sintética de laboratório/)
  expect(panel.dialog()).toContain('sem logout')
  expect(panel.html('other')).toBe('')
})

test('migration requires confirmation and never reports acceptance as completion', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce(task) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  await panel.submit('storage-migrate', new FormData())
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(panel.error).toContain('confirme')
  await panel.submit('storage-migrate', confirm())
  expect(api.request).toHaveBeenLastCalledWith(`/v15.0/${phone}/storage/migrations`, { method: 'POST', body: JSON.stringify({ target: 'sqlite', confirm: true }) })
  expect(panel.status?.backend).toBe('redis')
  expect(panel.notice).not.toBe('')
  expect(panel.notice).not.toContain('concluída')
  expect(panel.modal).toBe(false)
  expect(panel.dialog()).toBe('')
  await panel.submit('storage-migrate', confirm())
  expect(api.request).toHaveBeenCalledTimes(2)
  panel.reset()
})

test('confirmation remains visible while HTTP is pending and closes only after a valid accepted task', async () => {
  jest.useFakeTimers()
  let accept!: (value: SessionStorageTask) => void
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockReturnValueOnce(new Promise<SessionStorageTask>(resolve => { accept = resolve })) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  const posting = panel.submit('storage-migrate', confirm())
  expect(panel.modal).toBe(true); expect(panel.busy).toBe(true)
  expect(panel.dialog()).toContain('required disabled')
  accept({ ...task, status: 'running' }); await posting
  expect(panel.modal).toBe(false); expect(panel.dialog()).toBe('')
  expect(panel.task?.status).toBe('running'); expect(panel.status?.backend).toBe('redis')
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  panel.reset()
})

test.each(['http-error', 'foreign-task', 'failed-task'])('confirmation stays open after a rejected or invalid migration response (%s)', async failure => {
  const api = { request: jest.fn().mockResolvedValueOnce(status) }
  if (failure === 'http-error') api.request.mockRejectedValueOnce(new ApiError(503, 'worker_unavailable'))
  else api.request.mockResolvedValueOnce(failure === 'foreign-task' ? { ...task, phone: 'other', status: 'running' } : { ...task, status: 'failed', error: 'session_storage_validation_failed' })
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone); await panel.submit('storage-migrate', confirm())
  expect(panel.modal).toBe(true); expect(panel.busy).toBe(false)
  expect(panel.dialog()).toContain('data-form="storage-migrate"')
  expect(panel.error).not.toBe(''); expect(panel.status?.backend).toBe('redis')
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  panel.reset()
})

test('an immediately completed task closes confirmation and needs no refresh-task action', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce({ ...task, status: 'ready' })
    .mockResolvedValueOnce({ ...status, backend: 'sqlite', generation: 2 }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone); await panel.submit('storage-migrate', confirm())
  expect(panel.modal).toBe(false); expect(panel.status?.backend).toBe('sqlite')
  expect(panel.html(phone)).not.toContain('data-action="storage-task"')
  expect(jest.getTimerCount()).toBe(0)
  panel.reset()
})

test.each(['redis', 'sqlite'] as const)('compact %s dialog has one confirmation form and never embeds the overview or its storage-open action', async backend => {
  const api = { request: jest.fn().mockResolvedValue({ ...status, backend }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  const overview = jest.spyOn(panel, 'html').mockImplementation(() => { throw new Error('overview must not be rendered inside its own dialog') })
  let dialog = ''
  expect(() => { dialog = panel.dialog() }).not.toThrow()
  expect(overview).not.toHaveBeenCalled()
  expect(dialog.match(/<form\b/g)).toHaveLength(1)
  expect(dialog.match(/type="checkbox"/g)).toHaveLength(1)
  expect(dialog).toContain(`data-form="storage-${backend === 'sqlite' ? 'backup' : 'migrate'}"`)
  expect(dialog).not.toContain('data-action="storage-open"')
  expect(dialog).not.toContain('Indicadores do laboratório')
  overview.mockRestore(); panel.reset()
})

test('polls until succeeded then reloads actual backend and stops', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce(task)
    .mockResolvedValueOnce({ ...task, status: 'running', phase: 'validating' })
    .mockResolvedValueOnce({ ...task, status: 'succeeded' })
    .mockResolvedValueOnce({ ...status, backend: 'sqlite', generation: 2 }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); await panel.submit('storage-migrate', confirm())
  jest.advanceTimersByTime(2000); await flush()
  expect(panel.task?.status).toBe('running'); expect(panel.status?.backend).toBe('redis')
  jest.advanceTimersByTime(2000); await flush()
  expect(panel.task?.status).toBe('succeeded'); expect(panel.status?.backend).toBe('sqlite')
  expect(panel.notice).toContain('Migração concluída pelo worker')
  expect(jest.getTimerCount()).toBe(0)
  expect(api.request).toHaveBeenCalledWith(`/v15.0/${phone}/storage/tasks/task-1`)
})

test('task failure keeps backend unchanged and exposes the reason', async () => {
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce(task).mockResolvedValueOnce({ ...task, status: 'failed', error: 'session_storage_validation_failed' }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); await panel.submit('storage-migrate', confirm()); await panel.checkTask()
  expect(panel.status?.backend).toBe('redis')
  expect(panel.error).toContain('session_storage_validation_failed')
  expect(panel.notice).not.toContain('concluída')
  panel.reset()
})

test('polling budget is bounded and manual consultation does not resubmit', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValue(task) }
  const panel = new SessionStoragePanel(api as any, jest.fn(), 1)
  await panel.load(phone); await panel.submit('storage-migrate', confirm())
  jest.advanceTimersByTime(2000); await flush()
  expect(jest.getTimerCount()).toBe(0)
  expect(panel.notice).toContain('consulta automática foi pausada')
  await panel.action('storage-task')
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  panel.reset()
})

test('poll failure is visible and does not retry automatically', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce(task).mockRejectedValueOnce(new ApiError(503, 'worker_offline')) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); await panel.submit('storage-migrate', confirm())
  jest.advanceTimersByTime(2000); await flush()
  expect(panel.error).toContain('worker_offline')
  expect(panel.error).toContain('Não repita')
  expect(panel.task?.status).toBe('queued')
  expect(jest.getTimerCount()).toBe(0)
})

test('POST rejection is not retried and never displays success', async () => {
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockRejectedValueOnce(new ApiError(409, 'session_storage_busy')) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); await panel.submit('storage-migrate', confirm())
  expect(api.request).toHaveBeenCalledTimes(2)
  expect(panel.task).toBeUndefined(); expect(panel.notice).toBe('')
  expect(panel.error).toContain('Não houve repetição automática')
})

test('reset cancels polling and discards responses from the previous session', async () => {
  let resolve!: (value: SessionStorageStatus) => void
  const api = { request: jest.fn().mockReturnValue(new Promise<SessionStorageStatus>(done => { resolve = done })) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  const loading = panel.load(phone); panel.reset(); resolve(status); await loading
  expect(panel.status).toBeUndefined(); expect(panel.phone).toBe('')
})

test('reset during POST does not adopt old task or restart polling', async () => {
  jest.useFakeTimers()
  let resolve!: (value: SessionStorageTask) => void
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockReturnValueOnce(new Promise<SessionStorageTask>(done => { resolve = done })) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); const posting = panel.submit('storage-migrate', confirm()); panel.reset(); resolve(task); await posting
  expect(panel.task).toBeUndefined(); expect(jest.getTimerCount()).toBe(0)
})

test('SQLite backup uses confirmed POST and displays last snapshot status', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce({ ...status, backend: 'sqlite', lastBackup: { status: 'succeeded', createdAt: '2026-11-08T12:00:00Z' } }).mockResolvedValueOnce({ ...task, kind: 'backup' }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  expect(panel.html(phone)).toContain('2026-11-08T12:00:00Z')
  expect(panel.dialog()).not.toContain('data-form="storage-migrate"')
  await panel.submit('storage-backup', confirm())
  expect(api.request).toHaveBeenLastCalledWith(`/v15.0/${phone}/storage/backups`, { method: 'POST', body: JSON.stringify({ confirm: true }) })
  panel.reset()
})

test('already migrating session disables mutations even before a task is loaded', async () => {
  const api = { request: jest.fn().mockResolvedValue({ ...status, state: 'migrating' }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  expect(panel.dialog()).toContain('required disabled')
  await panel.submit('storage-migrate', confirm())
  expect(api.request).toHaveBeenCalledTimes(1)
})

test('foreign task response is rejected, not interpreted as a completed migration', async () => {
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce({ ...task, phone: 'other', status: 'succeeded' }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); await panel.submit('storage-migrate', confirm())
  expect(panel.error).toContain('tarefa válida'); expect(panel.status?.backend).toBe('redis')
})

test('overview exposes storage controls only for administrator', () => {
  const options: any = { session: { phone, provider: 'zapo' }, tab: 'overview', canManageUsers: true, contacts: [], groups: [], contactCount: 0, storageHtml: '<div>storage-panel-marker</div>' }
  expect(renderSessionPage(options)).toContain('storage-panel-marker')
  expect(renderSessionPage({ ...options, canManageUsers: false })).not.toContain('storage-panel-marker')
})

test('missing persistent volume blocks migration and explains Redis default with deployment example', async () => {
  const api = { request: jest.fn().mockResolvedValue({ ...status, capability: { sqliteAvailable: false, defaultBackend: 'redis', reason: 'session_storage_volume_missing', configurationExample: { env: { SESSION_STORAGE_ROOT: '/data/session-storage', SESSION_STORAGE_PERSISTENT: 'true', SESSION_STORAGE_DEFAULT: 'sqlite' }, compose: 'volumes:\n  - zapo_sessions:/data/session-storage' } } }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  expect(panel.html(phone)).toContain('<p class="storage-warning" role="alert">SQLite indisponível neste worker. Novas sessões usarão Redis; configure o volume persistente.</p>')
  expect(panel.html(phone)).toContain('Como configurar')
  expect(panel.html(phone)).not.toContain('Como ativar SQLite')
  expect(panel.html(phone)).toContain('novas sessões usam Redis')
  expect(panel.html(phone)).toContain('SESSION_STORAGE_ROOT=/data/session-storage')
  expect(panel.html(phone)).toContain('Novas sessões usarão Redis; configure o volume persistente.')
  expect(panel.html(phone)).toContain('/app/session-data')
  expect(panel.html(phone)).toContain('Redis continua obrigatório')
  expect(panel.dialog()).toContain('required disabled')
  expect(panel.html(phone)).toContain('/guide/session-storage')
  await panel.submit('storage-migrate', confirm())
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(panel.error).toContain('volume persistente')
})

test.each(['redis', 'sqlite'] as const)('available SQLite with Redis default warns about new sessions without changing the current %s backend', async backend => {
  const api = { request: jest.fn().mockResolvedValue({ ...status, backend }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  const html = panel.html(phone), section = disclosure(html, 'storage-toggle-configuration')
  expect(html).toContain('<p class="storage-warning" role="alert">SQLite disponível, mas novas sessões ainda usam Redis.</p>')
  expect(html).toContain(`class="storage-badge">${backend.toUpperCase()}</span>`)
  expect(html).toContain(backend === 'sqlite' ? 'Backup e opções' : 'Migrar para SQLite')
  expect(html).not.toContain('SQLite indisponível neste worker.')
  expect(html).toContain('Como ativar SQLite')
  expect(html).toContain('SESSION_STORAGE_DEFAULT=sqlite')
  expect(html).toContain('preservando os volumes e o dono da sessão')
  expect(html).toContain('O padrão vale apenas para novas sessões; as existentes exigem migração manual.')
  expect(html).toContain('Sessões já migradas permanecem no SQLite.')
  expect(html).toContain('/guide/session-storage')
  expect(section.button).toContain('aria-expanded="false"')
  expect(section.content).toMatch(/\bhidden(?:\s|>)/)
  expect(html.indexOf('SQLite disponível, mas novas sessões ainda usam Redis.')).toBeLessThan(html.indexOf(section.button))
  await panel.action('storage-toggle-configuration')
  expect(disclosure(panel.html(phone), 'storage-toggle-configuration').button).toContain('aria-expanded="true"')
  expect(disclosure(panel.html(phone), 'storage-toggle-configuration').content).not.toMatch(/\bhidden(?:\s|>)/)
  expect(panel.dialog()).toContain('SQLite disponível, mas novas sessões ainda usam Redis.')
  expect(panel.status?.backend).toBe(backend)
  expect(api.request).toHaveBeenCalledTimes(1)
  panel.reset()
})

test.each(['redis', 'sqlite'] as const)('available SQLite default needs no activation warning and preserves the existing %s backend', backend => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone
  panel.status = { ...status, backend, capability: { sqliteAvailable: true, defaultBackend: 'sqlite' } }
  const html = panel.html(phone)
  expect(html).not.toContain('SQLite disponível, mas novas sessões ainda usam Redis.')
  expect(html).not.toContain('SQLite indisponível neste worker.')
  expect(html).not.toContain('storage-toggle-configuration')
  expect(html).toContain(`class="storage-badge">${backend.toUpperCase()}</span>`)
  expect(html).toContain(backend === 'sqlite' ? 'Backup e opções' : 'Migrar para SQLite')
})

test('current task from status resumes bounded consultation without creating another task', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValue({ ...status, currentTask: task }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone)
  expect(panel.task?.id).toBe(task.id)
  expect(jest.getTimerCount()).toBe(1)
  await panel.submit('storage-migrate', confirm())
  expect(api.request).toHaveBeenCalledTimes(1)
  panel.reset()
})

test('opening a persisted interrupted task shows recovery guidance instead of silently clearing its failure', async () => {
  const api = { request: jest.fn().mockResolvedValue({ ...status, state: 'migrating', currentTask: { ...task, status: 'interrupted' } }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone)
  expect(panel.error).toContain('interrompida')
  expect(panel.html(phone)).toContain('Consulte a recuperação')
  expect(api.request).toHaveBeenCalledTimes(1)
})

test('metrics poll every five seconds only until page reset and distinguish process RAM from disk', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValueOnce({ ...status, backend: 'sqlite' }).mockResolvedValue({ worker: { rssBytes: 10485760, heapUsedBytes: 1048576, externalBytes: 2097152, sessionCount: 7 }, session: { backend: 'sqlite', sqliteBytes: 3145728, walBytes: 0, shmBytes: 32768, records: 100 }, migration: { durationMs: 1200, beforeRedisEstimatedBytes: 4194304, afterSqliteBytes: 3145728, sourcePreserved: true } }) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); panel.startMetrics(phone); await flush()
  expect(api.request).toHaveBeenLastCalledWith(`/v15.0/${phone}/storage/metrics`)
  expect(panel.metricsHtml()).toContain('RAM exclusiva desta sessão ainda não é medida')
  expect(panel.metricsHtml()).toContain('10.0 MiB')
  expect(plainText(panel.metricsHtml())).toContain('SQLite (disco) 3.0 MiB')
  expect(panel.metricsHtml()).toContain('não é consumo de RAM')
  expect(panel.metricsHtml().toLowerCase()).toContain('preservada')
  jest.advanceTimersByTime(5000); await flush()
  expect(api.request).toHaveBeenCalledTimes(3)
  panel.reset(); jest.advanceTimersByTime(15000); await flush()
  expect(api.request).toHaveBeenCalledTimes(3)
})

test('metrics errors are explicit and responses after page reset are discarded', async () => {
  jest.useFakeTimers()
  let resolve!: (value: any) => void
  const api = { request: jest.fn().mockResolvedValueOnce(status).mockRejectedValueOnce(new Error('worker_unavailable')).mockReturnValueOnce(new Promise(done => { resolve = done })) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone); panel.startMetrics(phone); await flush()
  expect(panel.metricsHtml()).toContain('worker_unavailable')
  jest.advanceTimersByTime(5000); panel.reset(); resolve({ session: { backend: 'sqlite', sqliteBytes: 1 } }); await flush()
  expect(panel.metrics).toBeUndefined()
  expect(jest.getTimerCount()).toBe(0)
})

test('worker ready result is terminal and interrupted task never announces success', async () => {
  for (const workerStatus of ['ready', 'interrupted'] as const) {
    const api = { request: jest.fn().mockResolvedValueOnce(status).mockResolvedValueOnce({ ...task, kind: undefined, operation: 'migration', status: workerStatus }).mockResolvedValue(status) }
    const panel = new SessionStoragePanel(api as any, jest.fn())
    await panel.load(phone); await panel.submit('storage-migrate', confirm())
    if (workerStatus === 'ready') expect(panel.notice).toContain('concluída pelo worker')
    else { expect(panel.error).toContain('interrompida'); expect(panel.notice).not.toContain('concluída') }
    panel.reset()
  }
})

test('metrics do not issue requests when the session page is inactive', async () => {
  jest.useFakeTimers()
  const api = { request: jest.fn().mockResolvedValue(status) }
  let active = false
  const panel = new SessionStoragePanel(api as any, jest.fn(), 120, () => active)
  await panel.load(phone); panel.startMetrics(phone); await flush()
  jest.advanceTimersByTime(5000); await flush()
  expect(api.request).toHaveBeenCalledTimes(1)
  active = true; jest.advanceTimersByTime(5000); await flush()
  expect(api.request).toHaveBeenLastCalledWith(`/v15.0/${phone}/storage/metrics`)
  panel.reset()
})

test('actual worker metrics wire shape renders disk, shared RAM and migration comparison separately', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.metrics = normalizeStorageMetrics({ worker: { rssBytes: 10 * 1048576, heapUsedBytes: 1, externalBytes: 2, sharedSessionCount: 7 }, storage: { backend: 'sqlite', files: { databaseBytes: 3 * 1048576, walBytes: 4096, shmBytes: 32768 }, records: 100, partial: true }, migration: { durationMs: 1500, before: { storage: { estimatedBytes: 4 * 1048576 } }, after: { storage: { files: { databaseBytes: 3 * 1048576 } } }, sourcePreserved: true } })
  expect(plainText(panel.metricsHtml())).toContain('Clientes carregados 7')
  expect(plainText(panel.metricsHtml())).toContain('SQLite (disco) 3.0 MiB')
  expect(plainText(panel.metricsHtml())).toContain('Redis antes (estimativa) 4.0 MiB')
  expect(panel.metricsHtml()).toContain('Estimativa parcial')
})

test('container memory remains shared and the SQLite cache budget is not presented as measured session RAM', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.metrics = normalizeStorageMetrics({ worker: { rssBytes: 10 * 1048576, heapUsedBytes: 1, externalBytes: 2, sharedSessionCount: 0,
    container: { currentBytes: 50 * 1048576, anonBytes: 12 * 1048576, fileBytes: 35 * 1048576, inactiveFileBytes: 25 * 1048576 } },
    storage: { backend: 'sqlite', cacheBudgetBytes: 1048576, files: { databaseBytes: 100 * 1048576 } } })
  const html = panel.metricsHtml()
  expect(plainText(html)).toContain('Clientes carregados 0')
  expect(plainText(html)).toContain('Total do container (cgroup) 50.0 MiB')
  expect(plainText(html)).toContain('Arquivos/cache 35.0 MiB')
  expect(html).toContain('Arquivos inativos não são RAM livre garantida')
  expect(html).toContain('não contam bancos SQLite offline')
  expect(plainText(html)).toContain('Orçamento de cache SQLite 1.0 MiB')
  expect(html).toContain('soft; não é consumo medido')
  expect(html).not.toMatch(/Infinity|NaN/)
  delete panel.metrics!.worker!.container
  expect(panel.metricsHtml()).toContain('memória do container indisponível')
})

test('known fixture descriptor disables connection and send actions without per-row storage reads', () => {
  const session = { phone, provider: 'zapo' as const, status: 'offline', sessionStorage: { fixture: true } }
  const dashboard = renderDashboard({ sessions: [session], query: '', status: 'all', loading: false, refreshIn: 10, visibleLimit: 30 })
  expect(dashboard).toMatch(/data-action="connect-session"[^>]*disabled/)
  const options: any = { session, tab: 'overview', canManageUsers: true, contacts: [], groups: [], contactCount: 0 }
  const overview = renderSessionPage(options)
  expect(overview).toMatch(/data-action="connect-session"[^>]*disabled/)
  expect(overview).toMatch(/data-action="test-message"[^>]*disabled/)
  expect(renderSessionPage({ ...options, session: { phone, provider: 'zapo' }, storageFixture: true })).toMatch(/data-action="connect-session"[^>]*disabled/)
})

test('Redis overview shows only relevant session memory and shared worker RAM; technical information starts collapsed', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone; panel.status = status
  panel.metrics = normalizeStorageMetrics({ worker: { rssBytes: 10 * 1048576, heapUsedBytes: 1048576, externalBytes: 2097152, sharedSessionCount: 2 },
    storage: { backend: 'redis', estimatedBytes: 30 * 1048576, sampledKeys: 250, partial: true } })
  const html = panel.html(phone), summary = beforeTechnical(html), technical = disclosure(html, 'storage-toggle-technical')
  expect(summary).toContain('Dados no Redis'); expect(summary).toContain('30.0 MiB')
  expect(summary).toContain('Estimativa parcial desta sessão')
  expect(summary).toContain('RAM do worker'); expect(summary).toContain('10.0 MiB')
  expect(summary.toLowerCase()).toContain('compartilhada')
  expect(html).not.toMatch(/WAL|SHM|Banco SQLite|cache SQLite/)
  expect(technical.button).toContain('aria-expanded="false"')
  expect(technical.content).toMatch(/\bhidden(?:\s|>)/)
  expect(html).not.toContain('<details open')
})

test('SQLite overview distinguishes disk/records from shared RAM, retaining cgroup and generation in collapsed technical details', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone; panel.status = { ...status, backend: 'sqlite', generation: 77 }
  panel.task = { ...task, id: '97ab8032-f5ee-4eaa-a5b2-bad3f0a16cf5', status: 'running', phase: 'copy' }
  panel.metrics = normalizeStorageMetrics({ worker: { rssBytes: 10 * 1048576, heapUsedBytes: 1048576, externalBytes: 2, sharedSessionCount: 0,
    container: { currentBytes: 50 * 1048576, anonBytes: 12 * 1048576, fileBytes: 35 * 1048576 } },
    storage: { backend: 'sqlite', files: { databaseBytes: 100 * 1048576, walBytes: 4096, shmBytes: 32768 }, records: 1234, cacheBudgetBytes: 1048576 } })
  const html = panel.html(phone), summary = beforeTechnical(html)
  expect(summary).toContain('Banco SQLite'); expect(summary).toContain('100.0 MiB')
  expect(summary).toMatch(/1[.,]?234/); expect(summary).toContain('RAM do worker')
  expect(summary).not.toContain(panel.task.id); expect(summary).not.toMatch(/WAL|SHM|cgroup|Geração:/)
  expect(html).toContain(panel.task.id); expect(html).toContain('50.0 MiB'); expect(html).toContain('35.0 MiB')
  expect(disclosure(html, 'storage-toggle-technical').button).toContain('aria-expanded="false"')
  expect(disclosure(html, 'storage-toggle-technical').content).toMatch(/\bhidden(?:\s|>)/)
})

test('technical expansion survives polling and same-session reload but resets for another session', async () => {
  jest.useFakeTimers()
  const metrics = { worker: { rssBytes: 1048576, heapUsedBytes: 0, externalBytes: 0, sharedSessionCount: 0 }, storage: { backend: 'redis', estimatedBytes: 2097152, sampledKeys: 2 } }
  const api = { request: jest.fn(async (route: string) => route.endsWith('/metrics') ? metrics : status) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.load(phone)
  expect(disclosure(panel.html(phone), 'storage-toggle-technical').button).toContain('aria-expanded="false"')
  await panel.action('storage-toggle-technical')
  expect(disclosure(panel.html(phone), 'storage-toggle-technical').button).toContain('aria-expanded="true"')
  expect(disclosure(panel.html(phone), 'storage-toggle-technical').content).not.toMatch(/\bhidden(?:\s|>)/)
  panel.startMetrics(phone); await flush(); jest.advanceTimersByTime(5000); await flush()
  await panel.load(phone)
  expect(disclosure(panel.html(phone), 'storage-toggle-technical').button).toContain('aria-expanded="true"')
  await panel.action('storage-toggle-technical')
  expect(disclosure(panel.html(phone), 'storage-toggle-technical').button).toContain('aria-expanded="false"')
  await panel.action('storage-toggle-technical'); await panel.load('999987654321')
  expect(disclosure(panel.html('999987654321'), 'storage-toggle-technical').button).toContain('aria-expanded="false"')
  panel.reset()
})

test('deployment example and diagnostic codes are retained in a collapsed configuration section', async () => {
  const capability = { sqliteAvailable: false, defaultBackend: 'redis', reason: 'session_storage_volume_missing',
    configurationExample: { env: { SESSION_STORAGE_ROOT: '/data/session-storage', SESSION_STORAGE_PERSISTENT: 'true', SESSION_STORAGE_DEFAULT: 'sqlite' }, compose: 'volumes:\n  - zapo_sessions:/data/session-storage' } }
  const panel = new SessionStoragePanel({ request: jest.fn().mockResolvedValue({ ...status, capability }) } as any, jest.fn())
  await panel.action('storage-open', phone)
  let section = disclosure(panel.html(phone), 'storage-toggle-configuration')
  expect(section.button).toContain('aria-expanded="false"'); expect(section.content).toMatch(/\bhidden(?:\s|>)/)
  expect(panel.html(phone)).toContain('SESSION_STORAGE_ROOT=/data/session-storage')
  await panel.action('storage-toggle-configuration')
  section = disclosure(panel.html(phone), 'storage-toggle-configuration')
  expect(section.button).toContain('aria-expanded="true"'); expect(section.content).not.toMatch(/\bhidden(?:\s|>)/)
  const overviewIds = [...panel.html(phone).matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
  const dialogIds = [...panel.dialog().matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
  expect(overviewIds.some(id => dialogIds.includes(id))).toBe(false)
  panel.reset()
})

test('the main task status is readable while raw task identifiers and failure codes remain escaped in technical details', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone; panel.status = status
  panel.task = { ...task, id: '97ab8032-f5ee-4eaa-a5b2-bad3f0a16cf5', status: 'failed', error: 'session_storage_validation_failed' }
  panel.error = panel.task.error!
  const html = panel.html(phone), summary = beforeTechnical(html)
  expect(summary).not.toContain(panel.task.id)
  expect(summary).not.toContain('session_storage_validation_failed')
  expect(html).toContain(panel.task.id); expect(html).toContain('session_storage_validation_failed')
  panel.error = '<script>alert(1)</script>'
  expect(panel.html(phone)).not.toContain('<script>')
  expect(panel.html(phone)).toContain('&lt;script&gt;')
})

test('compact layout retains paused-poll guidance and backup diagnostics in technical details', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone
  panel.status = { ...status, state: 'restoring', lastBackup: { status: 'failed', createdAt: '2026-11-08T12:00:00Z', error: 'session_storage_backup_upload_failed' } }
  panel.task = { ...task, status: 'running', phase: 'copy' }
  panel.notice = 'A consulta automática foi pausada. Use Atualizar tarefa.'
  const html = panel.html(phone)
  expect(html).toContain('consulta automática foi pausada')
  expect(html).toContain('2026-11-08T12:00:00Z')
  expect(html).toContain('session_storage_backup_upload_failed')
  expect(html).toContain('restoring')
  expect(plainText(html)).toMatch(/(?:Estado|Status) do backup failed/)
  expect(beforeTechnical(html)).not.toContain('session_storage_backup_upload_failed')
})

test('opening technical details preserves the confirmation checkbox without replacing the FormData submission guard', async () => {
  const api = { request: jest.fn().mockResolvedValue(status) }
  const panel = new SessionStoragePanel(api as any, jest.fn())
  await panel.action('storage-open', phone)
  const checkbox = () => (panel.dialog().match(/<input\b[^>]*>/g) || []).find(tag => tag.includes('name="confirm"')) || ''
  expect(checkbox()).not.toMatch(/\schecked(?:\s|>)/)
  panel.setConfirmed(true)
  await panel.action('storage-toggle-technical')
  expect(checkbox()).toMatch(/\schecked(?:\s|>)/)
  await panel.action('storage-toggle-technical')
  expect(checkbox()).toMatch(/\schecked(?:\s|>)/)
  await panel.submit('storage-migrate', new FormData())
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(panel.error).toContain('confirme')
  await panel.action('storage-close'); await panel.action('storage-open', phone)
  expect(checkbox()).not.toMatch(/\schecked(?:\s|>)/)
  panel.reset()
})

test('committed migration reports reconnect requested without claiming the WhatsApp socket is online', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone; panel.status = { ...status, backend: 'sqlite', state: 'offline' }
  panel.task = { ...task, status: 'ready', result: { autoConnect: true, reconnect: { status: 'requested' } } }
  const html = panel.html(phone), summary = beforeTechnical(html)
  expect(summary).toContain('Migração concluída · Reconexão solicitada')
  expect(summary).not.toMatch(/\bOnline\b/i)
  expect(html).not.toContain('data-action="storage-task"')
  expect(plainText(html)).toContain('Reconexão requested')
})

test('reconnect dispatch failure leaves migration completed and exposes a pending connection rather than fake Online', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn())
  panel.phone = phone; panel.status = { ...status, backend: 'sqlite', state: 'offline' }
  panel.task = { ...task, status: 'ready', result: { autoConnect: true, reconnect: { status: 'failed', reason: 'dispatch_failed' } } }
  const html = panel.html(phone), summary = beforeTechnical(html)
  expect(summary).toContain('Migração concluída · Reconexão pendente')
  expect(summary).not.toMatch(/\bOnline\b/i)
  expect(summary).not.toContain('dispatch_failed')
  expect(html).toContain('dispatch_failed'); expect(plainText(html)).toContain('Reconexão failed')
})

test('storage descriptor active/offline is not presented as WhatsApp status; only ongoing storage workflow states are shown', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn()); panel.phone = phone
  for (const state of ['active', 'offline']) {
    panel.status = { ...status, backend: 'sqlite', state }
    const summary = beforeTechnical(panel.html(phone))
    const stateLine = summary.match(/<p class="muted">([\s\S]*?)<\/p>/)?.[1] || ''
    expect(stateLine).toContain('SQLITE'); expect(stateLine).toContain('Worker: lab-worker')
    expect(stateLine).not.toMatch(/\b(?:Offline|Disponível|Online)\b/i)
  }
  for (const [state, label] of [['migrating', 'Em migração'], ['restoring', 'Restaurando'], ['backing_up', 'Gerando backup']]) {
    panel.status = { ...status, backend: 'sqlite', state }
    expect(beforeTechnical(panel.html(phone))).toContain(label)
  }
})

test('migration confirmation discloses verified keyless S3 backup and automatic source cleanup without promising retained Redis data', async () => {
  const panel = new SessionStoragePanel({ request: jest.fn().mockResolvedValue(status) } as any, jest.fn())
  await panel.action('storage-open', phone)
  expect(panel.dialog()).toContain('Após validação e backup verificado no S3')
  expect(panel.dialog()).toContain('Novos backups não usam criptografia nem chave.')
  expect(panel.dialog()).toContain('Configuração e coordenação permanecem')
  expect(panel.dialog()).not.toContain('A origem Redis será mantida')
  panel.reset()
})

test('backup schedule remains concise and exposes safe status in technical details', () => {
  const panel = new SessionStoragePanel({} as any, jest.fn()); panel.phone = phone
  panel.status = { ...status, backend: 'sqlite', backupPolicy: { enabled: true, intervalHours: 12, destination: 's3', schedule: { phase: 'failed', lastError: { code: 'session_storage_backup_failed' } } } }
  const html = panel.html(phone)
  expect(beforeTechnical(html)).not.toContain('session_storage_backup_failed')
  expect(plainText(html)).toContain('Backup automático S3 A cada 12 horas')
  expect(html).toContain('session_storage_backup_failed')
})
