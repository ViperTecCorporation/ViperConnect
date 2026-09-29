import { SessionTransfersPanel } from '../../frontend/features/session_transfers'
const data = (values: Record<string, string>) => { const form = new FormData(); Object.entries(values).forEach(([k, v]) => form.set(k, v)); return form }
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
