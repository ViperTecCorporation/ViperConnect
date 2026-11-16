import Redis from 'ioredis'
import { mkdtempSync, rmSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { proto } from 'zapo-js/proto'
import { encodeSignalSessionRecord, encodeSenderKeyRecord } from 'zapo-js/signal'
import { createRedisStore } from '@zapo-js/store-redis'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { migrateNativeRedisToSqlite, migrateCompatibilityRedisToSqlite, sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { closeAllSessionDatabases, openSessionDatabase, getSessionSqlitePath, SessionDatabase } from '../../src/services/session_storage/database'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'

type Value = { type: string; value: any; expires: number | null }
const phone = '5566999999999', prefix = 'test:zapo:', jid = '123456789012@lid', address = { user: '123456789012', server: 'lid', device: 1 }
const bytes = (n = 32, value = 128) => Buffer.alloc(n, value)
let root: string, config: any
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'uno-native-sqlite-')); config = { baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'migrating', fixture: true } }; openSessionDatabase(phone, config, { create: true }) })
afterEach(() => { closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }) })

/** Real SDK readers over read-only paged fixtures; no Redis or WhatsApp sockets. */
function redisFixture() {
  const client = new Redis({ lazyConnect: true }) as any, values = new Map<string, Value>(), writes: string[] = []
  const put = (key: string, type: string, value: any, expires: number | null = null) => values.set(key, { type, value, expires })
  const read = (key: string) => { const row = values.get(key); return row?.expires && row.expires <= Date.now() ? undefined : row }
  const hash = (key: string) => read(key)?.value || {}
  const match = (key: string, pattern: string) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(key)
  const methods: Record<string, (...args: any[]) => any> = {
    dumpBuffer: (key: string) => { const row = read(key); return row ? Buffer.from(JSON.stringify([row.type, row.value])) : null },
    pttl: (key: string) => !read(key) ? -2 : read(key)!.expires === null ? -1 : read(key)!.expires! - Date.now(),
    type: (key: string) => read(key)?.type || 'none',
    getBuffer: (key: string) => read(key)?.type === 'string' ? Buffer.from(read(key)!.value) : null,
    get: (key: string) => read(key)?.type === 'string' ? Buffer.from(read(key)!.value).toString() : null,
    hget: (key: string, field: string) => hash(key)[field] === undefined ? null : Buffer.from(`${hash(key)[field]}`).toString(),
    hgetBuffer: (key: string, field: string) => hash(key)[field] === undefined ? null : Buffer.isBuffer(hash(key)[field]) ? hash(key)[field] : Buffer.from(`${hash(key)[field]}`),
    hgetall: (key: string) => Object.fromEntries(Object.entries(hash(key)).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString() : `${v}`])),
    hgetallBuffer: (key: string) => Object.fromEntries(Object.entries(hash(key)).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(`${v}`)])),
    hscanBuffer: (key: string, cursor: string) => { const entries = Object.entries(hash(key)), n = Number(cursor), part = entries.slice(n, n + 3); return [Buffer.from(n + 3 < entries.length ? `${n + 3}` : '0'), part.flatMap(([k, v]) => [Buffer.from(k), Buffer.isBuffer(v) ? v : Buffer.from(`${v}`)])] },
    sscanBuffer: (key: string) => [Buffer.from('0'), (read(key)?.value || []).map((value: any) => Buffer.from(value))],
    zscan: (key: string) => ['0', (read(key)?.value || []).flatMap(([member, score]: any[]) => [member, `${score}`])],
    lrangeBuffer: (key: string, begin: number, end: number) => (read(key)?.value || []).slice(begin, end + 1).map((value: any) => Buffer.from(value)),
    scan: (cursor: string, _match: string, pattern: string) => { const all = [...values.keys()].filter(key => match(key, pattern)), n = Number(cursor), part = all.slice(n, n + 7); return [n + 7 < all.length ? `${n + 7}` : '0', part] },
    smembers: (key: string) => read(key)?.value || [],
  }
  for (const [method, fn] of Object.entries(methods)) client[method] = async (...args: any[]) => fn(...args)
  client.pipeline = () => {
    const queued: Array<() => Promise<any>> = []
    const pipeline: any = { exec: async () => Promise.all(queued.map(async op => [null, await op()])) }
    for (const method of Object.keys(methods)) pipeline[method] = (...args: any[]) => { queued.push(() => client[method](...args)); return pipeline }
    return pipeline
  }
  for (const method of ['set', 'del', 'hset', 'hsetnx', 'pexpire', 'expire', 'eval', 'persist']) client[method] = () => { writes.push(method); throw new Error('fixture_read_only') }
  return { client: client as Redis, put, values, writes }
}

function seedNative(f: ReturnType<typeof redisFixture>, mobile = false) {
  const h = (domain: string, value: any, expires: number | null = null) => f.put(prefix + domain, 'hash', value, expires)
  const b = (domain: string, value: Buffer, expires: number | null = null) => f.put(prefix + domain, 'string', value, expires)
  const auth = `auth:${phone}`
  h(auth, { registration_id: '321', signed_prekey_id: '7', me_jid: `${phone}:1@s.whatsapp.net`, me_lid: jid, ...(mobile ? { device_info: JSON.stringify({ os: 'Android', business: true }), push_name: 'Teste' } : {}) })
  for (const field of ['noise_pub_key', 'noise_priv_key', 'identity_pub_key', 'identity_priv_key', 'signed_prekey_pub_key', 'signed_prekey_priv_key', 'signed_prekey_signature', 'adv_secret_key']) b(`${auth}:${field}`, bytes())
  h(`signal:reg:${phone}`, { registration_id: '321' }); b(`signal:reg:${phone}:pub`, bytes(33)); b(`signal:reg:${phone}:priv`, bytes())
  h(`signal:spk:${phone}`, { key_id: '7', uploaded: '1' }); for (const part of ['pub', 'priv', 'sig']) b(`signal:spk:${phone}:${part}`, bytes(part === 'pub' ? 33 : 32))
  h(`signal:meta:${phone}`, { server_has_prekeys: '1', next_prekey_id: '15', signed_prekey_rotation_ts: '12345' })
  h(`signal:pk:${phone}:8`, { pub: bytes(33), priv: bytes(), uploaded: Buffer.from('1') })
  f.put(`${prefix}signal:pk:ids:${phone}`, 'set', ['8']); f.put(`${prefix}signal:pk:avail:${phone}`, 'zset', [])
  const session = { local: { regId: 321, pubKey: bytes(33) }, remote: { regId: 456, pubKey: bytes(33) }, rootKey: bytes(), sendChain: { ratchetKey: { pubKey: bytes(33), privKey: bytes() }, nextMsgIndex: 2, chainKey: bytes() }, recvChains: [], initialExchangeInfo: null, prevSendChainHighestIndex: 1, aliceBaseKey: null, prevSessions: [] }
  b(`signal:sess:${phone}:${address.user}:${address.server}:1`, Buffer.from(encodeSignalSessionRecord(session)))
  b(`signal:ident:${phone}:${address.user}:${address.server}:1`, bytes(33))
  const sender = { groupId: 'group@g.us', sender: address, keyId: 3, iteration: 2, chainKey: bytes(), signingPublicKey: bytes(33), signingPrivateKey: bytes() }
  b(`sk:${phone}:group@g.us:${address.user}:${address.server}:1`, Buffer.from(encodeSenderKeyRecord(sender)))
  h(`skd:${phone}:group@g.us`, { [`${address.user}:${address.server}:1`]: '3:12345' }); f.put(`${prefix}sk:grp:${phone}:group@g.us`, 'set', [`${address.user}:${address.server}:1`])
  h(`appstate:key:${phone}:000000010000`, { key_id_hex: '000000010000', timestamp: '12345' }); b(`appstate:key:${phone}:000000010000:data`, bytes())
  h(`appstate:col:${phone}:regular`, { version: '5' }); b(`appstate:col:${phone}:regular:hash`, bytes(128)); b(`appstate:idx:${phone}:regular:abc123`, bytes())
  f.put(`${prefix}appstate:idx:set:${phone}:regular`, 'set', ['abc123']); f.put(`${prefix}appstate:key:idx:${phone}`, 'zset', [['000000010000', 1]])
  const deadline = Date.now() + 60000, now = Date.now(), content = Buffer.from(proto.Message.encode({ imageMessage: { caption: 'legenda', mediaKey: bytes() } }).finish())
  h(`msg:${phone}:provider`, { id: 'provider', thread_jid: 'group@g.us', participant_jid: jid, from_me: '1', timestamp_ms: `${now}` }, deadline)
  b(`msg:${phone}:provider:message_bytes`, content, deadline); f.put(`${prefix}msg:idx:${phone}:group@g.us`, 'zset', [['provider', now]], deadline)
  h(`contact:${phone}:${jid}`, { jid, display_name: 'Nome', username: 'colega', phone_number: '5511999999999', last_updated_ms: `${now}` }, deadline)
  b(`contact_pn:${phone}:5511999999999`, Buffer.from(jid), deadline)
  h(`thread:${phone}:group@g.us`, { jid: 'group@g.us', name: 'Grupo', unread_count: '3', archived: '0', ephemeral_setting_timestamp: '12345' }, deadline)
  h(`privtoken:${phone}:${jid}`, { jid, updated_at_ms: `${now}`, tc_token_timestamp: '55' }); b(`privtoken:${phone}:${jid}:tc_token`, bytes()); b(`privtoken:${phone}:${jid}:nct_salt`, bytes())
  h(`msgsecret:${phone}:provider`, { secret: bytes(), sender_jid: jid }, deadline)
  h(`participants:${phone}:group@g.us`, { participants_json: JSON.stringify([jid]), updated_at_ms: `${now}`, ephemeral: '86400', ephemeral_trigger: '1' }, deadline)
  h(`chat_metadata:${phone}:${jid}`, { updated_at_ms: `${now}`, ephemeral_expiration: '86400' }, deadline)
  h(`devlist:${phone}:${jid}`, { device_jids_json: JSON.stringify([`${address.user}:1@lid`]), updated_at_ms: `${now}`, alt_user_jid: '5511999999999@s.whatsapp.net' }, deadline)
  b(`devlistalt:${phone}:5511999999999@s.whatsapp.net`, Buffer.from(jid), deadline)
  h(`retry:out:${phone}:provider`, { message_id: 'provider', to_jid: jid, replay_mode: 'typed', state: 'pending', updated_at_ms: `${now}`, expires_at_ms: `${deadline}` }, deadline); b(`retry:out:${phone}:provider:replay_payload`, bytes(), deadline)
  h(`retry:in:${phone}:provider:${jid}`, { retry_count: '2' }, deadline)
  return { deadline, content }
}

test.each([false, true])('migrates all native domains through real official SQLite stores (mobile=%s)', async mobile => {
  const f = redisFixture(), fixture = seedNative(f, mobile), path = getSessionSqlitePath(phone, config)
  try {
    const result = await migrateNativeRedisToSqlite(f.client, phone, prefix, path)
    expect(result.records).toBe(f.values.size); expect(result.sha256).toHaveLength(64); expect(f.writes).toEqual([])
    const captured = openSessionDatabase(phone, config)
    expect(captured.get('SELECT COUNT(*) n FROM uno_source_fingerprints')?.n).toBe(f.values.size)
    expect(captured.get('SELECT sha1 FROM uno_source_fingerprints LIMIT 1')?.sha1).toMatch(/^[a-f0-9]{40}$/)
    const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) }), source = createRedisStore({ redis: f.client, keyPrefix: prefix })
    const auth = await native.stores.auth(phone).load(); expect(auth?.advSecretKey).toEqual(new Uint8Array(bytes())); expect(Boolean(auth?.deviceInfo)).toBe(mobile)
    expect(await native.stores.session(phone).getSession(address)).toEqual(await source.stores.session(phone).getSession(address))
    expect(await native.stores.identity(phone).getRemoteIdentity(address)).toEqual(new Uint8Array(bytes(33)))
    expect((await native.stores.messages(phone).getById('provider'))?.messageBytes).toEqual(new Uint8Array(fixture.content))
    expect((await native.stores.messages(phone).getById('provider'))?.participantJid).toBe(jid)
    expect((await native.stores.contacts(phone).getByJid(jid))?.username).toBe('colega')
    expect((await native.stores.threads(phone).getByJid('group@g.us'))?.unreadCount).toBe(3)
    expect((await native.stores.privacyToken(phone).getByJid(jid))?.nctSalt).toEqual(new Uint8Array(bytes()))
    expect((await native.stores.preKey(phone).getPreKeyById(8))?.uploaded).toBe(true)
    expect(db.get('SELECT next_prekey_id FROM signal_meta WHERE session_id=?', [phone])?.next_prekey_id).toBe(15)
    expect((await native.stores.senderKey(phone).getGroupSenderKeyList('group@g.us')).skList).toHaveLength(1)
    expect((await native.stores.senderKey(phone).getGroupSenderKeyList('group@g.us')).skDistribList[0].keyId).toBe(3)
    expect(await native.stores.appState(phone).getSyncKeyData(Buffer.from('000000010000', 'hex'))).toEqual(new Uint8Array(bytes()))
    expect((await native.stores.appState(phone).getCollectionState('regular')).version).toBe(5)
    expect((await native.caches.messageSecret(phone).get('provider'))?.secret).toEqual(new Uint8Array(bytes()))
    expect((await native.caches.groupMetadata(phone).getGroupMetadata('group@g.us'))?.participants).toEqual([jid])
    expect((await native.caches.chatMetadata(phone).getChatMetadata(jid))?.ephemeralExpiration).toBe(86400)
    expect((await native.caches.deviceList(phone).findByAnyUserJid('5511999999999@s.whatsapp.net'))?.userJid).toBe(jid)
    expect((await native.caches.retry(phone).getOutboundMessage('provider'))?.replayPayload).toEqual(new Uint8Array(bytes()))
    expect(db.get('SELECT retry_count FROM retry_inbound_counters')?.retry_count).toBe(2)
    expect(db.get('SELECT expires_at_ms FROM message_secrets_cache')?.expires_at_ms).toBeLessThanOrEqual(fixture.deadline)
    expect(db.get('PRAGMA quick_check')?.quick_check).toBe('ok')
  } finally { f.client.disconnect() }
})

test('copies compatibility IDs, binary strings, hashes, sets, lists and absolute TTL without crossing scopes', async () => {
  const f = redisFixture(), expiry = Date.now() + 60000
  f.put(`unoapi-id:${phone}:provider`, 'string', Buffer.from('uno'), expiry); f.put(`unoapi-id_rev:${phone}:uno`, 'string', Buffer.from('provider'), expiry)
  f.put(`unoapi-jidmap:${phone}:pn_for_lid:${jid}`, 'string', Buffer.from('5511999999999@s.whatsapp.net'))
  f.put(`unoapi-media:${phone}:media`, 'string', Buffer.from(JSON.stringify({ text: 'mídia' })), expiry)
  f.put(`unoapi-poll-state:${phone}:hash`, 'hash', { binary: bytes() }, expiry); f.put(`unoapi-poll-state:${phone}:set`, 'set', [bytes()])
  f.put(`unoapi-poll-state:${phone}:zset`, 'zset', [['member', 42]]); f.put(`unoapi-poll-state:${phone}:list`, 'list', [bytes(), bytes(32, 255)])
  f.put(`unoapi-id:5511999999999:foreign`, 'string', Buffer.from('foreign')); f.put(`unoapi-config:${phone}`, 'string', Buffer.from('excluded'))
  try {
    const result = await migrateCompatibilityRedisToSqlite(f.client, phone, getSessionSqlitePath(phone, config)); expect(result.records).toBe(8)
    const store = await getDataStoreSqlite(phone, config), db = openSessionDatabase(phone, config)
    expect(await store.loadUnoId('provider')).toBe('uno'); expect(await store.loadProviderId('uno')).toBe('provider')
    expect(await store.loadMediaPayload('media')).toEqual({ text: 'mídia' })
    expect(db.getValue(`unoapi-config:${phone}`)).toBeUndefined(); expect(db.getValue('unoapi-id:5511999999999:foreign')).toBeUndefined()
    expect(Buffer.from(db.get('SELECT value FROM uno_hash')!.value)).toEqual(bytes())
    expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-id:${phone}:provider`])?.expires_at).toBeLessThanOrEqual(expiry)
    expect(f.writes).toEqual([])
  } finally { f.client.disconnect() }
})

test('imports status data and versioned private snapshots but never control state or profile-cover locks', async () => {
  const f = redisFixture(), expiry = Date.now() + 60000
  const included = [`unoapi-status-recipients:${phone}`, `unoapi-status-media:${phone}:id`, `unoapi-status-media-recovery:${phone}:id`,
    `unoapi-own-profile:v1:${phone}`, `unoapi-own-profile:v1:${phone}:generation`, `unoapi-own-privacy:v1:${phone}`,
    `unoapi-own-privacy:v1:${phone}:generation`, `unoapi-own-profile-cover:v1:${phone}`]
  const excluded = [`unoapi-status:${phone}`, `unoapi-config:${phone}`, `unoapi-session-webhooks:${phone}`, `unoapi-webhook-cb:${phone}:x`,
    `unoapi-auth:${phone}`, `unoapi-auth-token:${phone}`, `unoapi-config-reload:${phone}`, `unoapi-own-profile-cover:v1:${phone}:lock`, `unoapi-own-profile:v1:${phone}0`,
    `unoapi-history-sync:${phone}:started`, `unoapi-webhook-history:${phone}`, `unoapi-unknown-future:${phone}:value`]
  for (const key of [...included, ...excluded]) f.put(key, 'string', Buffer.from(key), expiry)
  try {
    const result = await migrateCompatibilityRedisToSqlite(f.client, phone, getSessionSqlitePath(phone, config)), db = openSessionDatabase(phone, config)
    expect(result.records).toBe(included.length)
    for (const key of included) {
      expect(db.getValue(key)?.toString()).toBe(key)
      expect(db.get('SELECT sha1 FROM uno_source_fingerprints WHERE key=?', [key])?.sha1).toMatch(/^[a-f0-9]{40}$/)
      expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [key])?.expires_at).toBeLessThanOrEqual(expiry)
    }
    for (const key of excluded) expect(db.getValue(key)).toBeUndefined()
    expect(f.writes).toEqual([])
  } finally { f.client.disconnect() }
})

test('preloads Redis outside transactions and batches immutable string snapshots before fsync/promote', async () => {
  const f = redisFixture(), expiry = Date.now() + 60000
  for (let i = 0; i < 1000; i++) f.put(`unoapi-id:${phone}:provider-${String(i).padStart(4, '0')}`, 'string', Buffer.from(`uno-${i}`), expiry)
  const path = join(dirname(getSessionSqlitePath(phone, config)), `migration-${randomUUID()}.sqlite`), fd = openSync(path, 'wx', 0o600); closeSync(fd)
  const statements: string[] = [], originalExec = SessionDatabase.prototype.exec
  let transactionActive = false
  const execSpy = jest.spyOn(SessionDatabase.prototype, 'exec').mockImplementation(function (this: SessionDatabase, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') transactionActive = true
    if (sql === 'COMMIT' || sql === 'ROLLBACK') transactionActive = false
    statements.push(sql); return originalExec.call(this, sql)
  })
  const originalGet = f.client.getBuffer.bind(f.client)
  const getSpy = jest.spyOn(f.client, 'getBuffer').mockImplementation(async (...args: any[]) => { expect(transactionActive).toBe(false); return (originalGet as any)(...args) })
  try {
    const result = await migrateCompatibilityRedisToSqlite(f.client, phone, path)
    expect(result.records).toBe(1000); expect(f.writes).toEqual([])
    expect(statements).toContain('PRAGMA synchronous=NORMAL')
    expect(statements.lastIndexOf('PRAGMA synchronous=FULL')).toBeGreaterThan(statements.indexOf('PRAGMA synchronous=NORMAL'))
    expect(statements.filter(value => value === 'COMMIT').length).toBeLessThan(200)
    expect(statements.at(-1)).toBe('PRAGMA synchronous=FULL') // checkpoint is queried via get(), then file fsync.
  } finally { getSpy.mockRestore(); execSpy.mockRestore(); f.client.disconnect() }
})

test('never relaxes FULL durability when importing into a runtime session.sqlite path', async () => {
  const f = redisFixture(); f.put(`unoapi-id:${phone}:provider`, 'string', Buffer.from('uno'))
  const spy = jest.spyOn(SessionDatabase.prototype, 'exec')
  try { await migrateCompatibilityRedisToSqlite(f.client, phone, getSessionSqlitePath(phone, config)); expect(spy.mock.calls.some(([sql]) => sql === 'PRAGMA synchronous=NORMAL')).toBe(false) }
  finally { spy.mockRestore(); f.client.disconnect() }
})

test('refuses unknown native domains and corrupt required crypto instead of reporting success', async () => {
  const f = redisFixture(); f.put(`${prefix}new_native:${phone}:x`, 'string', bytes())
  try { await expect(migrateNativeRedisToSqlite(f.client, phone, prefix, getSessionSqlitePath(phone, config))).rejects.toThrow('domain_unsupported') } finally { f.client.disconnect() }
  const bad = redisFixture(); bad.put(`${prefix}auth:${phone}`, 'hash', { registration_id: '1' })
  try { await expect(migrateNativeRedisToSqlite(bad.client, phone, prefix, getSessionSqlitePath(phone, config))).rejects.toThrow('incomplete:auth') } finally { bad.client.disconnect() }
})

test('source fingerprint capture refuses a key mutated during copy instead of authorizing later cleanup', async () => {
  const f = redisFixture(), key = `unoapi-id:${phone}:provider`
  f.put(key, 'string', Buffer.from('uno'))
  let reads = 0
  ;(f.client as any).dumpBuffer = async () => Buffer.from(++reads === 1 ? 'before-dump' : 'after-dump')
  try {
    await expect(migrateCompatibilityRedisToSqlite(f.client, phone, getSessionSqlitePath(phone, config))).rejects.toThrow('session_storage_source_changed_during_copy')
    expect(openSessionDatabase(phone, config).get('SELECT COUNT(*) n FROM uno_source_fingerprints')?.n).toBe(0)
    expect(f.writes).toEqual([])
  } finally { f.client.disconnect() }
})

test('projects only the captured snapshot when Redis data disappears after copying, preserving media, group identity and mobile auth', async () => {
  const f = redisFixture(), fixture = seedNative(f, true), path = getSessionSqlitePath(phone, config)
  let copied = false
  for (const method of ['get', 'getBuffer', 'hget', 'hgetBuffer', 'hgetall', 'hgetallBuffer']) {
    const original = (f.client as any)[method].bind(f.client)
    ;(f.client as any)[method] = (...args: any[]) => { if (copied) throw new Error('live_redis_reread_forbidden'); return original(...args) }
  }
  try {
    const result = await migrateNativeRedisToSqlite(f.client, phone, prefix, path, value => {
      if (value.phase === 'copy') { copied = true; f.values.clear() }
    })
    const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) })
    const message = await native.stores.messages(phone).getById('provider')
    expect(result.records).toBeGreaterThan(30)
    expect(message).toMatchObject({ id: 'provider', threadJid: 'group@g.us', participantJid: jid, fromMe: true })
    expect(message?.messageBytes).toEqual(new Uint8Array(fixture.content))
    expect((await native.stores.auth(phone).load())?.deviceInfo).toEqual({ os: 'Android', business: true })
    expect(db.get('SELECT COUNT(*) n FROM uno_source_fingerprints')?.n).toBe(result.records)
    expect(f.writes).toEqual([])
  } finally { f.client.disconnect() }
})

test('expiry between snapshot and native projection is proved by the original deadline, not treated as missing or rejuvenated', async () => {
  const f = redisFixture(), fixture = seedNative(f), path = getSessionSqlitePath(phone, config)
  let clock = Date.now()
  const now = jest.spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const result = await migrateNativeRedisToSqlite(f.client, phone, prefix, path, value => {
      if (value.phase === 'copy') clock = fixture.deadline + 1
    })
    const db = openSessionDatabase(phone, config), native = createSqliteStore({ connection: sqliteSdkConnection(db) })
    expect(result.records).toBe(f.values.size)
    expect(await native.stores.messages(phone).getById('provider')).toBeNull()
    expect(db.get('SELECT expires_at FROM uno_native_expiry WHERE domain=? AND record_id=?', ['msg', 'provider'])?.expires_at).toBe(fixture.deadline)
    expect(db.get('SELECT COUNT(*) n FROM uno_source_fingerprints')?.n).toBe(f.values.size)
    expect(db.get('SELECT value FROM uno_kv WHERE key=?', [`${prefix}msg:${phone}:provider:message_bytes`])?.value).toEqual(new Uint8Array(fixture.content))
    expect((await native.stores.auth(phone).load())?.advSecretKey).toEqual(new Uint8Array(bytes()))
    expect(f.writes).toEqual([])
  } finally { now.mockRestore(); f.client.disconnect() }
})

test('a non-expired captured binary reference that is missing must abort, never simulate an expired or empty auth', async () => {
  const f = redisFixture(); seedNative(f)
  try {
    await expect(migrateNativeRedisToSqlite(f.client, phone, prefix, getSessionSqlitePath(phone, config), value => {
      if (value.phase === 'copy') openSessionDatabase(phone, config).run('DELETE FROM uno_kv WHERE key=?', [`${prefix}auth:${phone}:adv_secret_key`])
    })).rejects.toThrow('session_storage_snapshot_value_missing')
    expect(f.writes).toEqual([])
  } finally { f.client.disconnect() }
})
