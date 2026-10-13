import { SessionTransfersPanel, sessionBackupFailure, isStreamSessionBackup, describeSessionBackup } from '../../frontend/features/session_transfers'
import { ApiError } from '../../frontend/core/api'
import { webcrypto } from 'node:crypto'
beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }) })
import { renderSessionPage } from '../../frontend/pages/session'
const data = (values: Record<string, string>) => { const form = new FormData(); Object.entries(values).forEach(([k, v]) => form.set(k, v)); return form }

test('file feedback reads only a bounded header and explains selection, legacy limits and large stream backups', async () => {
  const file: any = { name: 'large.vipersession', size: 576 * 1024 * 1024, slice: jest.fn(() => new Blob(['{"salt":"x","format":"viperconnect-session-stream-v2"}\n'])) }
  expect(await isStreamSessionBackup(file)).toBe(true)
  expect(await describeSessionBackup(file)).toContain('576.0 MiB')
  expect(await describeSessionBackup(file)).toContain('A seleção não inicia o envio')
  expect(file.slice).toHaveBeenCalledWith(0, 1024)
  file.slice.mockReturnValue(new Blob(['{"format":"legacy"}']))
  expect(await describeSessionBackup(file)).toContain('Formato não reconhecido')
  file.size = 10
  expect(await describeSessionBackup(file)).toContain('Formato legado')
  expect(await isStreamSessionBackup(new Blob(['not json']))).toBe(false)
  const panel = new SessionTransfersPanel({} as any, jest.fn()); panel.modal = 'restore'
  expect(panel.dialog()).toContain('data-session-backup-file')
  expect(panel.dialog()).toContain('Somente o formato legado')
})

test('proxy upload rejection is visible instead of a generic transfer failure', async () => {
  const api = { request: jest.fn().mockRejectedValue(new ApiError(413, 'Too large')) }
  const panel = new SessionTransfersPanel(api as any, jest.fn()), form = data({ password: 'synthetic-password', confirm: 'on' })
  form.set('archive', new Blob(['{"format":"viperconnect-session-stream-v2"}\n']), 'test.vipersession')
  panel.modal = 'restore'
  await panel.submit('transfer-restore', form)
  expect(panel.error).toContain('HTTP 413'); expect(panel.dialog()).toContain('HTTP 413')
})

test('pending or completed restore blocks a second import and allows result consultation', async () => {
  for (const state of ['restoring', 'interrupted', 'ready']) {
    const api = { request: jest.fn(async () => ({ state, id: 'previous', error: state === 'interrupted' ? 'session_restore_interrupted' : undefined })) }
    const panel = new SessionTransfersPanel(api as any, jest.fn()); panel.restoreUploadId = 'previous'; panel.modal = 'restore'
    const form = data({ password: 'synthetic-password', confirm: 'on' })
    form.set('archive', new Blob(['{"format":"viperconnect-session-stream-v2"}\n']), 'test.vipersession')
    await panel.submit('transfer-restore', form)
    expect(panel.error).toContain('Já existe uma restauração')
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(panel.dialog()).toContain('Consultar restauração')
    await panel.action('transfer-check-restore', '')
    expect(panel.notice).toContain(state === 'ready' ? 'Sessão restaurada' : state)
  }
})

test('stream backups download binary bytes and show actionable failure codes', async () => {
  const blob = new Blob(['encrypted']), api = { request: jest.fn().mockResolvedValue({ streamed: true, fileName: 'synthetic.vipersession' }), downloadBackup: jest.fn().mockResolvedValue(blob) }
  const panel = new SessionTransfersPanel(api as any, jest.fn())
  panel.tasks = [{ id: 'task', deviceId: '999123456789', status: 'ready', expiresAt: Date.now() + 86400000 } as any]
  await panel.action('transfer-download', '999123456789')
  expect(api.downloadBackup).toHaveBeenCalledWith('/manager/session-transfers/999123456789/backup-tasks/task/download/file')
  expect(panel.file?.archive).toBe(blob)
  expect(sessionBackupFailure('mobile_backup_too_large')).toContain('formato antigo')
  expect(sessionBackupFailure('session_backup_storage_failed')).toContain('storage')
  expect(sessionBackupFailure('unexpected')).toContain('unexpected')
})

test('stream restore uploads binary file without reading its entire content as text', async () => {
  const api = { request: jest.fn(async (path: string) => path.endsWith('restore-uploads') ? { id: 'test', partSize: 8 * 1024 * 1024, parts: 3 } : path.endsWith('/test') ? { state: 'ready', result: {} } : path.includes('/parts/') ? { received: Number(path.split('/').pop()) + 1, parts: 3 } : {}) }, panel = new SessionTransfersPanel(api as any, jest.fn())
  const form = data({ password: 'synthetic-password', confirm: 'on' })
  form.set('archive', new Blob(['{"format":"viperconnect-session-stream-v2"}\n', 'x'.repeat(17 * 1024 * 1024)]), 'synthetic.vipersession')
  await panel.submit('transfer-restore', form)
  expect(api.request).toHaveBeenCalledWith('/manager/session-transfers/restore-uploads/test/parts/0', expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/octet-stream' }), body: expect.any(Blob) }))
  expect(panel.error).toBe('')
})
test('overview exposes local deletion only to administrators of linked Zapo sessions', () => {
  const options: any = { session: { phone: '999123456789', provider: 'zapo' }, tab: 'overview', canManageUsers: true, contacts: [], groups: [], contactCount: 0 }
  expect(renderSessionPage(options)).toContain('data-action="transfer-remove"')
  expect(renderSessionPage(options)).toContain('Excluir desta instância')
  expect(renderSessionPage({ ...options, canManageUsers: false })).not.toContain('data-action="transfer-remove"')
  expect(renderSessionPage({ ...options, session: { ...options.session, mobilePrimaryDraftId: 'draft' } })).not.toContain('data-action="transfer-remove"')
})
test('normal-session backup is asynchronous and restore is available even with no tasks', async () => {
  const api = { request: jest.fn().mockResolvedValue({ eligible: false }) }
  const panel = new SessionTransfersPanel(api as any, jest.fn())
  expect(panel.html()).toContain('Nenhum backup solicitado')
  expect(panel.html()).toContain('transfer-restore')
  await panel.action('transfer-open', '999123456789')
  expect(panel.dialog()).toContain('data-form="transfer-backup"')
  expect(panel.dialog()).not.toContain('transfer-remove')
  api.request.mockResolvedValue({ id: 'task', deviceId: '999123456789', status: 'running' })
  await panel.submit('transfer-backup', data({ password: 'test-password-123', passwordConfirmation: 'test-password-123', confirm: 'on', mode: 'complete' }))
  expect(panel.modal).toBeUndefined(); expect(panel.html()).toContain('Gerando em segundo plano')
  expect(api.request).toHaveBeenCalledWith('/manager/session-transfers/999123456789/backup-tasks', expect.anything())
  expect(JSON.stringify(panel.tasks)).not.toContain('test-password-123')
})

test('direct deletion button opens confirmation and trims phone before submission', async () => {
  const api = { request: jest.fn().mockResolvedValue({}) }
  const panel = new SessionTransfersPanel(api as any, jest.fn())
  await panel.action('transfer-remove', '999123456789')
  expect(panel.dialog()).toContain('data-form="transfer-remove"')
  await panel.submit('transfer-remove', data({ confirm: 'on', backupValidated: 'on', phone: ' 999123456789 ', password: 'synthetic' }))
  expect(api.request).toHaveBeenCalledWith('/manager/session-transfers/999123456789/transfer-removal', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ phone: '999123456789', password: 'synthetic', confirm: true, backupValidated: true }) }))
})
test('removal requires phone, admin password and destination confirmation; reset clears retained state', async () => {
  const api = { request: jest.fn().mockResolvedValue({ eligible: true }) }
  const panel = new SessionTransfersPanel(api as any, jest.fn())
  await panel.action('transfer-open', '999123456789')
  expect(panel.dialog()).toContain('transfer-remove')
  await panel.action('transfer-remove', '999123456789')
  expect(panel.dialog()).toContain('O backup foi validado no novo servidor?')
  api.request.mockClear()
  await panel.submit('transfer-remove', data({ confirm: 'on' }))
  expect(api.request).not.toHaveBeenCalled()
  panel.reset(); expect(panel.modal).toBeUndefined(); expect(panel.tasks).toEqual([])
})
