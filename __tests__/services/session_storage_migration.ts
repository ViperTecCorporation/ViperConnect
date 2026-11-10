import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStorageMigration, migrationPaths } from '../../src/services/session_storage/migration'
import { reconnectMigratedSession } from '../../src/services/session_storage/migrated_connection'

const phone = '999123456789'
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'viper-migration-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function fixture() {
  const catalog: any = { read: jest.fn(async () => undefined), compareAndSet: jest.fn(async (_phone, _gen, _backend, d) => d), journal: jest.fn(async () => {}) }
  const lease = { assertOwned: jest.fn(async () => {}), release: jest.fn(async () => {}) }
  const runtime = { owner: 'server_1', getConfig: jest.fn(async () => ({ provider: 'zapo', server: 'server_1', baseStore: directory })),
    quiesce: jest.fn(async () => {}), acquireLease: jest.fn(async () => lease),
    importData: jest.fn(async (_phone, path) => { await writeFile(path, Buffer.from([0, 1, 2, 255])); return { verified: true, nativeRecords: 3, compatibilityRecords: 4 } }),
    validate: jest.fn(async () => true), finalizeSource: jest.fn(async () => ({ backupId: randomUUID(), deleted: 7, missing: 0, skipped: 0 })) }
  return { catalog, lease, runtime, service: new SessionStorageMigration(catalog, runtime) }
}

test('migration pauses without logout, commits verified SQLite then finalizes source under the lease before ready', async () => {
  const { catalog, runtime, lease, service } = fixture(), progress = jest.fn(async () => {}), task = randomUUID()
  const result = await service.migrate(phone, { target: 'sqlite', confirm: true }, task, progress)
  expect(result.sourcePreserved).toBe(false); expect(result.autoConnect).toBe(false)
  expect(result.sourceCleanup).toMatchObject({ deleted: 7, skipped: 0 }); expect(result.backupId).toBe(result.sourceCleanup.backupId)
  expect(result.storage).toMatchObject({ backend: 'sqlite', state: 'offline', generation: 2, owner: 'server_1' })
  expect(await readFile(migrationPaths(directory, result.storage.storageId, task).final)).toEqual(Buffer.from([0, 1, 2, 255]))
  expect(runtime.quiesce).toHaveBeenCalledWith(phone); expect(lease.assertOwned).toHaveBeenCalledTimes(4); expect(lease.release).toHaveBeenCalledTimes(1)
  expect(runtime.quiesce.mock.invocationCallOrder[0]).toBeLessThan(catalog.compareAndSet.mock.invocationCallOrder[0])
  expect(catalog.compareAndSet.mock.calls[1][4]).toEqual({ expectedTaskId: task, autoConnect: false })
  expect(catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('source_cleaned')
  expect(runtime.finalizeSource).toHaveBeenCalledWith(phone, result.storage, expect.any(Function))
  expect(runtime.finalizeSource.mock.invocationCallOrder[0]).toBeGreaterThan(catalog.compareAndSet.mock.invocationCallOrder[1])
  expect(runtime.finalizeSource.mock.invocationCallOrder[0]).toBeLessThan(lease.release.mock.invocationCallOrder[0])
})

test('quiesce failure before preparation cannot invent a Redis rollback generation', async () => {
  const f = fixture(); f.runtime.quiesce.mockRejectedValueOnce(new Error('accepted_event_failed'))
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('migration_failed')
  expect(f.catalog.compareAndSet).not.toHaveBeenCalled(); expect(f.catalog.journal).not.toHaveBeenCalled()
  expect(f.runtime.importData).not.toHaveBeenCalled(); expect(f.runtime.acquireLease).not.toHaveBeenCalled()
})

test('configuration changed while draining cannot be overwritten with a stale migration descriptor', async () => {
  const f = fixture()
  f.runtime.getConfig.mockResolvedValueOnce({ provider: 'zapo', server: 'server_1', baseStore: directory })
    .mockResolvedValueOnce({ provider: 'zapo', server: 'another', baseStore: directory })
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('configuration_changed')
  expect(f.catalog.compareAndSet).not.toHaveBeenCalled(); expect(f.runtime.importData).not.toHaveBeenCalled()
})

test('migration refuses unconfirmed requests, another owner, another provider and already migrated storage', async () => {
  const f = fixture()
  await expect(f.service.migrate(phone, { target: 'sqlite' })).rejects.toThrow('session_storage_confirmation_required')
  f.runtime.getConfig.mockResolvedValueOnce({ provider: 'zapo', server: 'other', baseStore: directory })
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_wrong_owner')
  f.runtime.getConfig.mockResolvedValueOnce({ provider: 'baileys', server: 'server_1', baseStore: directory })
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_zapo_required')
  f.catalog.read.mockResolvedValueOnce({ backend: 'sqlite', owner: 'server_1' })
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_already_sqlite')
  expect(f.runtime.quiesce).not.toHaveBeenCalled()
  expect(() => migrationPaths(directory, '../bad', randomUUID())).toThrow('session_storage_path_invalid')
})

test('failed verification cannot change backend or reconnect, and releases the lease', async () => {
  const f = fixture(); f.runtime.validate.mockResolvedValueOnce(false)
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_verification_failed')
  expect(f.catalog.compareAndSet.mock.calls[1][3]).toMatchObject({ backend: 'redis', state: 'offline' })
  expect(f.catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('failed'); expect(f.lease.release).toHaveBeenCalled()
  expect(f.runtime.finalizeSource).not.toHaveBeenCalled()
})

test('CAS failure after promotion keeps durable recovery state and never guesses rollback', async () => {
  const f = fixture(); f.catalog.compareAndSet.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('lost response'))
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_migration_failed')
  expect(f.catalog.compareAndSet).toHaveBeenCalledTimes(2)
  expect(f.catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('recovery_required')
})

test('the post-commit reconnect helper runs only after core migration finally released its lease', async () => {
  const f = fixture(), sequence: string[] = []
  f.lease.release.mockImplementation(async () => { sequence.push('released') })
  const result = await f.service.migrate(phone, { target: 'sqlite', confirm: true })
  const redis = { get: jest.fn(), eval: jest.fn(async () => { expect(sequence).toEqual(['released']); sequence.push('intent_restored'); return 1 }) }
  const requested = await reconnectMigratedSession(phone, result.storage, { eligible: true, fixture: false }, {
    redis, effectsAllowed: () => {}, hasClient: () => false, dispatch: async () => { sequence.push('dispatch') },
  })
  expect(requested.reconnect.status).toBe('requested'); expect(sequence).toEqual(['released', 'intent_restored', 'dispatch'])
  expect(f.catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('source_cleaned')
})

test('backup or source cleanup failure after cutover preserves committed SQLite offline without reconnect or rollback', async () => {
  const f = fixture()
  f.runtime.finalizeSource.mockRejectedValueOnce(new Error('backup readback failed'))
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_migration_failed')
  expect(f.catalog.compareAndSet).toHaveBeenCalledTimes(2)
  expect(f.catalog.compareAndSet.mock.calls[1][3]).toMatchObject({ backend: 'sqlite', state: 'offline', generation: 2 })
  expect(f.catalog.journal.mock.calls.at(-1)?.[2]).toMatchObject({ phase: 'source_cleanup_failed', generation: 2 })
  expect(f.lease.release).toHaveBeenCalledTimes(1)
})

test('changed source keys prevent a successful migration completion while retaining committed SQLite', async () => {
  const f = fixture()
  f.runtime.finalizeSource.mockResolvedValueOnce({ backupId: randomUUID(), deleted: 6, missing: 0, skipped: 1 })
  await expect(f.service.migrate(phone, { target: 'sqlite', confirm: true })).rejects.toThrow('session_storage_source_cleanup_diverged')
  expect(f.catalog.journal.mock.calls.at(-1)?.[2].phase).toBe('source_cleanup_failed')
  expect(f.catalog.compareAndSet).toHaveBeenCalledTimes(2)
})
