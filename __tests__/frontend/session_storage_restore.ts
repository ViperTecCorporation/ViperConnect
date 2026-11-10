import { ApiClient, ApiError } from '../../frontend/core/api'
import { SessionStoragePanel, type SessionStorageStatus, type SessionStorageTask } from '../../frontend/features/session_storage'
import { storageRestoreAvailable } from '../../frontend/features/session_storage_view'

const phone = '999123456789', maximum = 256 * 1024 * 1024
const status: SessionStorageStatus = { backend: 'sqlite', owner: 'fixture-worker', generation: 3, state: 'offline', autoConnect: false, connectionStatus: 'offline',
  restoreUpload: { available: true }, capability: { sqliteAvailable: true, defaultBackend: 'sqlite' },
  backupPolicy: { enabled: true, intervalHours: 12, destination: 's3', protection: 'none', location: { bucket: 'private-backups', prefix: `backups/session-storage/${phone}/`, slotsPrefix: `backups/session-storage/${phone}/slots/` },
    retention: { strategy: 'weekday-slots', slots: 7, timeZone: 'America/Cuiaba', replacement: 'latest-verified' } }, lastBackup: { objectKey: `backups/session-storage/${phone}/fixture.viperstorage`, protection: 'none' } }
const task: SessionStorageTask = { id: 'restore-task', phone, operation: 'restore', status: 'queued' }
const file = (name = 'sessao.viperstorage', size?: number) => { const value = new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'application/octet-stream' }); if (size !== undefined) Object.defineProperty(value, 'size', { value: size }); return value }
const data = (archive?: File | string, confirm = true) => { const form = new FormData(); if (confirm) form.set('confirm', 'on'); if (archive !== undefined) form.set('archive', archive); return form }
const setup = (snapshot: SessionStorageStatus = status) => {
  const api = { request: jest.fn().mockResolvedValue(task) }, render = jest.fn(), panel = new SessionStoragePanel(api as any, render)
  panel.phone = phone; panel.status = snapshot; panel.modal = true; panel.restoreMode = true
  return { api, render, panel }
}
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

test('backup disclosure shows escaped bucket/prefix/weekly retention, starts collapsed and never exposes unrelated secret fields', async () => {
  const snapshot: any = { ...status, backupPolicy: { ...status.backupPolicy, location: { bucket: '<private-bucket>', prefix: 'backups/<img src=x>/', slotsPrefix: 'slots/<script>/' }, credentials: { secretAccessKey: 'DO_NOT_RENDER' } } }
  const { panel } = setup(snapshot), html = panel.html(phone)
  expect(html).toContain('Backup e restauração'); expect(html).toContain('&lt;private-bucket&gt;'); expect(html).toContain('backups/&lt;img src=x&gt;/')
  expect(html).toContain('7 slots · último backup de cada dia da semana'); expect(html).toContain('America/Cuiaba')
  expect(html).not.toContain('DO_NOT_RENDER'); expect(html).not.toContain('<script>')
  const toggle = (html.match(/<button\b[^>]*>/g) || []).find(value => value.includes('data-action="storage-toggle-backups"'))!
  expect(toggle).toContain('aria-expanded="false"')
  await panel.action('storage-toggle-backups'); expect(panel.html(phone)).toMatch(/data-action="storage-toggle-backups" aria-expanded="true"/)
  expect(panel.html(phone)).not.toContain('<form'); expect(panel.html(phone)).not.toContain('type="file"')
  panel.reset()
})

test('opening restore only reads status and presents one dedicated form without nesting backup/migration forms, password or technical rerenders', async () => {
  const { panel, api } = setup(); api.request.mockResolvedValue(status as any)
  await panel.action('storage-restore-open', phone)
  const html = panel.dialog()
  expect(api.request).toHaveBeenCalledTimes(1); expect(api.request).toHaveBeenCalledWith(`/v15.0/${phone}/storage`)
  expect(html.match(/<form\b/g)).toHaveLength(1); expect(html).toContain('data-form="storage-restore-upload"')
  expect(html).toContain('type="file" name="archive"'); expect(html).toContain('.viperstorage'); expect(html).toContain('256 MiB')
  expect(html).toContain('sem conectar nem reenviar mensagens'); expect(html).not.toContain('type="password"')
  expect(html).toContain('Novos backups não usam criptografia nem chave.')
  expect(html).toContain('Somente backups antigos criptografados exigem a chave correspondente configurada no worker.')
  expect(html).toContain('O navegador não solicita nem recebe essa chave.')
  expect(html).toContain('O arquivo contém credenciais: mantenha-o privado.')
  expect(html).toContain('Um .sqlite isolado não substitui o pacote de backup.')
  expect(html).not.toContain('data-form="storage-backup"'); expect(html).not.toContain('data-action="storage-toggle-technical"')
  expect(html).not.toContain('name="backupPassword"'); panel.reset()
})

test.each(['none', 'aes-256-gcm', undefined])('restore accepts optional protection metadata without requiring a browser key or changing offline authorization: %s', protection => {
  const { panel } = setup({ ...status, lastBackup: { ...status.lastBackup, protection } })
  expect(storageRestoreAvailable(panel.status)).toBe(true)
  const html = panel.dialog()
  expect(html).not.toMatch(/type="file"[^>]*disabled/)
  expect(html).toContain('Somente backups antigos criptografados exigem a chave correspondente configurada no worker.')
  expect(html).not.toContain('type="password"')
  expect(html).not.toMatch(/name="(?:key|password|backupKey|backupPassword)"/)
  panel.reset()
})

test('new backup confirmation explains unencrypted credentials and private S3 without requiring a key', async () => {
  jest.useFakeTimers()
  const { panel, api } = setup(); panel.restoreMode = false
  const html = panel.dialog()
  expect(html).toContain('Crie um backup sem criptografia dos dados e credenciais desta sessão.')
  expect(html).toContain('Confirmo a geração do backup sem criptografia.')
  expect(html).toContain('Requer destino S3 privado. Novos backups não usam chave e contêm credenciais')
  expect(html).toContain('>Gerar backup</button>')
  expect(html).not.toContain('Requer destino S3 e criptografia configurados')
  expect(html).not.toContain('type="password"')
  const overview = panel.html(phone)
  expect(overview).toContain('<dt>Proteção dos novos backups</dt><dd>Sem criptografia</dd>')
  expect(overview).toContain('<dt>Proteção do último backup</dt><dd>Sem criptografia</dd>')
  api.request.mockResolvedValueOnce({ ...task, kind: 'backup', operation: 'backup' })
  await panel.submit('storage-backup', data())
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(api.request).toHaveBeenCalledWith(`/v15.0/${phone}/storage/backups`, { method: 'POST', body: JSON.stringify({ confirm: true }) })
  panel.reset()
})

test.each([
  { state: 'active' }, { state: 'migrating' }, { state: 'restoring' }, { autoConnect: true }, { autoConnect: undefined },
  { connectionStatus: 'online' }, { connectionStatus: 'connecting' }, { connectionStatus: undefined }, { restoreUpload: undefined },
  { restoreUpload: { available: false } }, { capability: { sqliteAvailable: false, defaultBackend: 'redis' } }, { backend: 'redis' },
])('upload fails closed when offline/worker authorization is not explicit: %j', async patch => {
  const { panel, api } = setup({ ...status, ...patch } as SessionStorageStatus)
  expect(storageRestoreAvailable(panel.status)).toBe(false)
  expect(panel.dialog()).toMatch(/type="file"[^>]*disabled/)
  await panel.submit('storage-restore-upload', data(file()))
  expect(api.request).not.toHaveBeenCalled(); expect(panel.error).not.toBe(''); panel.reset()
})

test('disconnected canonical status is eligible only with all remaining guards and no active task/busy upload', () => {
  expect(storageRestoreAvailable({ ...status, connectionStatus: 'disconnected' })).toBe(true)
  expect(storageRestoreAvailable(status, task)).toBe(false); expect(storageRestoreAvailable(status, undefined, true)).toBe(false)
  expect(storageRestoreAvailable(undefined)).toBe(false)
})

test.each(['missing', 'string', 'extension', 'empty', 'oversized', 'unconfirmed'])('file validation rejects %s without reading bytes or submitting', async reason => {
  const { panel, api } = setup()
  const archive = reason === 'missing' ? undefined : reason === 'string' ? 'not-a-file' : file(reason === 'extension' ? 'raw.sqlite' : 'backup.viperstorage', reason === 'empty' ? 0 : reason === 'oversized' ? maximum + 1 : undefined)
  await panel.submit('storage-restore-upload', data(archive, reason !== 'unconfirmed'))
  expect(api.request).not.toHaveBeenCalled(); expect(panel.error).not.toBe('')
  expect(panel.error).not.toContain('criptografado')
  if (reason !== 'unconfirmed') expect(panel.dialog()).toContain('256 MiB')
  panel.reset()
})

test('ApiClient passes the File directly as binary BodyInit, without file.text/arrayBuffer, JSON conversion, password or actual fetch', async () => {
  jest.useFakeTimers()
  const archive = file('BACKUP.VIPERSTORAGE', maximum), text = jest.spyOn(archive, 'text'), buffer = jest.spyOn(archive, 'arrayBuffer')
  const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(task), { status: 202, headers: { 'Content-Type': 'application/json' } }))
  const api = new ApiClient('https://example.invalid', fetcher as any); api.setToken('mgr_synthetic')
  const panel = new SessionStoragePanel(api, jest.fn()); panel.phone = phone; panel.status = status; panel.modal = true; panel.restoreMode = true
  await panel.submit('storage-restore-upload', data(archive))
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe(`https://example.invalid/v15.0/${phone}/storage/restore-upload?confirm=true&mode=offline`)
  expect(init.method).toBe('POST'); expect(init.body).toBe(archive)
  const headers = new Headers(init.headers); expect(headers.get('Content-Type')).toBe('application/octet-stream')
  expect(headers.get('Authorization')).toBe('Bearer mgr_synthetic')
  expect(text).not.toHaveBeenCalled(); expect(buffer).not.toHaveBeenCalled()
  expect(panel.task?.status).toBe('queued'); expect(panel.modal).toBe(false); expect(panel.notice).toContain('nenhuma conexão')
  expect(panel.notice).not.toContain('concluída'); panel.reset()
})

test('double submit and background polling cannot automatically resend an accepted archive', async () => {
  jest.useFakeTimers(); const { panel, api } = setup(); await panel.submit('storage-restore-upload', data(file()))
  await panel.submit('storage-restore-upload', data(file()))
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  panel.reset(); jest.advanceTimersByTime(10000); expect(api.request).toHaveBeenCalledTimes(1)
})

test('server offline conflict or transport failure leaves restore open, reports no automatic retry and never connects', async () => {
  for (const failure of [new ApiError(409, 'session_storage_restore_requires_offline'), new Error('upload transport unavailable')]) {
    const { panel, api } = setup(); api.request.mockRejectedValueOnce(failure)
    await panel.submit('storage-restore-upload', data(file()))
    expect(api.request).toHaveBeenCalledTimes(1); expect(panel.task).toBeUndefined(); expect(panel.modal).toBe(true); expect(panel.restoreMode).toBe(true)
    expect(panel.error).toContain('Não houve repetição automática'); expect(panel.dialog()).toContain('Não houve repetição automática')
    expect(api.request.mock.calls.every(([url]) => !/connect|register|messages/.test(String(url)))).toBe(true); panel.reset()
  }
})

test.each(['foreign-phone', 'wrong-kind', 'failed'])('invalid/failed accepted task does not close restore confirmation: %s', async reason => {
  const { panel, api } = setup(); api.request.mockResolvedValueOnce(reason === 'foreign-phone' ? { ...task, phone: 'other' } : reason === 'wrong-kind' ? { ...task, operation: 'migration' } : { ...task, status: 'failed', error: 'session_storage_restore_failed' })
  await panel.submit('storage-restore-upload', data(file()))
  expect(panel.modal).toBe(true); expect(panel.restoreMode).toBe(true); expect(panel.error).not.toBe(''); expect(api.request).toHaveBeenCalledTimes(1); panel.reset()
})

test('successful restore polling reloads status and uses restore wording, without initiating a connection', async () => {
  jest.useFakeTimers(); const { panel, api } = setup()
  api.request.mockResolvedValueOnce(task).mockResolvedValueOnce({ ...task, status: 'ready', result: { autoConnect: false } }).mockResolvedValueOnce(status as any)
  await panel.submit('storage-restore-upload', data(file())); await panel.checkTask()
  expect(panel.notice).toContain('Restauração concluída pelo worker'); expect(panel.notice).not.toContain('Migração')
  expect(panel.html(phone)).toContain('Restauração concluída · Sem reconexão')
  expect(panel.status?.autoConnect).toBe(false); expect(api.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(api.request.mock.calls.every(([url]) => !/connect|register|messages/.test(String(url)))).toBe(true); panel.reset()
})

test('reset during upload discards the old session task and clears restore confirmation without another POST', async () => {
  jest.useFakeTimers(); const { panel, api } = setup(); let resolve!: (value: SessionStorageTask) => void
  api.request.mockReturnValueOnce(new Promise<SessionStorageTask>(done => { resolve = done }))
  const uploading = panel.submit('storage-restore-upload', data(file())); expect(panel.busy).toBe(true)
  panel.reset(); resolve(task); await uploading
  expect(panel.task).toBeUndefined(); expect(panel.modal).toBe(false); expect(panel.restoreMode).toBe(false); expect(jest.getTimerCount()).toBe(0)
  expect(api.request).toHaveBeenCalledTimes(1)
})
