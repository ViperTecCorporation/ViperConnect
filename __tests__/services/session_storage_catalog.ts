import { randomUUID } from 'node:crypto'
import { SessionStorageCatalog, STORAGE_CAS_LUA } from '../../src/services/session_storage/catalog'
import { publicStorageDescriptor, validateStorageDescriptor, validateSessionPhone } from '../../src/services/session_storage/types'

const phone = '999123456789'
const descriptor = () => ({ backend: 'sqlite' as const, storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'offline' as const })

test('descriptor validates identity, generation and safe owner; public projection excludes paths and fixture internals', () => {
  const valid = descriptor(); expect(() => validateStorageDescriptor(valid)).not.toThrow()
  expect(() => validateStorageDescriptor({ ...valid, generation: 0 })).toThrow('session_storage_descriptor_invalid')
  expect(() => validateStorageDescriptor({ ...valid, storageId: '../../sqlite' })).toThrow('session_storage_descriptor_invalid')
  expect(() => validateStorageDescriptor({ ...valid, owner: 'server/path' })).toThrow()
  expect(() => validateSessionPhone('999*')).toThrow('session_storage_phone_invalid')
  expect(publicStorageDescriptor({ ...valid, fixture: true, path: 'private' } as any)).toEqual(valid)
})

test('catalog reads only the exact configuration and reports absent or invalid state', async () => {
  const d = descriptor(), redis = { get: jest.fn(async () => JSON.stringify({ sessionStorage: d })), eval: jest.fn() }
  const catalog = new SessionStorageCatalog(redis)
  expect(await catalog.read(phone)).toEqual(d); expect(redis.get).toHaveBeenCalledWith(`unoapi-config:${phone}`)
  redis.get.mockResolvedValueOnce('{}'); expect(await catalog.read(phone)).toBeUndefined()
  redis.get.mockResolvedValueOnce(null as any); await expect(catalog.read(phone)).rejects.toThrow('session_storage_session_not_found')
  redis.get.mockResolvedValueOnce('{"sessionStorage":{}}'); await expect(catalog.read(phone)).rejects.toThrow('session_storage_descriptor_invalid')
})

test('catalog CAS carries expected backend/generation/task and never overwrites a conflicting generation', async () => {
  const redis = { get: jest.fn(), eval: jest.fn(async () => 1) }, catalog = new SessionStorageCatalog(redis), next = descriptor()
  await expect(catalog.compareAndSet(phone, 0, 'redis', next, { taskId: 'operation', autoConnect: false })).resolves.toEqual(next)
  expect(redis.eval).toHaveBeenCalledWith(STORAGE_CAS_LUA, { keys: [`unoapi-config:${phone}`], arguments: ['0', 'redis', JSON.stringify(next), '', 'operation', 'false', phone, ''] })
  redis.eval.mockResolvedValueOnce(0); await expect(catalog.compareAndSet(phone, 0, 'redis', next)).rejects.toThrow('session_storage_configuration_changed')
  await expect(catalog.compareAndSet(phone, 2, 'redis', next)).rejects.toThrow('session_storage_generation_invalid')
  expect(STORAGE_CAS_LUA).toContain('cfg.sessionStorageTaskId~=ARGV[4]')
})

test('journal excludes secret/path input and backup windows are stable UTC half-days', async () => {
  const redis = { get: jest.fn(), eval: jest.fn(async () => 1) }, catalog = new SessionStorageCatalog(redis), id = randomUUID()
  await catalog.journal(phone, id, { phase: 'prepared', generation: 1, storageId: id })
  expect(redis.eval.mock.calls[0][1].keys[0]).toBe(`unoapi-session-storage:journal:${phone}:${id}`)
  await expect(catalog.journal(phone, 'bad', { phase: 'bad/path', generation: 1, storageId: id })).rejects.toThrow()
  expect(await catalog.claimBackupWindow(phone, 43200001)).toBe(true)
  expect(redis.eval.mock.calls.at(-1)?.[1].keys).toEqual([`unoapi-session-storage:backup-window:${phone}:1`])
  redis.eval.mockResolvedValueOnce(0); expect(await catalog.claimBackupWindow(phone, 43200001)).toBe(false)
  await expect(catalog.claimBackupWindow(phone, NaN)).rejects.toThrow('session_storage_window_invalid')
})
