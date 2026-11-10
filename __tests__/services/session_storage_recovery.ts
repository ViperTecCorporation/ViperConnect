import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restorePreparedSession } from '../../src/services/session_storage/recovery'
import { migrationPaths } from '../../src/services/session_storage/migration'

const phone = '999123456789', backupId = randomUUID()
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'viper-recovery-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
function fixture() {
  const old = { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'server_1', generation: 5, state: 'offline' as const }
  const catalog: any = { read: jest.fn(async () => old), compareAndSet: jest.fn(async (_phone, _generation, _backend, next) => next), journal: jest.fn(async () => {}) }
  const lease = { assertOwned: jest.fn(async () => {}), release: jest.fn(async () => {}) }
  const hooks = { owner: 'server_1', getConfig: jest.fn(async () => ({ provider: 'zapo', server: 'server_1', baseStore: directory, autoConnect: false, sessionStorage: old })),
    isOffline: jest.fn(async () => true), sourceIsEmpty: jest.fn(async () => true), acquireLease: jest.fn(async () => lease),
    restoreArchive: jest.fn(async (_phone, _backup, path) => { await writeFile(path, Buffer.from('synthetic-snapshot')); return { manifest: { phone, id: backupId, status: 'ready' }, supplement: {} } }),
    validate: jest.fn(async () => ({ identity: true, ids: true })) }
  return { old, catalog, hooks, lease }
}
const body = () => ({ backupId, confirm: true, mode: 'offline' })

test('restore promotes to a new storage UUID, preserves the old database and remains offline', async () => {
  const f = fixture(), task = randomUUID(), oldPath = migrationPaths(directory, f.old.storageId, task)
  await mkdir(oldPath.directory, { recursive: true }); await writeFile(oldPath.final, 'old-session-data')
  const result = await restorePreparedSession(f.catalog, f.hooks as any, phone, body(), task)
  expect(result.storage).toMatchObject({ backend: 'sqlite', generation: 7, state: 'offline' }); expect(result.storage.storageId).not.toBe(f.old.storageId)
  expect(await readFile(oldPath.final, 'utf8')).toBe('old-session-data')
  expect(await readFile(migrationPaths(directory, result.storage.storageId, task).final, 'utf8')).toBe('synthetic-snapshot')
  expect(result.autoConnect).toBe(false); expect(result.previousStoragePreserved).toBe(true)
  expect(f.lease.release).toHaveBeenCalledTimes(1); expect(f.catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('restore_committed')
})

test('restore refuses unconfirmed, online or wrong-owner requests before touching storage', async () => {
  const f = fixture()
  await expect(restorePreparedSession(f.catalog, f.hooks as any, phone, { ...body(), mode: 'online' })).rejects.toThrow('session_storage_restore_confirmation_required')
  f.hooks.isOffline.mockResolvedValueOnce(false)
  await expect(restorePreparedSession(f.catalog, f.hooks as any, phone, body())).rejects.toThrow('session_storage_restore_requires_offline')
  f.catalog.read.mockResolvedValueOnce({ ...f.old, owner: 'server_2' })
  await expect(restorePreparedSession(f.catalog, f.hooks as any, phone, body())).rejects.toThrow('session_storage_wrong_owner')
  expect(f.hooks.restoreArchive).not.toHaveBeenCalled()
})

test('restore requires empty Redis source and verifies identity plus Uno/provider IDs before commit', async () => {
  const f = fixture(); f.catalog.read.mockResolvedValueOnce(undefined); f.hooks.sourceIsEmpty.mockResolvedValueOnce(false)
  await expect(restorePreparedSession(f.catalog, f.hooks as any, phone, body())).rejects.toThrow('session_storage_restore_destination_exists')
  f.hooks.validate.mockResolvedValueOnce({ identity: true, ids: false })
  await expect(restorePreparedSession(f.catalog, f.hooks as any, phone, body())).rejects.toThrow('session_storage_restore_verification_failed')
  expect(f.catalog.compareAndSet.mock.calls.at(-1)?.[3]).toMatchObject({ backend: 'sqlite', storageId: f.old.storageId, state: 'offline' })
})

test('after file promotion a CAS uncertainty retains recovery journal and does not roll back blindly', async () => {
  const f = fixture(); f.catalog.compareAndSet.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('response lost'))
  await expect(restorePreparedSession(f.catalog, f.hooks as any, phone, body())).rejects.toThrow('session_storage_restore_failed')
  expect(f.catalog.compareAndSet).toHaveBeenCalledTimes(2)
  expect(f.catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('restore_recovery_required')
})
