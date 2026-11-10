jest.mock('../../frontend/features/mobile_backup', () => ({ ...jest.requireActual('../../frontend/features/mobile_backup'), downloadMobileBackup: jest.fn() }))
import { ApiClient } from '../../frontend/core/api'
import { SessionStoragePanel } from '../../frontend/features/session_storage'
import { downloadMobileBackup } from '../../frontend/features/mobile_backup'
import { normalizeStorageBackupFiles, renderStorageBackupFiles, validStorageBackupId } from '../../frontend/features/session_storage_downloads'

const phone = '999123456789', id = '12345678-1234-4234-8234-123456789abc'
const latest = { id, createdAt: '2026-11-10T00:00:00Z', bytes: 1024, kind: 'linked-session', protection: 'none' }
const status: any = { backend: 'sqlite', state: 'active', generation: 1, lastBackup: latest, capability: { sqliteAvailable: true } }
const setup = () => {
  const blob = new Blob(['synthetic archive']), api = { request: jest.fn().mockResolvedValue({ latest, slots: [{ ...latest, day: 1 }] }), downloadBackup: jest.fn().mockResolvedValue(blob) }
  const panel = new SessionStoragePanel(api as any, jest.fn()); panel.phone = phone; panel.status = status
  return { panel, api, blob }
}
beforeEach(() => jest.clearAllMocks())

test('SQLite backup disclosure has direct latest download and safe weekday files, not credential URLs or a second legacy migration flow', async () => {
  const { panel, api } = setup()
  api.request.mockResolvedValueOnce({ latest: { ...latest, url: 'https://private-object.invalid?token=secret' }, slots: [{ ...latest, day: 1 }] })
  expect(panel.html(phone)).toContain('data-action="storage-download-latest"')
  await panel.action('storage-toggle-backups', phone)
  expect(api.request).toHaveBeenCalledWith(`/manager/storage/${phone}/backups`)
  const html = panel.html(phone)
  expect(html).toContain('Segunda'); expect(html).toContain('data-action="storage-download-backup"')
  expect(html).toContain(`data-backup-id="${id}"`)
  expect(html).not.toContain('private-object.invalid'); expect(html).not.toContain('token=')
  panel.reset()
})

test('backup file projection only keeps safe metadata and rejects malformed/duplicate weekdays, IDs and secrets', () => {
  const files = normalizeStorageBackupFiles({ latest: { ...latest, credentials: { token: 'SECRET' }, url: 'https://secret.invalid?token=SECRET' }, slots: [{ ...latest, day: 1 }, { ...latest, day: 1 }, { ...latest, id: '../other', day: 2 }, { ...latest, day: 8 }, { ...latest, day: '<script>' }] })
  expect(files.slots).toHaveLength(1)
  expect(JSON.stringify(files)).not.toContain('SECRET'); expect(JSON.stringify(files)).not.toContain('url')
  expect(normalizeStorageBackupFiles(null)).toEqual({ slots: [] })
  expect(validStorageBackupId(id)).toBe(true); expect(validStorageBackupId('../other')).toBe(false)
  expect(renderStorageBackupFiles(phone, { slots: [{ ...latest, createdAt: '<img src=x>', day: 1 }] })).toContain('&lt;img src=x&gt;')
  expect(renderStorageBackupFiles(phone, { slots: [] })).toContain('Ainda não há backups')
})

test.each(['storage-download-latest', 'storage-download-backup'])('%s downloads authenticated binary Blob without token links, opening public S3 URLs or JSON/Base64', async action => {
  const { panel, api, blob } = setup()
  panel.backupFiles = normalizeStorageBackupFiles({ latest, slots: [{ ...latest, day: 1 }] })
  await panel.action(action, phone, action === 'storage-download-backup' ? id : undefined)
  expect(api.downloadBackup).toHaveBeenCalledWith(`/manager/storage/${phone}/backups/${action === 'storage-download-latest' ? 'latest' : id}/download`)
  expect(downloadMobileBackup).toHaveBeenCalledWith({ archive: blob, fileName: `sessao-${phone}-${action === 'storage-download-latest' ? 'latest' : id}.viperstorage` })
  expect(api.request).not.toHaveBeenCalled()
  panel.reset()
})

test('unknown slot, unsafe ID, other phone or Redis backend never triggers a download', async () => {
  const { panel, api } = setup()
  await panel.action('storage-download-backup', phone, '../other')
  await panel.action('storage-download-backup', phone, id)
  await panel.action('storage-download-latest', '999123456788')
  panel.status = { ...status, backend: 'redis' }; await panel.action('storage-download-latest', phone)
  expect(api.downloadBackup).not.toHaveBeenCalled(); expect(downloadMobileBackup).not.toHaveBeenCalled()
  panel.reset()
})

test('download failure is visible, does not claim success and never retries automatically', async () => {
  const { panel, api } = setup(); api.downloadBackup.mockRejectedValueOnce(new Error('not available'))
  await panel.action('storage-download-latest', phone)
  expect(panel.html(phone)).toContain('Não foi possível baixar o backup')
  expect(api.downloadBackup).toHaveBeenCalledTimes(1); expect(downloadMobileBackup).not.toHaveBeenCalled()
  panel.reset()
})

test('reset during an authenticated download discards the old account/session file', async () => {
  const { panel, api, blob } = setup(); let resolve!: (value: Blob) => void
  api.downloadBackup.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const downloading = panel.action('storage-download-latest', phone)
  panel.reset(); resolve(blob); await downloading
  expect(downloadMobileBackup).not.toHaveBeenCalled(); expect(panel.backupFiles).toBeUndefined()
})

test('ApiClient authenticates backup bytes in a header and drops a response after login changes', async () => {
  let finish!: (value: Response) => void
  const fetcher = jest.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const api = new ApiClient('https://example.invalid', fetcher as any); api.setToken('mgr_private_login')
  const downloading = api.downloadBackup(`/manager/storage/${phone}/backups/latest/download`)
  expect(fetcher.mock.calls[0][0]).not.toContain('mgr_private_login')
  expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer mgr_private_login' })
  api.setToken('mgr_other_login'); finish(new Response(new Blob(['archive']), { status: 200 }))
  await expect(downloading).rejects.toThrow('Sessão alterada')
})

test('backup listing failures are local and do not authorize upload, connection or deletion', async () => {
  const { panel, api } = setup(); api.request.mockRejectedValueOnce(new Error('unavailable'))
  await panel.action('storage-backups-refresh', phone)
  expect(panel.html(phone)).toContain('Não foi possível consultar os arquivos')
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(api.downloadBackup).not.toHaveBeenCalled(); panel.reset()
})
