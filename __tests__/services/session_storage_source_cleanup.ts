import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionDatabase } from '../../src/services/session_storage/database'
import { CLEAN_SOURCE_BATCH_LUA, cleanRedisSource, isSessionSourceCleanupKey, sourceFingerprintsDigest } from '../../src/services/session_storage/source_cleanup'
import { isRetainedSessionControlKey, isSessionCompatibilityDataKey } from '../../src/services/session_storage/source_scope'

const phone = '999123456789', prefix = 'unoapi:zapo:'
let directory: string, db: SessionDatabase
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'viper-cleanup-test-')); db = new SessionDatabase(join(directory, 'session.sqlite')); db.run('INSERT INTO uno_storage_meta VALUES (?,?)', ['phone', phone]); db.exec('CREATE TABLE uno_source_fingerprints(key TEXT PRIMARY KEY,sha1 TEXT,expires_at INTEGER,captured_at INTEGER)') })
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const storage = { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'server_1', generation: 4, state: 'offline' as const }
  const backupId = randomUUID(), manifest = { id: backupId, phone, storageId: storage.storageId, generation: 4, status: 'ready' }
  const redis = { get: jest.fn(async () => JSON.stringify(manifest)), eval: jest.fn(async () => [1, 1, 0, 512, 256, 1, 0]) }
  const input: any = { redis, database: db, phone, storage, prefix, body: { confirm: true, backupId, generation: 4 }, lease: { key: `unoapi-lease:zapo-session:${phone}`, token: 'exclusive', assertOwned: jest.fn(async () => {}) }, verifyBackup: jest.fn(async () => true) }
  return { input, redis, manifest }
}

test('cleanup registry excludes control/global keys and phone substrings while covering explicit session domains', () => {
  for (const key of [`unoapi-message:${phone}:jid:id`, `unoapi-id_rev:${phone}:uno`, `${prefix}signal:pk:ids:${phone}`, `${prefix}msg:idx:${phone}:jid`, `unoapi-zapo-username-lid:${phone}`, `unoapi-zapo-username-lid:${phone}:name`]) expect(isSessionSourceCleanupKey(key, phone, prefix)).toBe(true)
  for (const key of [`unoapi-config:${phone}`, `unoapi-lease:zapo-session:${phone}`, `unoapi-jidmap:global:pn:${phone}`, `unoapi-message:${phone}0:jid:id`, `${prefix}unknown:${phone}`, `unoapi-zapo-username-lid:${phone}0:name`, 'unoapi-zapo-username-lid:global:name']) expect(isSessionSourceCleanupKey(key, phone, prefix)).toBe(false)
  expect(CLEAN_SOURCE_BATCH_LUA).toContain('"zapo-username-lid"')
})

test('cleanup deletes only fingerprinted allowlisted keys, verifies uploaded snapshot digest, and reports measured key memory', async () => {
  const f = fixture()
  for (const key of [`unoapi-message:${phone}:jid:id`, `unoapi-id:${phone}:provider`, `unoapi-config:${phone}`]) db.run('INSERT INTO uno_source_fingerprints VALUES (?,?,?,?)', [key, 'a'.repeat(40), null, Date.now()])
  const digest = sourceFingerprintsDigest(db), result = await cleanRedisSource(f.input)
  expect(digest).toHaveLength(64); expect(f.input.verifyBackup).toHaveBeenCalledWith(f.manifest, digest)
  expect(result).toMatchObject({ deleted: 1, skipped: 2, skippedScope: 1, skippedMutated: 1, sourceBytesBefore: 512, sourceBytesAfter: 256, deletedKeyBytes: 256 })
  const call: any[] = f.redis.eval.mock.calls[0]
  expect(call[0]).toBe(CLEAN_SOURCE_BATCH_LUA); expect(call[1]).toBe(5)
  expect(call.slice(5, 7)).toEqual([`unoapi-id:${phone}:provider`, `unoapi-message:${phone}:jid:id`])
  expect(JSON.stringify(result)).not.toContain('jid:id')
})

test('shared import/cleanup scope excludes known control and unknown domains, matching exact session identities', () => {
  for (const key of [`unoapi-history-sync:${phone}:started`, `unoapi-webhook-history:${phone}`]) {
    expect(isRetainedSessionControlKey(key, phone)).toBe(true)
    expect(isSessionCompatibilityDataKey(key, phone)).toBe(false)
    expect(isSessionSourceCleanupKey(key, phone, prefix)).toBe(false)
  }
  for (const key of [`unoapi-unknown-future:${phone}:x`, `unoapi-history-sync:${phone}:unknown`, `unoapi-webhook-history:${phone}:unknown`,
    `unoapi-history-sync:${phone}0:started`, `unoapi-webhook-history:${phone}0`]) {
    expect(isRetainedSessionControlKey(key, phone)).toBe(false)
    expect(isSessionCompatibilityDataKey(key, phone)).toBe(false)
  }
  for (const key of [`unoapi-status-media:${phone}:id`, `unoapi-own-profile:v1:${phone}`, `unoapi-zapo-username-lid:${phone}`]) {
    expect(isSessionCompatibilityDataKey(key, phone)).toBe(true)
    expect(isSessionSourceCleanupKey(key, phone, prefix)).toBe(true)
  }
})

test('legacy snapshots retain bootstrap/webhook control separately without divergent skips or sending them to delete Lua', async () => {
  const f = fixture(), progress = jest.fn(async () => {})
  const controls = [`unoapi-history-sync:${phone}:started`, `unoapi-webhook-history:${phone}`]
  for (const key of controls) db.run('INSERT INTO uno_source_fingerprints VALUES (?,?,?,?)', [key, 'a'.repeat(40), null, Date.now()])
  const result = await cleanRedisSource({ ...f.input, progress })
  expect(result).toMatchObject({ retainedControl: 2, skipped: 0, skippedScope: 0, deleted: 0, missing: 0, batches: 0 })
  expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.input.verifyBackup).toHaveBeenCalled()
  expect(progress).toHaveBeenCalledWith({ phase: 'source_cleanup', processed: 2 })
  db.run('INSERT INTO uno_source_fingerprints VALUES (?,?,?,?)', [`unoapi-unknown-future:${phone}:x`, 'b'.repeat(40), null, Date.now()])
  const unknown = await cleanRedisSource(f.input)
  expect(unknown).toMatchObject({ retainedControl: 2, skipped: 1, skippedScope: 1, deleted: 0 })
  expect(f.redis.eval).not.toHaveBeenCalled()
})

test('a legacy mixed snapshot completes with deleted data plus retained controls, not source divergence', async () => {
  const f = fixture(), data = `unoapi-id:${phone}:provider`
  for (const key of [data, `unoapi-history-sync:${phone}:started`, `unoapi-webhook-history:${phone}`]) db.run('INSERT INTO uno_source_fingerprints VALUES (?,?,?,?)', [key, 'a'.repeat(40), null, Date.now()])
  f.redis.eval.mockResolvedValue([1, 0, 0, 512, 0, 0, 0])
  expect(await cleanRedisSource(f.input)).toMatchObject({ deleted: 1, retainedControl: 2, skipped: 0, skippedScope: 0, deletedKeyBytes: 512 })
  const call: any[] = f.redis.eval.mock.calls[0]
  expect(call[1]).toBe(4); expect(call[5]).toBe(data)
  expect(call.slice(5, 6)).toEqual([data])
})

test('cleanup refuses unconfirmed, wrong generation, online state, missing backup and unverified backup before deletion', async () => {
  const f = fixture()
  await expect(cleanRedisSource({ ...f.input, body: { ...f.input.body, confirm: false } })).rejects.toThrow('session_storage_cleanup_confirmation_required')
  await expect(cleanRedisSource({ ...f.input, body: { ...f.input.body, generation: 2 } })).rejects.toThrow('session_storage_cleanup_confirmation_required')
  await expect(cleanRedisSource({ ...f.input, storage: { ...f.input.storage, state: 'active' } })).rejects.toThrow('session_storage_cleanup_requires_offline_sqlite')
  f.redis.get.mockResolvedValueOnce(null as any); await expect(cleanRedisSource(f.input)).rejects.toThrow('session_storage_cleanup_backup_required')
  f.input.verifyBackup.mockResolvedValueOnce(false); await expect(cleanRedisSource(f.input)).rejects.toThrow('session_storage_cleanup_backup_verification_failed')
  expect(f.redis.eval).not.toHaveBeenCalled()
  expect(CLEAN_SOURCE_BATCH_LUA.indexOf('for i,row in ipairs(rows)')).toBeLessThan(CLEAN_SOURCE_BATCH_LUA.indexOf("redis.call('UNLINK'"))
})
