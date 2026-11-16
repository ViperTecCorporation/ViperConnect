import { Readable } from 'node:stream'
import { backupWeekday, validateWeeklyManifest, WeeklyBackupSlots, type WeeklyManifest } from '../../src/services/session_storage/backup_slots'
import type { BackupObjects } from '../../src/services/session_storage/backup_objects'

const phone = '999123456789', zone = 'America/Cuiaba'
let serial = 0
const id = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`
function manifest(at = '2026-11-01T16:00:00.000Z', kind: 'session-storage' | 'redis' = 'session-storage', owner = kind === 'redis' ? 'synthetic-stack' : phone): WeeklyManifest {
  const backupId = id(), common = { id: backupId, version: 1 as const, createdAt: at, bytes: 100, sha256: 'a'.repeat(64), status: 'ready' as const, protection: 'none' as const }
  return kind === 'redis' ? { ...common, instanceId: owner, scope: 'all-databases', uploadVerified: true, rdbHeaderVerified: true,
    objectKey: `backups/redis/${owner}/${backupId}.rdb.viperbackup` }
    : { ...common, phone: owner, storageId: id(), generation: 1, kind: 'linked-session', objectKey: `backups/session-storage/${owner}/${backupId}.viperstorage` }
}
function fixture(kind: 'session-storage' | 'redis' = 'session-storage') {
  let clock = Date.parse('2026-11-20T16:00:00.000Z'), version = 0
  const scope = { kind, id: kind === 'redis' ? 'synthetic-stack' : phone }, archives = new Set<string>(), locks = new Map<string, string>()
  const records = new Map<string, { value: any; etag: string; modifiedAt: number }>()
  const put = (key: string, value: unknown, modifiedAt = clock) => records.set(key, { value: JSON.parse(JSON.stringify(value)), etag: `etag-${++version}`, modifiedAt })
  const objects: BackupObjects = {
    save: jest.fn(async () => {}), open: jest.fn(async () => Readable.from([Buffer.from('synthetic encrypted archive')])),
    remove: jest.fn(async key => { archives.delete(key); records.delete(key) }),
    json: jest.fn(async key => { const value = records.get(key); return value && JSON.parse(JSON.stringify(value)) }),
    putJson: jest.fn(async (key, value, previous) => {
      const old = records.get(key)
      if (previous === null ? !!old : old?.etag !== previous) return false
      put(key, value); return true
    }),
    keys: jest.fn(async function* (prefix: string) { for (const key of [...archives, ...records.keys()].sort()) if (key.startsWith(prefix)) yield key }),
  }
  const redis = { get: jest.fn(async (key: string) => locks.get(key) || null), eval: jest.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
    const { keys, arguments: [token] } = options
    if (script.includes("redis.call('EXISTS'")) { if (keys.some(key => locks.has(key))) return 0; keys.forEach(key => locks.set(key, token)); return 1 }
    if (script.includes("redis.call('PEXPIRE'")) return keys.every(key => locks.get(key) === token) ? 1 : 0
    let removed = 0; keys.forEach(key => { if (locks.get(key) === token) { locks.delete(key); removed++ } }); return removed
  }) }
  const forget = jest.fn(async () => {}), busy = jest.fn(async () => false)
  const service = new WeeklyBackupSlots(scope, objects, redis, { timeZone: zone, now: () => clock, forget, busy })
  const seedArchive = (value: WeeklyManifest, modifiedAt = Date.parse(value.createdAt)) => { archives.add(value.objectKey); put(value.objectKey + '.manifest.json', value, modifiedAt) }
  return { scope, archives, records, locks, objects, redis, service, forget, busy, put, seedArchive, time: (at: number | string) => { clock = typeof at === 'number' ? at : Date.parse(at) } }
}
beforeEach(() => { serial = 0 })

test('weekday follows Cuiaba rather than UTC midnight, covers all seven days and rejects invalid clocks/timezones', () => {
  expect(backupWeekday('2026-11-02T02:30:00.000Z', 'UTC')).toBe(1)
  expect(backupWeekday('2026-11-02T02:30:00.000Z', zone)).toBe(0)
  expect(backupWeekday(Date.parse('2026-11-02T04:00:00.000Z'), zone)).toBe(1)
  for (let day = 0; day < 7; day++) expect(backupWeekday(Date.parse('2026-11-01T16:00:00Z') + day * 86400000, zone)).toBe(day)
  for (const [at, tz] of [['not-a-date', zone], [NaN, zone], ['2026-11-01', 'invalid/zone']] as const) expect(() => backupWeekday(at, tz)).toThrow('timezone_invalid')
})

test.each(['session-storage', 'redis'] as const)('seven %s slots retain a week and week two replaces only its weekday', async kind => {
  const f = fixture(kind), first: WeeklyManifest[] = []
  for (let day = 0; day < 7; day++) {
    const m = manifest(new Date(Date.parse('2026-11-01T16:00:00Z') + day * 86400000).toISOString(), kind)
    first.push(m); f.time(m.createdAt); f.archives.add(m.objectKey)
    expect(await f.service.publish(m)).toEqual({ published: true, day })
  }
  const next = manifest('2026-11-08T16:00:00.000Z', kind); f.time(next.createdAt); f.archives.add(next.objectKey)
  await f.service.publish(next)
  expect((await f.service.slot(0))?.manifest.id).toBe(next.id)
  for (let day = 1; day < 7; day++) expect((await f.service.slot(day))?.manifest.id).toBe(first[day].id)
  f.time('2026-11-08T16:20:00.000Z'); expect(await f.service.prune()).toEqual({ deleted: 1, deferred: false })
  expect(f.archives.size).toBe(7); expect(f.archives.has(first[0].objectKey)).toBe(false)
  expect(f.archives.has(next.objectKey)).toBe(true); expect(f.forget).toHaveBeenCalledWith(first[0])
})

test('sidecar readback must succeed before pointer replacement and preserves the earlier good archive/slot on failure', async () => {
  const f = fixture(), old = manifest(), next = manifest('2026-11-08T16:00:00.000Z')
  f.archives.add(old.objectKey); await f.service.publish(old); const pointerKey = f.service.prefix + 'slots/0.json'
  const original = (f.objects.json as jest.Mock).getMockImplementation()!
  ;(f.objects.json as jest.Mock).mockImplementation(async key => key === next.objectKey + '.manifest.json' && f.records.has(key)
    ? { value: { ...next, sha256: 'b'.repeat(64) }, etag: 'corrupt' } : original(key))
  f.archives.add(next.objectKey)
  await expect(f.service.publish(next)).rejects.toThrow('pointer_verification_failed')
  expect(f.records.get(pointerKey)?.value.manifest.id).toBe(old.id)
  expect(f.archives.has(old.objectKey)).toBe(true); expect(f.objects.remove).not.toHaveBeenCalled()
})

test('an ambiguous pointer readback failure never deletes the old archive or blindly retries a successful CAS', async () => {
  const f = fixture(), old = manifest(), next = manifest('2026-11-08T16:00:00.000Z'), key = f.service.prefix + 'slots/0.json'
  f.archives.add(old.objectKey); await f.service.publish(old); f.archives.add(next.objectKey)
  const original = (f.objects.json as jest.Mock).getMockImplementation()!
  ;(f.objects.json as jest.Mock).mockImplementation(async candidate => {
    if (candidate === key && f.records.get(key)?.value.manifest.id === next.id) throw Error('ambiguous_readback')
    return original(candidate)
  })
  await expect(f.service.publish(next)).rejects.toThrow('ambiguous_readback')
  expect((f.objects.putJson as jest.Mock).mock.calls.filter(([candidate, value]) => candidate === key && value.manifest.id === next.id)).toHaveLength(1)
  expect(f.archives.has(old.objectKey)).toBe(true); expect(f.archives.has(next.objectKey)).toBe(true); expect(f.objects.remove).not.toHaveBeenCalled()
})

test('a delayed older publication cannot overwrite a newer same-weekday pointer, and CAS conflicts are bounded', async () => {
  const f = fixture(), latest = manifest('2026-11-08T16:00:00.000Z'), old = manifest()
  f.archives.add(latest.objectKey); await f.service.publish(latest)
  expect(await f.service.publish(old)).toEqual({ published: false, day: 0 })
  expect((await f.service.slot(0))?.manifest.id).toBe(latest.id)
  const next = manifest('2026-11-15T16:00:00.000Z'), original = (f.objects.putJson as jest.Mock).getMockImplementation()!
  ;(f.objects.putJson as jest.Mock).mockImplementation((key, value, previous) => key.includes('/slots/') ? false : original(key, value, previous))
  await expect(f.service.publish(next)).rejects.toThrow('rotation_changed')
  expect((f.objects.putJson as jest.Mock).mock.calls.filter(([key, value]) => key.endsWith('/slots/0.json') && value.manifest.id === next.id)).toHaveLength(3)
  expect((await f.service.slot(0))?.manifest.id).toBe(latest.id); expect(f.objects.remove).not.toHaveBeenCalled()
})

test('corrupt, foreign-scope and invalid-day pointers fail closed before pruning any object', async () => {
  for (const bad of [null, { version: 1, day: 0, timeZone: zone, manifest: manifest(undefined, 'session-storage', '999987654321') },
    { version: 1, day: 1, timeZone: zone, manifest: manifest() }, { version: 1, day: 0, timeZone: 'invalid/zone', manifest: manifest() }]) {
    const f = fixture(); f.put(f.service.prefix + 'slots/0.json', bad)
    await expect(f.service.prune()).rejects.toThrow('session_storage_'); expect(f.objects.remove).not.toHaveBeenCalled()
  }
  const f = fixture(); await expect(f.service.slot(-1)).rejects.toThrow('slot_invalid'); await expect(f.service.slot(7)).rejects.toThrow('slot_invalid')
  expect(await f.service.prune()).toEqual({ deleted: 0, deferred: true })
})

test('pruning protects unrelated media/another phone, current pointers and objects within the 15-minute grace period', async () => {
  const f = fixture(), current = manifest('2026-11-08T16:00:00.000Z'), old = manifest(), recent = manifest('2026-11-08T15:55:00.000Z'), foreign = manifest(undefined, 'session-storage', '999987654321')
  f.time('2026-11-08T16:00:00.000Z'); f.archives.add(current.objectKey); await f.service.publish(current)
  f.seedArchive(old); f.seedArchive(recent, Date.parse('2026-11-08T15:55:00.000Z')); f.seedArchive(foreign)
  const media = `${phone}/media/video.mp4`; f.archives.add(media)
  expect(await f.service.prune()).toEqual({ deleted: 1, deferred: false })
  expect(f.archives.has(current.objectKey)).toBe(true); expect(f.archives.has(recent.objectKey)).toBe(true)
  expect(f.archives.has(foreign.objectKey)).toBe(true); expect(f.archives.has(media)).toBe(true)
  expect((f.objects.remove as jest.Mock).mock.calls.flat()).toEqual([old.objectKey, old.objectKey + '.manifest.json'])
})

test('the 15-minute retirement boundary follows object modification time, never an old manifest timestamp alone', async () => {
  const f = fixture(), current = manifest('2026-11-08T16:00:00.000Z'), old = manifest()
  f.time('2026-11-08T16:00:00.000Z'); f.archives.add(current.objectKey); await f.service.publish(current)
  f.seedArchive(old, Date.parse('2026-11-08T15:45:00.001Z'))
  expect(await f.service.prune()).toEqual({ deleted: 0, deferred: false })
  expect(f.archives.has(old.objectKey)).toBe(true)
  f.time('2026-11-08T16:00:00.001Z')
  expect(await f.service.prune()).toEqual({ deleted: 1, deferred: false })
  expect(f.archives.has(current.objectKey)).toBe(true)
})

test('corrupt sidecars or foreign legacy-fallback manifests abort the complete candidate scan before any deletion', async () => {
  const f = fixture(), current = manifest('2026-11-08T16:00:00.000Z'), old = manifest(), foreign = manifest(undefined, 'session-storage', '999987654321')
  f.archives.add(current.objectKey); await f.service.publish(current); f.seedArchive(old)
  const malformedKey = `${f.service.prefix}${id()}.viperstorage.manifest.json`
  f.put(malformedKey, foreign)
  await expect(f.service.prune()).rejects.toThrow('manifest_invalid')
  expect(f.objects.remove).not.toHaveBeenCalled(); expect(f.archives.has(old.objectKey)).toBe(true)
  f.records.delete(malformedKey)
  const fallback = new WeeklyBackupSlots(f.scope, f.objects, f.redis, { timeZone: zone, legacy: async () => [foreign] })
  await expect(fallback.prune()).rejects.toThrow('manifest_invalid')
  expect(f.objects.remove).not.toHaveBeenCalled()
})

test('task locks, a busy operation and lost rotation ownership prohibit pruning or pointer changes', async () => {
  const f = fixture(), old = manifest(), latest = manifest('2026-11-08T16:00:00.000Z'); f.archives.add(latest.objectKey); await f.service.publish(latest); f.seedArchive(old)
  f.busy.mockResolvedValueOnce(true); expect(await f.service.prune()).toEqual({ deleted: 0, deferred: true })
  f.locks.set(`unoapi-session-storage:task:lock:${phone}`, 'another-task')
  await expect(f.service.prune()).rejects.toThrow('rotation_busy'); expect(f.objects.remove).not.toHaveBeenCalled()
  f.locks.delete(`unoapi-session-storage:task:lock:${phone}`)
  const next = manifest('2026-11-15T16:00:00.000Z'), original = (f.objects.putJson as jest.Mock).getMockImplementation()!
  ;(f.objects.putJson as jest.Mock).mockImplementation(async (key, value, previous) => { const result = await original(key, value, previous); f.locks.set(`unoapi-backup-rotation:session-storage:${phone}`, 'foreign-token'); return result })
  await expect(f.service.publish(next)).rejects.toThrow('lease_lost')
  expect((await f.service.slot(0))?.manifest.id).toBe(latest.id); expect(f.objects.remove).not.toHaveBeenCalled()
  expect(f.locks.get(`unoapi-backup-rotation:session-storage:${phone}`)).toBe('foreign-token')
})

test('manifest validation rejects inconsistent scope, paths, UUIDs, bytes/hash and unverified Redis archives', () => {
  const valid = manifest(), scope = { kind: 'session-storage' as const, id: phone }
  expect(() => validateWeeklyManifest(valid, scope)).not.toThrow()
  for (const patch of [{ id: 'bad' }, { bytes: 0 }, { sha256: 'invalid' }, { status: 'pending' }, { phone: '999987654321' }, { createdAt: 'bad' }, { objectKey: '../media' }, { protection: 'unknown' }]) expect(() => validateWeeklyManifest({ ...valid, ...patch }, scope)).toThrow('manifest_invalid')
  const redis = manifest(undefined, 'redis')
  expect(() => validateWeeklyManifest(redis, { kind: 'redis', id: 'synthetic-stack' })).not.toThrow()
  expect(() => validateWeeklyManifest({ ...redis, uploadVerified: false }, { kind: 'redis', id: 'synthetic-stack' })).toThrow('manifest_invalid')
  expect(() => new WeeklyBackupSlots({ kind: 'redis', id: '../other' }, {} as any, {} as any, { timeZone: zone })).toThrow('instance_invalid')
})

test.each(['session-storage', 'redis'] as const)('format transition never deletes %s encrypted legacy archives, sidecars or indexes', async kind => {
  const f = fixture(kind), old = manifest(undefined, kind), explicit = manifest(undefined, kind), latest = manifest('2026-11-08T16:00:00.000Z', kind)
  delete old.protection; explicit.protection = 'aes-256-gcm'
  f.seedArchive(old); f.seedArchive(explicit); f.archives.add(latest.objectKey); await f.service.publish(latest)
  expect(await f.service.prune()).toEqual({ deleted: 0, deferred: false })
  expect(f.archives.has(old.objectKey)).toBe(true); expect(f.archives.has(explicit.objectKey)).toBe(true)
  expect(f.records.has(old.objectKey + '.manifest.json')).toBe(true); expect(f.records.has(explicit.objectKey + '.manifest.json')).toBe(true)
  expect(f.forget).not.toHaveBeenCalled(); expect(f.objects.remove).not.toHaveBeenCalled()
})
