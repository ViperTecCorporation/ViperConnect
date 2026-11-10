import { ApiClient, ApiError } from '../../frontend/core/api'
import { SessionTransfersPanel } from '../../frontend/features/session_transfers'
import { SessionStorageImport, storageImportError } from '../../frontend/features/session_storage_import'
import { renderSessionPage } from '../../frontend/pages/session'
import { ViperConnectApp } from '../../frontend/app'

const phone = '999123456789', owner = 'worker_fixture'
const task = { id: 'restore-id', phone, owner, operation: 'restore', status: 'running' }
const ready = { ...task, status: 'ready', result: { restored: true, phone, status: 'offline', autoConnect: false, connected: false } }
const workers = { workers: [{ owner, available: true }] }
const file = (name = 'backup.viperstorage', size?: number) => {
  const selected = new File(['{"format":"viperconnect-storage-backup-stream"}\n'], name, { type: 'application/octet-stream' })
  if (size !== undefined) Object.defineProperty(selected, 'size', { value: size })
  return selected
}
const form = (patch: Record<string, string> = {}) => {
  const value = new FormData()
  for (const [key, item] of Object.entries({ phone, owner, confirmOriginOffline: 'on', ...patch })) value.set(key, item)
  return value
}
const setup = () => {
  const api = { request: jest.fn(async (path: string, init?: RequestInit) => path.endsWith('/workers') ? workers : init?.method === 'POST' ? task : ready) }
  const render = jest.fn(), panel = new SessionTransfersPanel(api as any, render)
  panel.modal = 'restore'
  return { api, panel, render, importer: panel.sqliteImport }
}
beforeEach(() => jest.useFakeTimers())
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

test('global restore detects SQLite without an existing session, loads only worker capabilities and shows an offline confirmation', async () => {
  const { panel, api, importer } = setup()
  expect(panel.dialog()).toContain('accept=".viperstorage,.vipersession,.viperdevice"')
  await expect(panel.selectRestoreFile(file())).resolves.toBe(true)
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(api.request).toHaveBeenCalledWith('/manager/storage/workers')
  expect(importer.workers).toEqual(workers.workers)
  expect(panel.dialog()).toContain('data-form="transfer-sqlite-restore"')
  expect(panel.dialog()).toContain('name="phone"'); expect(panel.dialog()).toContain('name="owner"')
  expect(panel.dialog()).toContain('origem está parada')
  expect(panel.dialog()).toContain('Restaurar sessão offline')
  expect(panel.dialog()).not.toContain('type="password"')
  expect(panel.dialog()).not.toContain('data-form="transfer-restore"')
  expect(api.request.mock.calls.every(([, init]) => !init?.method)).toBe(true)
  panel.reset()
})

test('SQLite archive is raw binary with explicit phone/owner/offline confirmation and no text/Base64 conversion or implicit connection', async () => {
  const archive = file(), text = jest.spyOn(archive, 'text'), bytes = jest.spyOn(archive, 'arrayBuffer')
  const fetcher = jest.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/workers') ? workers : task), { status: url.endsWith('/workers') ? 200 : 202, headers: { 'Content-Type': 'application/json' } }))
  const api = new ApiClient('https://example.invalid', fetcher as any); api.setToken('mgr_test_login')
  const importer = new SessionStorageImport(api, jest.fn())
  await importer.select(archive); await importer.submit(form())
  expect(fetcher).toHaveBeenCalledTimes(2)
  const [url, init] = fetcher.mock.calls[1] as any
  expect(url).toBe(`https://example.invalid/manager/storage/restore-upload?phone=${phone}&owner=${owner}&confirmOriginOffline=true&mode=offline`)
  expect(url).not.toContain('mgr_test_login')
  expect(init.body).toBe(archive); expect(init.method).toBe('POST')
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream')
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer mgr_test_login')
  expect(text).not.toHaveBeenCalled(); expect(bytes).not.toHaveBeenCalled()
  expect(importer.task?.status).toBe('running'); expect(importer.notice).not.toContain('Sessão restaurada')
  expect(importer.file).toBeUndefined()
  expect(fetcher.mock.calls.every(([target]) => !/connect|register|messages/.test(target))).toBe(true)
  importer.reset()
})

test.each(['empty', 'oversized', 'wrong-extension'])('invalid %s archive never asks a worker or uploads bytes', async reason => {
  const { importer, api, panel } = setup()
  await importer.select(file(reason === 'wrong-extension' ? 'session.sqlite' : 'backup.viperstorage', reason === 'empty' ? 0 : reason === 'oversized' ? 256 * 1024 * 1024 + 1 : undefined))
  await importer.submit(form())
  expect(api.request).not.toHaveBeenCalled(); expect(importer.error).toContain('.viperstorage')
  panel.reset()
})

test.each([{ phone: 'invalid' }, { owner: 'other-worker' }, { confirmOriginOffline: '' }])('invalid target or missing origin confirmation never uploads: %j', async patch => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file()); await importer.submit(form(patch))
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(importer.error).not.toBe('')
  panel.reset()
})

test('unavailable and malformed workers cannot be selected and untrusted metadata never enters the markup', async () => {
  const { importer, api, panel } = setup()
  api.request.mockResolvedValueOnce({ workers: [{ owner: '<script>', available: true }, { owner, available: false, reason: 'SECRET_PATH' }], secret: 'DO_NOT_RENDER' } as any)
  await importer.select(file())
  expect(importer.html()).toContain('indisponível')
  expect(importer.html()).not.toContain('<script>'); expect(importer.html()).not.toContain('DO_NOT_RENDER'); expect(importer.html()).not.toContain('SECRET_PATH')
  await importer.submit(form())
  expect(api.request).toHaveBeenCalledTimes(1)
  panel.reset()
})

test('accepted restore is polled without resending and only confirmed offline success enables manual management', async () => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file()); await panel.submit('transfer-sqlite-restore', form())
  await panel.submit('transfer-sqlite-restore', form())
  expect(panel.dialog()).not.toContain('data-form="transfer-sqlite-restore"')
  expect(panel.dialog()).toContain('Consultar restauração')
  await importer.check()
  expect(api.request).toHaveBeenLastCalledWith(`/manager/storage/restores/${phone}/restore-id`)
  expect(importer.successPhone()).toBe(phone)
  expect(panel.dialog()).toContain('Gerenciar sessão restaurada')
  expect(importer.notice).toContain('mantida offline')
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(api.request.mock.calls.every(([path]) => !/connect|register|messages/.test(path))).toBe(true)
  await panel.action('transfer-sqlite-another', '')
  expect(panel.dialog()).toContain('data-session-backup-file'); expect(importer.task).toBeUndefined()
  panel.reset()
})

test.each(['wrong-phone', 'connected', 'missing-offline', 'not-restored'])('ready without a valid offline result is not announced as successful: %s', async reason => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file()); await importer.submit(form())
  const result: any = { ...ready.result }
  if (reason === 'wrong-phone') result.phone = '999123456788'
  if (reason === 'connected') result.connected = true
  if (reason === 'missing-offline') delete result.status
  if (reason === 'not-restored') result.restored = false
  api.request.mockResolvedValueOnce({ ...ready, result } as any)
  await importer.check()
  expect(importer.successPhone()).toBe('')
  expect(importer.error).toContain('não confirmou')
  expect(panel.dialog()).not.toContain('transfer-view-restored')
  panel.reset()
})

test.each(['network', 'foreign-task'])('uncertain %s result survives closing/reopening and never authorizes a second POST', async reason => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file())
  if (reason === 'network') api.request.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  else api.request.mockResolvedValueOnce({ ...task, phone: '999123456788' } as any)
  await importer.submit(form())
  expect(importer.uncertain).toBe(true)
  await panel.action('transfer-close', ''); await panel.action('transfer-restore', '')
  await importer.submit(form()); await panel.selectRestoreFile(file('other.viperstorage'))
  expect(panel.dialog()).toContain('Resultado incerto')
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(panel.dialog()).not.toContain('data-form="transfer-sqlite-restore"')
  panel.reset()
})

test('409 destination conflict is explicit, does not overwrite/register/connect and is never automatically repeated', async () => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file())
  api.request.mockRejectedValueOnce(new ApiError(409, 'conflict', { error_code: 'session_storage_standalone_destination_exists' }))
  await importer.submit(form()); jest.advanceTimersByTime(10000)
  expect(importer.error).toContain('Nada foi sobrescrito')
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(api.request.mock.calls.every(([path]) => !/connect|register|messages/.test(path))).toBe(true)
  expect(storageImportError('session_storage_backup_legacy_key_required')).toContain('worker')
  panel.reset()
})

test('poll failure stops automatic consultations and leaves only a manual query, never another upload', async () => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file()); await importer.submit(form())
  api.request.mockRejectedValueOnce(new Error('temporary read failure'))
  await importer.check(); const calls = api.request.mock.calls.length
  jest.advanceTimersByTime(10000)
  expect(api.request).toHaveBeenCalledTimes(calls)
  expect(importer.html()).toContain('Consultar restauração')
  expect(importer.html()).toContain('não envie o arquivo novamente')
  panel.reset()
})

test('logout/reset discards an old worker response or accepted task without more uploads or timers', async () => {
  const { panel, importer, api } = setup()
  await panel.selectRestoreFile(file())
  let accept!: (value: unknown) => void
  api.request.mockReturnValueOnce(new Promise(resolve => { accept = resolve }) as any)
  const posting = importer.submit(form()); panel.reset(); accept(task); await posting
  expect(importer.task).toBeUndefined(); expect(importer.file).toBeUndefined(); expect(jest.getTimerCount()).toBe(0)
})

test('ordinary .viperdevice import keeps the original mobile endpoint, password and connection semantics', async () => {
  const api = { request: jest.fn().mockResolvedValue({ restored: true }) }, panel = new SessionTransfersPanel(api as any, jest.fn())
  const data = new FormData(); data.set('archive', new File(['{}'], 'legacy.viperdevice')); data.set('password', 'synthetic-password'); data.set('confirm', 'on')
  panel.modal = 'restore'; await panel.submit('transfer-restore', data)
  expect(api.request).toHaveBeenCalledWith('/manager/mobile-devices/restore', expect.objectContaining({ method: 'POST', body: JSON.stringify({ archive: '{}', password: 'synthetic-password', confirmOriginOffline: true }) }))
  expect(panel.notice).toContain('conexão automática habilitada')
  panel.reset()
})

test.each(['status', 'descriptor'])('SQLite overview hides duplicate Redis transfer/removal while keeping unified storage: %s', source => {
  const options: any = { session: { phone, provider: 'zapo', ...(source === 'descriptor' ? { sessionStorage: { backend: 'sqlite' } } : {}) }, ...(source === 'status' ? { storageBackend: 'sqlite' } : {}), tab: 'overview', canManageUsers: true, storageHtml: '<section>Armazenamento unificado</section>', contacts: [], groups: [] }
  const html = renderSessionPage(options)
  expect(html).toContain('Armazenamento unificado'); expect(html).not.toContain('Backup e migração')
  expect(html).not.toContain('transfer-remove')
  expect(renderSessionPage({ ...options, storageBackend: 'redis', session: { phone, provider: 'zapo' } })).toContain('transfer-open')
})

test.each(['admin', 'user'])('manage restored session is an explicit admin read action, never an automatic connect: %s', async role => {
  const app = Object.create(ViperConnectApp.prototype) as any
  app.identity = { role }; app.sessionTransfers = { restoredPhone: () => phone, action: jest.fn() }
  app.loadSessions = jest.fn(); app.openSession = jest.fn()
  const action = { dataset: { action: 'transfer-view-restored', id: phone } }
  await app.handleClick({ target: { closest: (selector: string) => selector === '[data-action]' ? action : null, matches: () => false } })
  expect(app.openSession).toHaveBeenCalledTimes(role === 'admin' ? 1 : 0)
  if (role === 'admin') { expect(app.loadSessions).toHaveBeenCalledWith(true); expect(app.openSession).toHaveBeenCalledWith(phone) }
})
