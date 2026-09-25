import { renderMobileBackup, transferMobileBackup, downloadMobileBackup } from '../../frontend/features/mobile_backup'
import { MobileDevicesPanel } from '../../frontend/features/mobile_devices'

const form = () => { const data = new FormData(); data.set('password', 'test-backup-password'); data.set('passwordConfirmation', 'test-backup-password'); data.set('confirm', 'on'); return data }
test('new device modal exposes restore, with offline consent and password fields', () => {
  const panel = new MobileDevicesPanel({} as any, jest.fn()); panel.enabled = true; panel.action('mobile-new')
  expect(panel.renderDialog()).toContain('Restaurar dispositivo')
  panel.action('mobile-restore')
  expect(panel.renderDialog()).toContain('name="archive"')
  expect(panel.renderDialog()).toContain('origem está desconectada')
  expect(renderMobileBackup(false, true)).toContain('disabled')
  expect(renderMobileBackup(false, false)).toContain('name="passwordConfirmation"')
})
test('export requires password confirmation and consent; restore sends encrypted file only on submit', async () => {
  const api = { request: jest.fn().mockResolvedValue({ archive: 'encrypted', fileName: 'test.viperdevice' }) }
  const data = form(); data.set('passwordConfirmation', 'mismatch')
  await expect(transferMobileBackup(api as any, false, 'draft', data)).rejects.toThrow('senhas')
  expect(api.request).not.toHaveBeenCalled()
  await transferMobileBackup(api as any, false, 'draft', form())
  expect(api.request.mock.calls[0][0]).toBe('/manager/mobile-devices/draft/backup')
  const restore = form(); restore.set('archive', new Blob(['encrypted']), 'test.viperdevice')
  await transferMobileBackup(api as any, true, undefined, restore)
  expect(JSON.parse(api.request.mock.calls[1][1].body)).toMatchObject({ archive: 'encrypted', confirmOriginOffline: true })
  restore.delete('confirm')
  await expect(transferMobileBackup(api as any, true, undefined, restore)).rejects.toThrow('suspensão')
})
test('download uses a temporary blob URL and cleans it up', () => {
  jest.useFakeTimers()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const anchor = { click: jest.fn(), remove: jest.fn(), href: '', download: '' }
  const create = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic')
  const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => anchor, body: { appendChild: jest.fn() } } })
  try {
    downloadMobileBackup({ archive: 'encrypted', fileName: 'test.viperdevice' })
    expect(anchor.click).toHaveBeenCalled(); expect(anchor.remove).toHaveBeenCalled()
    jest.runAllTimers(); expect(revoke).toHaveBeenCalledWith('blob:synthetic')
  } finally {
    create.mockRestore(); revoke.mockRestore(); jest.useRealTimers()
    if (original) Object.defineProperty(globalThis, 'document', original); else delete (globalThis as any).document
  }
})
