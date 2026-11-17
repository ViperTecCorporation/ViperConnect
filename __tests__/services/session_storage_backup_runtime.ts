jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(async () => ({})) }))
jest.mock('../../src/services/session_storage/backup_objects', () => ({ createBackupObjects: jest.fn(() => ({})) }))
jest.mock('../../src/services/session_storage/backup', () => ({ SessionSqliteBackups: jest.fn() }))
jest.mock('../../src/services/session_storage/backup_capture', () => ({ captureBackupState: jest.fn(async () => ({ primary: {}, configuration: {}, unchanged: async () => true })) }))
jest.mock('../../src/services/session_storage/routing', () => ({ assertLocalStorageOwner: jest.fn(), isSqliteSession: (c: any) => c.sessionStorage?.backend === 'sqlite' }))
jest.mock('../../src/services/session_storage/capability', () => ({ requireStorageVolume: jest.fn() }))
jest.mock('../../src/services/session_storage/database', () => ({ getSessionSqlitePath: (phone: string) => `/synthetic/${phone}.sqlite` }))
import { makeSessionBackup } from '../../src/services/session_storage/backup_runtime'
import { SessionSqliteBackups } from '../../src/services/session_storage/backup'

const config: any = { useS3: true, sessionStorage: { backend: 'sqlite' } }

test.each([false, true])('one session backup at a time across callers; next job survives preceding failure=%s', async fail => {
  let release!: () => void, entered = 0, active = 0, peak = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  ;(SessionSqliteBackups as jest.Mock).mockImplementation(() => ({ backup: async ({ phone }: { phone: string }) => {
    entered++; active++; peak = Math.max(peak, active)
    try { if (entered === 1) { await gate; if (fail) throw new Error('synthetic first upload failure') }; return { phone } }
    finally { active-- }
  } }))
  const first = makeSessionBackup('999123456781', config), second = makeSessionBackup('999123456782', config)
  const results = Promise.allSettled([first, second])
  try {
    await new Promise(resolve => setImmediate(resolve)); expect(entered).toBe(1); expect(peak).toBe(1)
  } finally { release() }
  const [a, b] = await results
  expect(a.status).toBe(fail ? 'rejected' : 'fulfilled'); expect(b.status).toBe('fulfilled')
  expect(entered).toBe(2); expect(peak).toBe(1); expect(active).toBe(0)
})
