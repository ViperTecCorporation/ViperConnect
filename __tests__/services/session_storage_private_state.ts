import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configs } from '../../src/services/config'
import { getRedis } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { closeAllSessionDatabases, openSessionDatabase } from '../../src/services/session_storage/database'
import { getSessionStateRedis, executeSessionStateCommands, sessionStateKeyOwner } from '../../src/services/session_storage/state_redis'
import { compatibilityKeyOwner } from '../../src/services/session_storage/compat_redirect'
import { isSessionSourceCleanupKey } from '../../src/services/session_storage/source_cleanup'
import { privateSessionKeyOwner } from '../../src/services/session_storage/private_keys'
import { OwnProfileCache } from '../../src/services/own_profile_cache'
import { OwnPrivacyCache } from '../../src/services/own_privacy_cache'
import { OwnProfileCover } from '../../src/services/own_profile_cover'
import { ProfilePictureMissCache } from '../../src/services/profile_picture_miss_cache'
import { ProfilePictureWebhookMarker } from '../../src/services/profile_picture_webhook_marker'

jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
const phone = '999123456789', other = '999987654321', coverKey = `unoapi-own-profile-cover:v1:${phone}`
const profileKey = `unoapi-own-profile:v1:${phone}`, privacyKey = `unoapi-own-privacy:v1:${phone}`
let directory: string, config: any, oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  oldEnvironment = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'viper-private-state-test-'))
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'synthetic_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID; process.env.SESSION_STORAGE_ROOT = directory
  config = { baseStore: directory, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'synthetic_owner', generation: 1, state: 'offline', fixture: true } }
  openSessionDatabase(phone, config, { create: true }); configs.set(phone, config); jest.clearAllMocks()
})
afterEach(() => { configs.delete(phone); closeAllSessionDatabases(); process.env = oldEnvironment; rmSync(directory, { recursive: true, force: true }); jest.restoreAllMocks() })

test('versioned profile keys share exact routing/import/cleanup scope, excluding coordination and lookalike phones', () => {
  for (const key of [profileKey, `${profileKey}:generation`, privacyKey, `${privacyKey}:generation`, coverKey]) {
    expect(privateSessionKeyOwner(key)).toBe(phone); expect(sessionStateKeyOwner(key)).toBe(phone)
    expect(compatibilityKeyOwner(key)).toBe(phone); expect(isSessionSourceCleanupKey(key, phone, 'unoapi:zapo:')).toBe(true)
  }
  for (const key of [`${coverKey}:lock`, `${coverKey}:generation`, `${profileKey}:lock`, `unoapi-own-profile:v2:${phone}`, undefined, 1]) {
    expect(privateSessionKeyOwner(key)).toBeUndefined()
    if (typeof key === 'string') expect(isSessionSourceCleanupKey(key, phone, 'unoapi:zapo:')).toBe(false)
  }
  expect(privateSessionKeyOwner(`${profileKey}0`)).not.toBe(phone)
  expect(isSessionSourceCleanupKey(`${profileKey}0`, phone, 'unoapi:zapo:')).toBe(false)
  expect(isSessionSourceCleanupKey(`unoapi-own-profile:v1:${other}`, phone, 'unoapi:zapo:')).toBe(false)
})

test('snapshot CAS preserves generation fencing, TTL and atomic invalidate without Redis data', async () => {
  const state = await getSessionStateRedis(phone)
  expect(await state.snapshotSet(profileKey, 'old', { generation: '0', ttlSeconds: 60 })).toBe('OK')
  expect(await state.ttl(profileKey)).toBeGreaterThan(0)
  await state.snapshotInvalidate(profileKey, 'new-generation', { ttlSeconds: 120, deleteSnapshot: false })
  expect(await state.get(profileKey)).toBe('old')
  expect(await state.snapshotSet(profileKey, 'stale', { generation: '0', ttlSeconds: 60 })).toBeNull()
  expect(await state.snapshotSet(profileKey, 'fresh', { generation: 'new-generation', ttlSeconds: 60 })).toBe('OK')
  await state.snapshotInvalidate(profileKey, 'next', { ttlSeconds: 120, deleteSnapshot: true })
  expect(await state.get(profileKey)).toBeNull(); expect(await state.get(`${profileKey}:generation`)).toBe('next')
  await expect(state.snapshotSet(`unoapi-own-profile:v1:${other}`, 'foreign', { generation: '0', ttlSeconds: 60 })).rejects.toThrow('scope_invalid')
  await expect(state.snapshotSet(`${profileKey}:generation`, 'bad', { generation: '0', ttlSeconds: 60 })).rejects.toThrow('command_invalid')
  await expect(state.snapshotSet(coverKey, 'bad', { generation: '0', ttlSeconds: 60 })).rejects.toThrow('scope_invalid')
  await expect(state.snapshotSet(profileKey, 'bad', { generation: 'next', ttlSeconds: 0 })).rejects.toThrow('command_invalid')
  await expect(state.snapshotInvalidate(profileKey, 'bad', { ttlSeconds: 10, deleteSnapshot: 'yes' as any })).rejects.toThrow('command_invalid')
  expect(getRedis).not.toHaveBeenCalled()
})

test('cover metadata CAS compares exact values, has no TTL and cannot delete a replacement', async () => {
  const state = await getSessionStateRedis(phone)
  expect(await state.compareSet(coverKey, null, 'first')).toBe(1)
  expect(await state.compareSet(coverKey, null, 'duplicate')).toBe(0)
  expect(await state.compareSet(coverKey, 'first', 'second')).toBe(1)
  expect(await state.compareDelete(coverKey, 'first')).toBe(0)
  expect(await state.get(coverKey)).toBe('second'); expect(await state.ttl(coverKey)).toBe(-1)
  expect(await state.compareDelete(coverKey, 'second')).toBe(1)
  expect(await state.compareDelete(coverKey, 'second')).toBe(0)
  expect(() => executeSessionStateCommands(phone, config, [{ command: 'compareSet', args: [`${coverKey}:lock`, null, 'value'] }])).toThrow('scope_invalid')
})

test('remote snapshots use only fenced owner commands and a missing SQLite never reads stale Redis snapshots', async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'web'
  ;(getConfigRedis as jest.Mock).mockResolvedValue(config); (sessionStorageRpc as jest.Mock).mockResolvedValue(['OK'])
  const state = await getSessionStateRedis(phone)
  expect(await state.snapshotSet(profileKey, 'value', { generation: '0', ttlSeconds: 60 })).toBe('OK')
  expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'state.commands', [[{ command: 'snapshotSet', args: [profileKey, 'value', { generation: '0', ttlSeconds: 60 }] }]])
  ;(getConfigRedis as jest.Mock).mockResolvedValueOnce({ ...config, sessionStorage: { ...config.sessionStorage, generation: 2 } })
  await expect(state.snapshotSet(profileKey, 'stale-remote', { generation: '0', ttlSeconds: 60 })).rejects.toThrow('generation_changed')
  expect(sessionStorageRpc).toHaveBeenCalledTimes(1)
  configs.set(phone, { ...config, sessionStorage: { ...config.sessionStorage, generation: 2 } })
  await expect(state.snapshotSet(profileKey, 'old', { generation: '0', ttlSeconds: 60 })).rejects.toThrow('generation_changed')
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; configs.set(phone, { ...config, sessionStorage: { ...config.sessionStorage, storageId: randomUUID() } })
  const unavailable = await getSessionStateRedis(phone)
  await expect(unavailable.get(profileKey)).rejects.toThrow('database_missing')
  await expect(new OwnProfileCache().read(phone, false, async () => ({ name: 'live', warnings: [] }))).rejects.toThrow('database_missing')
  expect(getRedis).not.toHaveBeenCalled()
})

test('own profile/privacy snapshots default to SQLite and keep stale-generation writes out', async () => {
  const profile = { name: 'Private synthetic', warnings: [], picture: null }
  const cache = new OwnProfileCache(), privacy = new OwnPrivacyCache()
  await cache.read(phone, false, async () => profile)
  expect((await new OwnProfileCache().read(phone, false, async () => { throw Error('unexpected upstream') })).name).toBe(profile.name)
  let release!: (value: any) => void
  const pending = cache.read(phone, true, () => new Promise(resolve => { release = resolve }))
  while (!release) await Promise.resolve()
  await cache.invalidate(phone); await cache.read(phone, true, async () => ({ ...profile, name: 'newer' })); release(profile); await pending
  expect(JSON.parse(openSessionDatabase(phone, config).getValue(profileKey)!.toString()).profile.name).toBe('newer')
  await privacy.read(phone, async () => ({ settings: {}, blocked: [], duration: 0, exceptions: {}, warnings: [] }))
  expect((await privacy.read(phone, async () => { throw Error('offline') })).cache.source).toBe('cache')
  await privacy.invalidate(phone)
  expect(openSessionDatabase(phone, config).getValue(privacyKey)).toBeUndefined()
  expect(getRedis).not.toHaveBeenCalled()
})

test('photo miss and webhook markers persist as session SQL zsets, including zScore expiration and invalidation', async () => {
  const misses = () => new ProfilePictureMissCache({ useRedis: true, ttlSeconds: 10 })
  const markers = () => new ProfilePictureWebhookMarker({ useRedis: true, intervalSeconds: 10, retentionSeconds: 100 })
  const now = Date.now(), jid = '12345@lid', state = await getSessionStateRedis(phone)
  expect(await misses().has(phone, jid, now)).toBe(false); expect(await markers().isDue(phone, jid, now)).toBe(true)
  await misses().mark(phone, jid, now); await markers().markSent(phone, jid, now)
  expect(await misses().has(phone, jid, now + 1)).toBe(true); expect(await markers().isDue(phone, jid, now + 1)).toBe(false)
  expect(await state.zScore(`unoapi-profile-picture-miss:${phone}`, 'missing')).toBeNull()
  expect(await misses().has(phone, jid, now + 10001)).toBe(false)
  expect(await markers().isDue(phone, jid, now + 10001)).toBe(true)
  await misses().invalidate(phone, jid); await markers().invalidate(phone, jid)
  expect(await state.zScore(`unoapi-profile-picture-webhook:${phone}`, jid)).toBeNull()
  expect(getRedis).not.toHaveBeenCalled()
})

test('cover keeps only lock in Redis, stores metadata in SQLite and protects replacement/removal', async () => {
  const locks = new Map<string, string>()
  const redis = { get: jest.fn(async (key: string) => locks.get(key)), set: jest.fn(async (key: string, value: string) => { if (locks.has(key)) return null; locks.set(key, value); return 'OK' }),
    eval: jest.fn(async (_script: string, { keys, arguments: args }: any) => { if (locks.get(keys[0]) === args[0]) { locks.delete(keys[0]); return 1 } return 0 }) }
  ;(getRedis as jest.Mock).mockResolvedValue(redis)
  const media: any = { type: 's3', saveMediaBuffer: jest.fn().mockResolvedValue(true), removeMedia: jest.fn().mockResolvedValue(undefined), getFileUrl: jest.fn().mockResolvedValue('https://example.invalid/preview') }
  const cover = new OwnProfileCover(phone, media)
  await cover.upload(Buffer.from('synthetic'), async () => ({ id: 'first' }))
  expect(await cover.preview()).toMatchObject({ id: 'first' })
  expect(openSessionDatabase(phone, config).getValue(coverKey)).toBeDefined(); expect(locks.size).toBe(0)
  expect(redis.set.mock.calls.every(call => call[0] === `${coverKey}:lock`)).toBe(true)
  expect(redis.get.mock.calls.every(call => call[0] === `${coverKey}:lock`)).toBe(true)
  await cover.remove('different', async () => undefined); expect(await cover.preview()).not.toBeNull()
  await cover.remove('first', async () => undefined); expect(await cover.preview()).toBeNull()
  await expect(cover.upload(Buffer.from('synthetic'), async () => { throw Error('provider refused') })).rejects.toThrow('provider refused')
  expect(await cover.preview()).toBeNull()
  // A remote success is reported honestly even when the lock expires before metadata commit.
  const result = await cover.upload(Buffer.from('synthetic'), async () => { locks.set(`${coverKey}:lock`, 'new-owner'); return { id: 'remote-only' } })
  expect(result).toEqual({ success: true, id: 'remote-only', warning: 'profile_cover_metadata_not_saved' })
  expect(openSessionDatabase(phone, config).getValue(coverKey)).toBeUndefined()
})
