import { SessionTransfersPanel } from '../../frontend/features/session_transfers'
import { renderSessionPage } from '../../frontend/pages/session'
const data = (values: Record<string, string>) => { const form = new FormData(); Object.entries(values).forEach(([k, v]) => form.set(k, v)); return form }
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
