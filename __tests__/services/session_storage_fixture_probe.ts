import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { proto } from 'zapo-js/proto'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { defaultConfig } from '../../src/services/config'
import * as database from '../../src/services/session_storage/database'
import * as dataStore from '../../src/services/session_storage/data_store_sqlite'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { ZapoMessageEdit, buildZapoEditContent } from '../../src/services/zapo/zapo_message_edit'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'

const previousLevel = process.env.UNO_LOG_LEVEL
const { runSqliteStorageFixtureProbe, assertLab } = require('../../scripts/probe-sqlite-storage-fixture.cjs')
const phone = '999123456789', group = '123456@g.us', sender = '123456789@lid'
const envKeys = ['UNOAPI_STORAGE_SYNTHETIC_ONLY', 'UNOAPI_SERVER_NAME', 'UNOAPI_PROCESS_ROLE', 'UNOAPI_STORAGE_WORKER_ID', 'SESSION_STORAGE_ROOT', 'ZAPO_REDIS_KEY_PREFIX']
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
let root: string, config: any
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uno-storage-probe-'))
  process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'; process.env.UNOAPI_SERVER_NAME = 'mobile_lab'; process.env.UNOAPI_PROCESS_ROLE = 'worker'
  process.env.UNOAPI_STORAGE_WORKER_ID = 'mobile_lab'; process.env.SESSION_STORAGE_ROOT = root; delete process.env.ZAPO_REDIS_KEY_PREFIX
  config = { ...defaultConfig, provider: 'zapo', server: 'mobile_lab', autoConnect: false, webhooks: [], sessionWebhook: '', baseStore: root,
    sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'mobile_lab', generation: 2, state: 'offline', fixture: true } }
})
afterEach(() => { database.closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }); for (const key of envKeys) if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key] })
afterAll(() => { if (previousLevel === undefined) delete process.env.UNO_LOG_LEVEL; else process.env.UNO_LOG_LEVEL = previousLevel })

async function fixture() {
  const values = new Map<string, string | Buffer>(), hashes = new Map<string, Record<string, string>>(), deadlines = new Map<string, number | null>(), expiry = Date.now() + 600000
  const db = database.openSessionDatabase(phone, config, { create: true }), sdk = createSqliteStore({ connection: sqliteSdkConnection(db) })
  const content = { imageMessage: { caption: 'private fixture caption', mediaKey: Buffer.alloc(32, 128), fileSha256: Buffer.alloc(32, 1), fileEncSha256: Buffer.alloc(32, 2), directPath: '/private-context', mimetype: 'image/jpeg' } }
  const original = { key: { id: 'UNO_EXISTING', remoteJid: group, fromMe: true, participant: sender }, messageTimestamp: Math.floor(Date.now() / 1000), message: content }
  const providerKey = { ...original.key, id: 'PROVIDER_EXISTING' }, prefix = 'unoapi:zapo:', stamp = Math.floor(Date.now() / 1000) * 1000
  const put = (key: string, value: string | Buffer) => { values.set(key, value); deadlines.set(key, expiry); db.putValue(key, value, { expiresAt: expiry }) }
  put(`unoapi-message:${phone}:${group}:UNO_EXISTING`, Buffer.from(proto.WebMessageInfo.encode(original).finish()).toString('base64'))
  put(`unoapi-id:${phone}:PROVIDER_EXISTING`, 'UNO_EXISTING'); put(`unoapi-id_rev:${phone}:UNO_EXISTING`, 'PROVIDER_EXISTING')
  put(`unoapi-key:${phone}:PROVIDER_EXISTING`, JSON.stringify(providerKey)); put(`unoapi-key:${phone}:UNO_EXISTING`, JSON.stringify(providerKey))
  put(`unoapi-message-status:${phone}:PROVIDER_EXISTING`, 'delivered')
  values.set(`unoapi-config:${phone}`, JSON.stringify(config)); deadlines.set(`unoapi-config:${phone}`, null)
  const nativeKey = `${prefix}msg:${phone}:PROVIDER_EXISTING`, nativeBytes = Buffer.from(proto.Message.encode(content).finish())
  hashes.set(nativeKey, { id: 'PROVIDER_EXISTING', thread_jid: group, from_me: '1', participant_jid: sender, timestamp_ms: String(stamp) }); deadlines.set(nativeKey, expiry)
  values.set(`${nativeKey}:message_bytes`, nativeBytes); deadlines.set(`${nativeKey}:message_bytes`, expiry)
  await sdk.stores.messages(phone).upsert({ id: 'PROVIDER_EXISTING', threadJid: group, fromMe: true, participantJid: sender, timestampMs: stamp, messageBytes: nativeBytes })
  const matching = (key: string, pattern: string) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(key)
  const redis: any = {
    get: async (key: string) => values.has(key) ? values.get(key)!.toString() : null,
    getBuffer: async (key: string) => values.has(key) ? Buffer.from(values.get(key)!) : null,
    hgetall: async (key: string) => hashes.get(key) || {}, type: async (key: string) => hashes.has(key) ? 'hash' : values.has(key) ? 'string' : 'none',
    pexpiretime: async (key: string) => deadlines.has(key) ? deadlines.get(key) === null ? -1 : deadlines.get(key) : -2,
    scan: async (_cursor: string, _match: string, pattern: string) => ['0', [...values.keys(), ...hashes.keys()].filter(key => matching(key, pattern))],
  }
  redis.pipeline = () => { const calls: any[] = [], p: any = { getBuffer: (key: string) => { calls.push(key); return p }, exec: async () => Promise.all(calls.map(async key => [null, await redis.getBuffer(key)])) }; return p }
  return { db, redis, values, deadlines, sdk, modules: { proto, defaultConfig, ...database, ...dataStore, sqliteSdkConnection, createSqliteStore, ZapoMessageEdit, buildZapoEditContent, ZapoMessages } }
}

test('differential fixture probe exercises actual edit/recovery consumers with fake sends and zero database mutations', async () => {
  const f = await fixture(), result = await runSqliteStorageFixtureProbe({ phone, redis: f.redis, modules: f.modules })
  expect(result.compatible).toBe(true); expect(result.sqliteWrites).toBe(0); expect(result.realSends).toBe(0)
  expect(result.copies.equal).toBe(1); expect(result.edit.accepted).toBe(1); expect(result.recovery.equal).toBe(1); expect(result.native.equal).toBe(1)
  const output = JSON.stringify(result)
  for (const secret of [phone, 'UNO_EXISTING', 'PROVIDER_EXISTING', 'private fixture caption', '/private-context', sender]) expect(output).not.toContain(secret)
})
test('a missing reverse mapping is reported as incompatibility, never repaired or assigned another ID', async () => {
  const f = await fixture(); f.db.deleteValue(`unoapi-id_rev:${phone}:UNO_EXISTING`)
  const result = await runSqliteStorageFixtureProbe({ phone, redis: f.redis, modules: f.modules })
  expect(result.compatible).toBe(false); expect(result.maps.orphans.forwardSource).toBe(0); expect(result.maps.orphans.forwardSqlite).toBe(1)
  expect(result.maps.families.id_rev.missingDestination).toBe(1)
})
test('corrupt migrated content produces aggregate mismatches without leaking the original payload', async () => {
  const f = await fixture(); f.db.putValue(`unoapi-message:${phone}:${group}:UNO_EXISTING`, 'corrupt-content', { expiresAt: Date.now() + 60000 })
  const result = await runSqliteStorageFixtureProbe({ phone, redis: f.redis, modules: f.modules })
  expect(result.compatible).toBe(false); expect(result.copies.decodeErrors + result.copies.mismatch).toBeGreaterThan(0)
  expect(JSON.stringify(result)).not.toContain('private fixture caption')
})
test('production-like environments and non-fixture configurations are rejected before any access', () => {
  delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY; expect(() => assertLab(phone)).toThrow('isolated_storage_worker_required')
  process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'; expect(() => assertLab(phone, { ...config, sessionStorage: { ...config.sessionStorage, fixture: false } })).toThrow('migrated_fixture_not_safe')
  expect(() => assertLab(phone, { ...config, webhooks: [{}] })).toThrow('migrated_fixture_not_safe')
})

test('a key expiring between source read and final count is validated without a false mismatch using one stable cutoff', async () => {
  const f = await fixture(), key = `unoapi-key:${phone}:PROVIDER_EXISTING`
  let clock = Date.now(), advance = false
  const deadline = clock + 5000
  f.deadlines.set(key, deadline); f.db.run('UPDATE uno_kv SET expires_at=? WHERE key=?', [deadline, key])
  const buffer = f.redis.getBuffer.bind(f.redis), expires = f.redis.pexpiretime.bind(f.redis)
  f.redis.getBuffer = async (entry: string) => { if (entry === key) advance = true; return buffer(entry) }
  f.redis.pexpiretime = async (entry: string) => { const value = await expires(entry); if (advance && entry === key) clock = deadline + 1; return value }
  jest.spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const result = await runSqliteStorageFixtureProbe({ phone, redis: f.redis, modules: f.modules })
    expect(result.compatible).toBe(true)
    expect(result.maps.families.key).toMatchObject({ sourceKeys: 2, sqliteKeys: 1, stableSourceKeys: 1, stableSqliteKeys: 1, expiringBeforeCutoff: 1, valuesEqual: 2, ttlEqual: 2 })
    expect(result.sqliteWrites).toBe(0)
  } finally { jest.restoreAllMocks() }
})
