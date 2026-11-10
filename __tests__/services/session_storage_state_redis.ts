import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configs } from '../../src/services/config'
import { getRedis } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { closeAllSessionDatabases, openSessionDatabase } from '../../src/services/session_storage/database'
import { executeSessionStateCommands, getSessionStateRedis, sessionStateKeyOwner } from '../../src/services/session_storage/state_redis'
import { StatusRecipients } from '../../src/services/status/status_recipients'
import { ZapoUsernameIndex } from '../../src/services/zapo/zapo_username_index'

jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))

const phone = '999123456789', other = '999987654321'
const key = `unoapi-zapo-username-lid:${phone}`, seen = `${key}:seen`, status = `unoapi-status-recipients:${phone}`
let directory: string, config: any, oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  oldEnvironment = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'viper-state-test-'))
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'synthetic_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID; process.env.SESSION_STORAGE_ROOT = directory
  config = { baseStore: directory, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'synthetic_owner', generation: 1, state: 'offline', fixture: true } }
  openSessionDatabase(phone, config, { create: true }); configs.set(phone, config); jest.clearAllMocks()
})
afterEach(() => { configs.delete(phone); configs.delete(other); closeAllSessionDatabases(); process.env = oldEnvironment; rmSync(directory, { recursive: true, force: true }); jest.restoreAllMocks() })
const run = (command: string, ...args: unknown[]) => executeSessionStateCommands(phone, config, [{ command, args }])[0]

test('allows only exact session data families, never native credentials, control keys or another phone', () => {
  for (const candidate of [key, seen, status, `unoapi-contact-info:${phone}:123@lid`, `unoapi-profile-picture:${phone}:123@lid`]) expect(sessionStateKeyOwner(candidate)).toBe(phone)
  for (const candidate of [`unoapi-config:${phone}`, `unoapi-status:${phone}`, `unoapi-lease:zapo-session:${phone}`, `unoapi:zapo:auth:${phone}`, `unoapi-message:${phone}:id`]) {
    expect(sessionStateKeyOwner(candidate)).toBeUndefined(); expect(() => run('get', candidate)).toThrow('session_storage_key_scope_invalid')
  }
  expect(() => run('hGet', `unoapi-zapo-username-lid:${other}`, 'name')).toThrow('session_storage_key_scope_invalid')
  expect(() => run('eval', 'return 1')).toThrow('session_storage_state_command_invalid')
})

test('hash operations preserve Unicode, missing-field replies, overwrite counts and whole-key TTL', async () => {
  const port = await getSessionStateRedis(phone)
  expect(await port.hSet(key, 'maria', '123@lid')).toBe(1)
  expect(await port.hSet(key, 'maria', '456@lid')).toBe(0)
  await port.expire(key, 30); const previous = await port.pTTL(key)
  await port.hSet(key, 'lid:456@lid', 'Mária🙂')
  expect(await port.hGet(key, 'maria')).toBe('456@lid')
  expect(await port.hmGet(key, ['lid:456@lid', 'missing'])).toEqual(['Mária🙂', null])
  expect(await port.hKeys(key)).toEqual(['lid:456@lid', 'maria'])
  expect(await port.hGetAll(key)).toEqual({ 'lid:456@lid': 'Mária🙂', maria: '456@lid' })
  expect(await port.pTTL(key)).toBeLessThanOrEqual(previous)
  expect(await port.hDel(key, ['maria', 'missing'])).toBe(1)
  expect(await port.hDel(key, 'maria')).toBe(0)
  expect(getRedis).not.toHaveBeenCalled()
})

test('sorted-set ordering, score pruning, negative indexes and removal match Redis semantics', async () => {
  const port = await getSessionStateRedis(phone)
  expect(await port.zAdd(status, [{ score: 2, value: 'b' }, { score: 1, value: 'a' }, { score: 2, value: 'c' }])).toBe(3)
  expect(await port.zAdd(status, [{ score: 3, value: 'a' }])).toBe(0)
  expect(await port.zCard(status)).toBe(3)
  expect(await port.zRange(status, 0, -1)).toEqual(['b', 'c', 'a'])
  expect(await port.zRange(status, -2, -1)).toEqual(['c', 'a'])
  expect(await port.zRange(status, 3, 1)).toEqual([])
  expect(await port.zRangeByScore(status, '-inf', 2)).toEqual(['b', 'c'])
  expect(await port.zRem(status, 'c')).toBe(1)
  expect(await port.zRemRangeByScore(status, 0, 2)).toBe(1)
  expect(await port.zRange(status, 0, -1)).toEqual(['a'])
})

test('sets, strings, key existence and Redis SET replacement do not leave mixed types', async () => {
  const port = await getSessionStateRedis(phone), picture = `unoapi-profile-picture:${phone}:123@lid`
  expect(await port.sAdd(picture, ['a', 'a', 'b'])).toBe(2)
  expect(await port.sMembers(picture)).toEqual(['a', 'b'])
  expect(await port.sCard(picture)).toBe(2)
  expect(await port.sRem(picture, 'a')).toBe(1)
  await expect(port.hGet(picture, 'field')).rejects.toThrow('session_storage_state_wrong_type')
  expect(await port.set(picture, 'https://example.invalid/ç🙂')).toBe('OK')
  expect(await port.get(picture)).toBe('https://example.invalid/ç🙂')
  expect(openSessionDatabase(phone, config).get('SELECT COUNT(*) AS count FROM uno_set WHERE key=?', [picture])?.count).toBe(0)
  expect(await port.exists(picture)).toBe(1); expect(await port.ttl(picture)).toBe(-1)
  expect(await port.del(picture)).toBe(1); expect(await port.del(picture)).toBe(0)
  expect(await port.exists(picture)).toBe(0); expect(await port.get(picture)).toBeNull(); expect(await port.ttl(picture)).toBe(-2)
})

test('expiry hides imported hashes/zsets and new writes never resurrect expired members', async () => {
  const port = await getSessionStateRedis(phone), now = Date.now()
  await port.hSet(key, 'old', '123@lid'); await port.zAdd(status, [{ score: 1, value: 'old' }])
  await port.pExpire(key, 1000); await port.expire(status, 1)
  jest.spyOn(Date, 'now').mockReturnValue(now + 2000)
  expect(await port.hGet(key, 'old')).toBeNull(); expect(await port.zRange(status, 0, -1)).toEqual([])
  await port.hSet(key, 'new', '456@lid'); await port.zAdd(status, [{ score: 2, value: 'new' }])
  expect(await port.hKeys(key)).toEqual(['new']); expect(await port.zRange(status, 0, -1)).toEqual(['new'])
  expect(await port.pTTL(key)).toBe(-1)
  expect(await port.expire(status, 0)).toBe(1); expect(await port.expire(status, 5)).toBe(0)
})

test('scans are bounded, hide expired records and never cross session scopes', async () => {
  const port = await getSessionStateRedis(phone), prefix = `unoapi-contact-info:${phone}:`, db = openSessionDatabase(phone, config)
  db.putValue(prefix + '1', 'one'); db.putValue(prefix + '2', 'two'); db.putValue(`unoapi-contact-info:${other}:1`, 'foreign')
  db.putValue(prefix + '3', 'expired', { expiresAt: Date.now() + 1000 }); db.run('UPDATE uno_kv SET expires_at=? WHERE key=?', [Date.now() - 1, prefix + '3'])
  expect(await port.scan('0', { MATCH: prefix + '*', COUNT: 1 })).toEqual({ cursor: '1', keys: [prefix + '1'] })
  expect(await port.scan('1', { MATCH: prefix + '*', COUNT: 1 })).toEqual({ cursor: '0', keys: [prefix + '2'] })
  await expect(port.scan(0, { MATCH: `unoapi-contact-info:${other}:*`, COUNT: 100 })).rejects.toThrow('scope_invalid')
  await expect(port.scan(0, { MATCH: prefix + '[*]', COUNT: 100 })).rejects.toThrow('pattern_invalid')
})

test('batch transaction rolls back scope errors and limits RPC requests/results explicitly', () => {
  expect(() => executeSessionStateCommands(phone, config, [{ command: 'hSet', args: [key, 'name', 'lid'] }, { command: 'del', args: [`unoapi-status-recipients:${other}`] }])).toThrow('scope_invalid')
  expect(run('hGet', key, 'name')).toBeNull()
  expect(() => run('hSet', key, 'field', 'x'.repeat(65537))).toThrow('state_command_invalid')
  expect(() => executeSessionStateCommands(phone, config, Array.from({ length: 1001 }, () => ({ command: 'get', args: [key] })))).toThrow('state_command_invalid')
  const db = openSessionDatabase(phone, config)
  db.transaction(() => { for (let index = 0; index < 10001; index++) db.run('INSERT INTO uno_zset VALUES(?,?,?,NULL)', [status, `member${index}`, index]) })
  expect(() => run('zRange', status, 0, -1)).toThrow('state_result_too_large')
})

test('remote web requests use owner RPC and never open a local SQLite database or write Redis data', async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'web'; (getConfigRedis as jest.Mock).mockResolvedValue(config); (sessionStorageRpc as jest.Mock).mockResolvedValue(['123@lid'])
  const port = await getSessionStateRedis(phone)
  expect(await port.hGet(key, 'maria')).toBe('123@lid')
  expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'state.commands', [[{ command: 'hGet', args: [key, 'maria'] }]])
  expect(getRedis).not.toHaveBeenCalled()
  expect(() => run('get', key)).toThrow('wrong_owner')
})

test('legacy sessions retain the configured Redis implementation, looking up only shared control metadata', async () => {
  configs.delete(phone)
  const raw = { get: jest.fn().mockResolvedValue(JSON.stringify({ provider: 'zapo', server: 'server_1' })), hSet: jest.fn() }
  ;(getRedis as jest.Mock).mockResolvedValue(raw)
  expect(await getSessionStateRedis(phone)).toBe(raw)
  expect(raw.get).toHaveBeenCalledWith(`unoapi-config:${phone}`)
  expect(await getSessionStateRedis('session')).toBe(raw)
})

test('handles retained before generation changes and transitional storage reject writes', async () => {
  const port = await getSessionStateRedis(phone)
  configs.set(phone, { ...config, sessionStorage: { ...config.sessionStorage, generation: 2 } })
  await expect(port.hSet(key, 'maria', '123@lid')).rejects.toThrow('generation_changed')
  for (const state of ['migrating', 'restoring']) expect(() => executeSessionStateCommands(phone, { ...config, sessionStorage: { ...config.sessionStorage, state } }, [{ command: 'hSet', args: [key, 'maria', '123@lid'] }])).toThrow('operation_in_progress')
})

test('a migrated session with absent SQLite storage fails explicitly and never falls back to Redis state', async () => {
  configs.set(phone, { ...config, sessionStorage: { ...config.sessionStorage, storageId: randomUUID() } })
  const port = await getSessionStateRedis(phone)
  await expect(port.hGet(key, 'maria')).rejects.toThrow('session_storage_database_missing')
  expect(getRedis).not.toHaveBeenCalled()
})

test('username flow persists/prunes/removes exclusively in session SQLite instead of resurrecting Redis hashes', async () => {
  const index = new ZapoUsernameIndex(60), now = Date.now()
  await index.touch(phone, '@Maria', '123:2@lid', now)
  const fresh = new ZapoUsernameIndex(60)
  expect(await fresh.resolve(phone, 'maria', now)).toBe('123@lid')
  expect(await fresh.resolveByLid(phone, '123:3@lid', now)).toBe('maria')
  expect(await new ZapoUsernameIndex(60).resolveManyByLid(phone, ['123@lid', '456@lid'], now)).toEqual(new Map([['123@lid', 'maria']]))
  await fresh.removeByLid(phone, '123@lid')
  expect(run('hGet', key, 'maria')).toBeNull()
  await index.touch(phone, 'expired', '789@lid', now)
  expect(await new ZapoUsernameIndex(60).resolve(phone, 'expired', now + 61000)).toBeUndefined()
  expect(run('hGet', key, 'expired')).toBeNull()
  expect(getRedis).not.toHaveBeenCalled()
})

test('status recipient bootstrap scans SQL contact-info, expires legacy keys and stores compact recipients locally', async () => {
  const db = openSessionDatabase(phone, config), prefix = `unoapi-contact-info:${phone}:`
  db.putValue(prefix + '5511888888888@s.whatsapp.net', 'contact'); db.putValue(prefix + '123@lid', 'lid')
  const recipients = new StatusRecipients()
  expect(await recipients.loadOrBootstrap(phone)).toEqual(['5511888888888@s.whatsapp.net'])
  expect(await recipients.load(phone)).toEqual(['5511888888888@s.whatsapp.net'])
  expect(run('ttl', prefix + '123@lid')).toBeGreaterThan(0)
  expect(getRedis).not.toHaveBeenCalled(); expect(sessionStorageRpc).not.toHaveBeenCalled()
})
