import { Readable } from 'node:stream'
import { backupRetention, indexedBackupManifests, weeklyBackupSlots, publishBackupManifest, pruneBackupSlots } from '../../src/services/session_storage/backup_policy'
import type { BackupObjects } from '../../src/services/session_storage/backup_objects'
import type { SqliteBackupManifest } from '../../src/services/session_storage/backup'

const phone = '999123456789', scope = { kind: 'session-storage' as const, id: phone }
const manifest = (suffix = '001', owner = phone): SqliteBackupManifest => {
  const id = `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
  return { id, version: 1, phone: owner, storageId: '00000000-0000-4000-8000-000000000099', generation: 2, createdAt: '2026-11-08T16:00:00.000Z', objectKey: `backups/session-storage/${owner}/${id}.viperstorage`, bytes: 100, sha256: 'a'.repeat(64), kind: 'linked-session', status: 'ready' }
}
function fixture() {
  const records = new Map<string, { value: unknown; etag: string }>(), values = new Map<string, string>()
  const objects: BackupObjects = { save: jest.fn(async () => {}), open: jest.fn(async () => Readable.from([])), remove: jest.fn(async () => {}),
    json: jest.fn(async key => records.get(key)), putJson: jest.fn(async (key, value, previous) => { const old = records.get(key); if (previous === null ? !!old : old?.etag !== previous) return false; records.set(key, { value, etag: 'updated' }); return true }), keys: jest.fn(async function* () {}) }
  const redis = { get: jest.fn(async (key: string) => values.get(key) || null), scan: jest.fn(async (_cursor: number, options: { MATCH: string; COUNT: number }) => ({ cursor: 0, keys: [...values.keys()].filter(key => key.startsWith(options.MATCH.slice(0, -1))) })),
    eval: jest.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => { if (values.get(options.keys[0]) === options.arguments[0]) values.delete(options.keys[0]); return 1 }) }
  return { records, values, objects, redis }
}

test('retention is opt-in and returns seven weekday slots in the explicitly configured timezone', () => {
  expect(backupRetention({})).toEqual({ strategy: 'retain-all' })
  expect(backupRetention({ SESSION_STORAGE_BACKUP_ROTATION: 'anything-else' })).toEqual({ strategy: 'retain-all' })
  expect(backupRetention({ SESSION_STORAGE_BACKUP_ROTATION: 'weekly' })).toEqual({ strategy: 'weekday-slots', slots: 7, timeZone: 'UTC', replacement: 'latest-verified' })
  expect(backupRetention({ SESSION_STORAGE_BACKUP_ROTATION: 'weekly', SESSION_STORAGE_BACKUP_TIMEZONE: 'America/Cuiaba' }).timeZone).toBe('America/Cuiaba')
})

test('legacy index pagination includes only the selected phone and refuses corrupt owned manifests', async () => {
  const f = fixture(), owned = manifest(), foreign = manifest('002', '999987654321')
  f.values.set('unoapi-session-storage:backup:owned', JSON.stringify(owned)); f.values.set('unoapi-session-storage:backup:foreign', JSON.stringify(foreign))
  f.redis.scan.mockResolvedValueOnce({ cursor: 7, keys: ['unoapi-session-storage:backup:owned'] }).mockResolvedValueOnce({ cursor: 0, keys: ['unoapi-session-storage:backup:foreign', 'missing'] })
  expect(await indexedBackupManifests(scope, f.redis)).toEqual([owned])
  expect(f.redis.scan.mock.calls[0][1]).toEqual({ MATCH: 'unoapi-session-storage:backup:*', COUNT: 100 })
  expect(f.redis.scan.mock.calls[1][0]).toBe(7)
  f.values.set('unoapi-session-storage:backup:owned', JSON.stringify({ ...owned, sha256: 'corrupt' }))
  await expect(indexedBackupManifests(scope, f.redis)).rejects.toThrow('manifest_invalid')
  f.values.set('unoapi-session-storage:backup:owned', 'invalid-json')
  await expect(indexedBackupManifests(scope, f.redis)).rejects.toThrow()
})

test('unbounded/repeating legacy scans stop explicitly instead of authorizing deletion from an incomplete index', async () => {
  const f = fixture(); f.redis.scan.mockResolvedValue({ cursor: 1, keys: [] })
  await expect(indexedBackupManifests(scope, f.redis)).rejects.toThrow('rotation_scan_limit')
  expect(f.redis.scan).toHaveBeenCalledTimes(1000); expect(f.objects.remove).not.toHaveBeenCalled()
})

test('retain-all publication writes/readbacks one immutable sidecar and is idempotent, without invoking pruning', async () => {
  const f = fixture(), value = manifest(), key = value.objectKey + '.manifest.json'
  expect(await publishBackupManifest(scope, value, f.objects, f.redis, {})).toEqual({ published: true })
  expect(f.objects.putJson).toHaveBeenCalledWith(key, value, null)
  expect(await publishBackupManifest(scope, value, f.objects, f.redis, {})).toEqual({ published: true })
  expect(f.objects.putJson).toHaveBeenCalledTimes(1); expect(f.objects.remove).not.toHaveBeenCalled(); expect(f.redis.eval).not.toHaveBeenCalled()
})

test('retain-all publication rejects existing sidecar conflicts, failed CAS and bad readback without blind retries or deletion', async () => {
  const f = fixture(), value = manifest(), key = value.objectKey + '.manifest.json'
  f.records.set(key, { value: { ...value, bytes: 999 }, etag: 'old' })
  await expect(publishBackupManifest(scope, value, f.objects, f.redis, {})).rejects.toThrow('manifest_invalid')
  expect(f.objects.putJson).not.toHaveBeenCalled(); f.records.clear()
  jest.mocked(f.objects.putJson).mockResolvedValueOnce(false)
  await expect(publishBackupManifest(scope, value, f.objects, f.redis, {})).rejects.toThrow('rotation_changed')
  jest.mocked(f.objects.json).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
  await expect(publishBackupManifest(scope, value, f.objects, f.redis, {})).rejects.toThrow('pointer_verification_failed')
  expect(f.objects.putJson).toHaveBeenCalledTimes(2); expect(f.objects.remove).not.toHaveBeenCalled()
})

test('weekly wiring uses Cuiaba, scoped legacy lookups, task busy state and compare-delete for unchanged index records', async () => {
  const f = fixture(), value = manifest(), key = `unoapi-session-storage:backup:${value.id}`, env = { SESSION_STORAGE_BACKUP_ROTATION: 'weekly', SESSION_STORAGE_BACKUP_TIMEZONE: 'America/Cuiaba' }
  expect(weeklyBackupSlots(scope, f.objects, f.redis, {})).toBeUndefined()
  const service = weeklyBackupSlots(scope, f.objects, f.redis, env)!
  expect(service.options.timeZone).toBe('America/Cuiaba')
  f.values.set(key, JSON.stringify(value)); expect(await service.options.legacy!()).toEqual([value])
  expect(await service.options.busy!()).toBe(false); f.values.set(`unoapi-session-storage:task:lock:${phone}`, 'live-task')
  expect(await pruneBackupSlots(scope, f.objects, f.redis, env)).toEqual({ deleted: 0, deferred: true }); expect(f.objects.remove).not.toHaveBeenCalled()
  await service.options.forget!(value); expect(f.values.has(key)).toBe(false)
  f.values.set(key, 'changed-after-capture'); await service.options.forget!(value); expect(f.values.get(key)).toBe('changed-after-capture')
  expect(await pruneBackupSlots(scope, f.objects, f.redis, {})).toEqual({ deleted: 0, deferred: true })
})
