import { VoipBackupPanel } from '../../frontend/features/voip_backups'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const state = { enabled: true, automatic: true, prefix: 'backups/voip/synthetic/', bucket: 'private', files: [{ id, day: 1, createdAt: '2026-11-10T12:00:00Z', bytes: 100 }] }
test('backup/restore controls require confirmation and a verified backend result, never an optimistic success', async () => {
  const api: any = { request: jest.fn().mockResolvedValue(state) }, panel = new VoipBackupPanel(api, jest.fn())
  await panel.action('voip-backup-open'); await panel.action('voip-backup-create')
  expect(panel.dialog()).toContain('Gravações não são incluídas')
  await panel.submit(new FormData()); expect(api.request).toHaveBeenCalledTimes(1)
  const data = new FormData(); data.set('confirm', 'on')
  api.request.mockResolvedValueOnce({ status: 'ready', uploadVerified: true }).mockResolvedValueOnce(state)
  await panel.submit(data)
  expect(panel.notice).toContain('confirmado no S3')
  await panel.action('voip-backup-restore', id); api.request.mockResolvedValueOnce({ restored: false })
  await panel.submit(data)
  expect(panel.error).toContain('não confirmou'); expect(panel.error).toContain('Não houve repetição')
  expect(api.request.mock.calls.filter(([, init]: any) => init?.method === 'POST')).toHaveLength(2)
})
test('pending restore disables a second restore, escapes metadata and ignores late status after close', async () => {
  const api: any = { request: jest.fn().mockResolvedValue({ ...state, prefix: '<script>unsafe</script>', state: { phase: 'restore_unconfirmed' } }) }, panel = new VoipBackupPanel(api, jest.fn())
  await panel.action('voip-backup-open')
  expect(panel.dialog()).not.toContain('<script>unsafe</script>'); expect(panel.dialog()).toContain('pendente de confirmação')
  expect(panel.dialog()).toContain('data-action="voip-backup-upload" disabled')
  let resolve!: (value: any) => void; api.request.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const pending = panel.action('voip-backup-refresh'); panel.reset(); resolve(state); await pending
  expect(panel.open).toBe(false); expect(panel.status).toBeUndefined()
})
