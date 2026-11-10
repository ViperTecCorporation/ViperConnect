import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { X25519, xeddsaSign } from 'zapo-js/crypto'
import { SessionSqliteBackups, type SqliteBackupManifest } from '../../src/services/session_storage/backup'
import type { BackupObjects } from '../../src/services/session_storage/backup_objects'
import { backupWeekday } from '../../src/services/session_storage/backup_slots'
import { SessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { restoreStandaloneSession, standaloneBackupManifest, StandaloneRestoreError, type StandaloneRestoreDependencies } from '../../src/services/session_storage/standalone_recovery'
import { validateStandaloneState } from '../../src/services/session_storage/standalone_validation'
import { COMMIT_STANDALONE_RESTORE_LUA, RESERVE_STANDALONE_RESTORE_LUA } from '../../src/services/session_storage/standalone_catalog'
import { convertWhalibmobCredentials } from '../../src/services/mobile_primary/whalibmob_credentials'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { decodeBackupStream } from '../../src/services/session_storage/backup_stream'
import { encryptSessionStream } from '../../src/services/session_transfer/archive_stream'

const phone = '999123456789', password = 'synthetic-standalone-backup-password', registrationKey = 'ab'.repeat(32)
let directory: string, db: SessionDatabase
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'viper-standalone-test-'))
  db = new SessionDatabase(join(directory, 'source.sqlite'))
  db.run('INSERT INTO uno_storage_meta VALUES(?,?)', ['phone', phone])
  db.putValue(`unoapi-id:${phone}:UNO`, 'PROVIDER')
  db.putValue(`unoapi-id_rev:${phone}:PROVIDER`, 'UNO')
  db.putValue(`unoapi-message:${phone}:UNO`, Buffer.from([0, 255, 13, 128]))
})
afterEach(async () => { db?.close(); await rm(directory, { recursive: true, force: true }) })

function objectFixture() {
  const files = new Map<string, Buffer>(), documents = new Map<string, any>()
  const objects: BackupObjects = {
    save: async (key, stream) => { const chunks: Buffer[] = []; for await (const part of stream) chunks.push(Buffer.from(part)); files.set(key, Buffer.concat(chunks)) },
    open: async key => { if (!files.has(key)) throw new Error('synthetic missing object'); return Readable.from([files.get(key)!]) },
    remove: async key => { files.delete(key); documents.delete(key) },
    json: async key => documents.has(key) ? { value: JSON.parse(JSON.stringify(documents.get(key))), etag: 'synthetic-etag' } : undefined,
    putJson: async (key, value) => { documents.set(key, JSON.parse(JSON.stringify(value))); return true },
    keys: async function* (prefix) { for (const key of [...files.keys(), ...documents.keys()]) if (key.startsWith(prefix)) yield key },
  }
  return { files, documents, objects }
}

function redisFixture() {
  const strings = new Map<string, string>(), sets = new Map<string, Set<string>>(), drafts = new Map<string, string>(), events: string[] = []
  let rejectCommit = false
  const redis = {
    get: async (key: string) => strings.get(key) ?? null,
    eval: jest.fn(async (script: string, { keys: k, arguments: a }: { keys: string[]; arguments: string[] }) => {
      if (script === RESERVE_STANDALONE_RESTORE_LUA) {
        if (strings.get(k[1]) !== a[0]) return -1
        if ([k[0], ...k.slice(2)].some(key => strings.has(key))) return 0
        strings.set(k[2], a[0]); strings.set(k[4], a[1]); return 1
      }
      if (script === COMMIT_STANDALONE_RESTORE_LUA) {
        if (rejectCommit || strings.get(k[1]) !== a[0] || strings.get(k[2]) !== a[0]) return -1
        if ([k[0], k[4], ...k.slice(11)].some(key => strings.has(key))) return 0
        strings.set(k[0], a[2]); strings.set(k[4], 'offline'); strings.set(k[10], a[7])
        sets.set(k[3], new Set([...(sets.get(k[3]) || []), a[1]]))
        if (a[6]) sets.set(k[9], new Set([...(sets.get(k[9]) || []), a[6]]))
        if (a[3]) { const draft = JSON.parse(a[3]); drafts.set(draft.phone, a[3]); strings.set(k[6], a[4]); if (a[5]) strings.set(k[7], a[5]) }
        events.push('config:update', 'status:update'); return 1
      }
      if (strings.get(k[0]) !== a[0]) return 0
      if (script.includes("redis.call('DEL'")) { strings.delete(k[0]); return 1 }
      if (k.length === 2) strings.set(k[1], a[1])
      return 1
    }),
  }
  const token = randomUUID(), leaseKey = `unoapi-lease:zapo-session:${phone}`
  const lease = { acquire: jest.fn(async () => { if (strings.has(leaseKey)) return false; strings.set(leaseKey, token); return true }),
    assertOwned: jest.fn(async () => { if (strings.get(leaseKey) !== token) throw new Error('synthetic lease lost') }),
    release: jest.fn(async () => { if (strings.get(leaseKey) === token) strings.delete(leaseKey) }), ownership: () => ({ key: leaseKey, token }) }
  return { redis, strings, sets, drafts, events, lease, rejectCommit: () => { rejectCommit = true } }
}

function linkedAuth(meJid = `${phone}:7@s.whatsapp.net`) {
  const pair = () => ({ pubKey: randomBytes(32), privKey: randomBytes(32) })
  return { noiseKeyPair: pair(), registrationInfo: { registrationId: 100, identityKeyPair: pair() },
    signedPreKey: { keyId: 17, keyPair: pair(), signature: randomBytes(64) }, advSecretKey: randomBytes(32), meJid }
}

async function fixture(options: { primary?: boolean; legacy?: boolean; mutation?(supplement: any): void; nativeAuth?: any } = {}) {
  const object = objectFixture(), redis = redisFixture()
  const storage = { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'source_owner', generation: 2, state: 'offline' as const, fixture: true }
  const configuration: any = { provider: 'zapo', server: 'source_owner', baseStore: directory, useRedis: true, useS3: true, autoConnect: true, authToken: 'synthetic-token', sessionStorage: storage,
    overrideWebhooks: false, webhooks: [{ id: 'old', enabled: true, urlAbsolute: 'https://synthetic.invalid' }], webhookForward: { url: 'https://synthetic.invalid' },
    sessionWebhook: 'https://synthetic.invalid', rejectCallsWebhook: 'https://synthetic.invalid', messageCallsWebhook: 'https://synthetic.invalid', sessionStorageTaskId: randomUUID() }
  const supplement: any = { configuration }
  if (options.primary) Object.assign(supplement, await primaryFixture(configuration))
  if (options.nativeAuth) await createSqliteStore({ connection: sqliteSdkConnection(db) }).stores!.auth!(phone).save(options.nativeAuth)
  options.mutation?.(supplement)
  const service = new SessionSqliteBackups(object.objects, { put: async () => undefined, get: async () => undefined })
  let manifest = await service.backup({ phone, path: db.path, storage, kind: options.primary ? 'mobile-primary' : 'linked-session', supplement })
  if (options.legacy) {
    let meta: any; const records: unknown[] = []
    for await (const frame of decodeBackupStream(Readable.from([object.files.get(manifest.objectKey)!]))) {
      if (frame.kind === 'meta') meta = frame.value
      else if (frame.kind === 'records') records.push(...frame.value)
    }
    manifest = { ...manifest }; delete manifest.protection
    const chunks: Buffer[] = []
    for await (const chunk of encryptSessionStream({ ...meta, manifest }, (async function* () { yield* records })(), password)) chunks.push(chunk)
    object.files.set(manifest.objectKey, Buffer.concat(chunks))
  }
  object.documents.set(manifest.objectKey + '.manifest.json', manifest)
  const deps: StandaloneRestoreDependencies = { objects: object.objects, redis: redis.redis, baseStore: directory, owner: 'destination_owner', password, registrationKey,
    lease: () => redis.lease, destinationEmpty: jest.fn(async (target, owned) => ![...redis.strings.keys()].some(key => !owned.includes(key) && (key === `unoapi-config:${target}` || key === `unoapi-status:${target}` || key === `unoapi-lease:zapo-session:${target}`))) }
  const input = { phone, backupId: manifest.id, confirm: true as const, confirmOriginOffline: true as const }
  return { ...object, ...redis, manifest, supplement, deps, input, service }
}

async function primaryFixture(configuration: any) {
  const pair = async () => { const value = await X25519.generateKeyPair(); return { private: Buffer.from(value.privKey), public: Buffer.concat([Buffer.from([5]), value.pubKey]) } }
  const identity = await pair(), signed = await pair()
  const source: any = { phoneNumber: phone, registered: true, codePending: false, noiseKeyPair: await pair(), identityKeyPair: identity,
    signedPreKey: { ...signed, id: 17, signature: Buffer.from(await xeddsaSign(identity.private, signed.public)) }, registrationId: 100, name: 'Synthetic', version: '2.26.27.70', advIdentity: null,
    device: { os: 'android', business: false, manufacturer: 'Samsung', model: 'Galaxy', modelId: 'SM-S928B', osVersion: '14', osBuildNumber: 'UP1A' } }
  const advSecret = randomBytes(32), native = await convertWhalibmobCredentials(source, { expectedCanonicalPhone: phone, advSecretKey: advSecret })
  // A rotated native signed prekey is deliberately different from the registration snapshot.
  const rotated = await pair(); native.signedPreKey = { keyId: 18, keyPair: { pubKey: rotated.public.subarray(1), privKey: rotated.private }, signature: Buffer.from(await xeddsaSign(identity.private, rotated.public)) }
  await createSqliteStore({ connection: sqliteSdkConnection(db) }).stores!.auth!(phone).save(native)
  for (const value of [source.noiseKeyPair, source.identityKeyPair, source.signedPreKey]) { value.private = value.private.toString('base64'); value.public = value.public.toString('base64') }
  source.signedPreKey.signature = source.signedPreKey.signature.toString('base64')
  const draft = { id: randomUUID(), phone, name: 'Synthetic primary', platform: 'android', accountType: 'personal', connectionMode: 'mobile_primary', state: 'draft', createdAt: new Date().toISOString(), createdBy: 'synthetic-admin' }
  Object.assign(configuration, { mobilePrimaryDraftId: draft.id, mobilePrimaryImported: true })
  return { phone, draftId: draft.id, draft, registration: { status: 'registered', canonicalPhone: phone, sessionPhone: phone, advSecret: advSecret.toString('base64'), store: source }, companionEpoch: { rawId: 1, currentKeyIndex: 0, companions: [] } }
}

test('restores absent linked session without any Redis catalogue, preserving binary history/IDs and forcing offline disabled hooks', async () => {
  const f = await fixture(), result = await restoreStandaloneSession(f.input, f.deps)
  expect(result).toMatchObject({ restored: true, phone, autoConnect: false, status: 'offline', webhooksEnabled: false, connected: false, replayed: false, handsetValidated: false })
  expect(result.storage).toMatchObject({ backend: 'sqlite', owner: 'destination_owner', generation: 3, state: 'offline', fixture: true })
  expect(result.storage.storageId).not.toBe(f.manifest.storageId)
  const config = JSON.parse(f.strings.get(`unoapi-config:${phone}`)!)
  expect(config).toMatchObject({ autoConnect: false, overrideWebhooks: true, server: 'destination_owner', sessionWebhook: '', rejectCallsWebhook: '', messageCallsWebhook: '', webhookForward: { url: '' }, webhooks: [{ enabled: false, disabled: true }] })
  expect(config.sessionStorageTaskId).toBeUndefined()
  expect(f.strings.get(`unoapi-status:${phone}`)).toBe('offline')
  expect(f.sets.get('unoapi-sessions:index')?.has(phone)).toBe(true)
  expect(f.sets.get('unoapi-config:auth-token-index')?.has('synthetic-token')).toBe(true)
  const restored = new SessionDatabase(join(directory, 'session-storage', result.storage.storageId, 'session.sqlite'))
  try { expect(restored.getValue(`unoapi-id:${phone}:UNO`)?.toString()).toBe('PROVIDER'); expect(restored.getValue(`unoapi-message:${phone}:UNO`)).toEqual(Buffer.from([0, 255, 13, 128])) } finally { restored.close() }
  expect(f.lease.release).toHaveBeenCalledTimes(1); expect(f.events).toEqual(['config:update', 'status:update'])
  expect(db.getValue(`unoapi-id:${phone}:UNO`)?.toString()).toBe('PROVIDER')
})

test('weekly S3 slot lookup works with no index and rejects invalid timezone/day or sidecar identity', async () => {
  const f = await fixture(), day = backupWeekday(f.manifest.createdAt, 'UTC'), key = `backups/session-storage/${phone}/slots/${day}.json`
  f.documents.set(key, { version: 1, day, timeZone: 'UTC', manifest: f.manifest })
  const input = { ...f.input, backupId: undefined, weekday: day }
  expect(await standaloneBackupManifest(input, f.objects)).toEqual(f.manifest)
  f.documents.get(key).day = (day + 1) % 7
  await expect(standaloneBackupManifest(input, f.objects)).rejects.toThrow('session_storage_backup_pointer_invalid')
  f.documents.get(key).day = day; f.documents.get(key).timeZone = 'No/SuchZone'
  await expect(standaloneBackupManifest(input, f.objects)).rejects.toThrow('session_storage_backup_timezone_invalid')
  f.documents.set(f.manifest.objectKey + '.manifest.json', { ...f.manifest, phone: '999987654321' })
  await expect(standaloneBackupManifest(f.input, f.objects)).rejects.toThrow('session_storage_backup_manifest_invalid')
})

test('linked native auth remains byte-identical in the restored database', async () => {
  const original = linkedAuth(), f = await fixture({ nativeAuth: original }), result = await restoreStandaloneSession(f.input, f.deps)
  const restored = new SessionDatabase(join(directory, 'session-storage', result.storage.storageId, 'session.sqlite'))
  try {
    const auth = await createSqliteStore({ connection: sqliteSdkConnection(restored) }).stores!.auth!(phone).load()
    expect(auth?.meJid).toBe(original.meJid)
    expect(Buffer.from(auth!.noiseKeyPair.privKey)).toEqual(original.noiseKeyPair.privKey)
    expect(Buffer.from(auth!.registrationInfo.identityKeyPair.privKey)).toEqual(original.registrationInfo.identityKeyPair.privKey)
    expect(Buffer.from(auth!.advSecretKey)).toEqual(original.advSecretKey)
    expect(auth?.deviceInfo).toBeUndefined()
  } finally { restored.close() }
})

test.each([`${phone}@lid`, '999987654321:8@s.whatsapp.net'])('linked rejects foreign or malformed native identity %s before promotion', async jid => {
  const f = await fixture({ nativeAuth: linkedAuth(jid) })
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_standalone_identity_invalid')
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
  expect(await readdir(join(directory, 'session-storage'))).toEqual([])
})

test('approved BR alias is retained as an additional conflict namespace, not silently renamed', async () => {
  const target = '5566999123456', canonical = '556699123456', f = await fixture()
  db.run('UPDATE uno_storage_meta SET value=? WHERE key=?', [target, 'phone'])
  db.run('DELETE FROM uno_kv WHERE key LIKE ?', ['unoapi-id%'])
  await createSqliteStore({ connection: sqliteSdkConnection(db) }).stores!.auth!(target).save(linkedAuth(`${canonical}:3@s.whatsapp.net`))
  db.close()
  await expect(validateStandaloneState(target, db.path, { ...f.manifest, phone: target }, f.supplement)).resolves.toHaveProperty('identityPhones', [target, canonical])
})

test.each([
  { confirm: false }, { confirmOriginOffline: false }, { backupId: undefined }, { weekday: 1 }, { backupId: '../escape' }, { backupId: undefined, weekday: 7 },
])('requires explicit offline confirmation and one exact backup selector (%j)', async change => {
  const f = await fixture()
  await expect(restoreStandaloneSession({ ...f.input, ...change } as any, f.deps)).rejects.toThrow('session_storage_standalone_confirmation_required')
  expect(f.lease.acquire).not.toHaveBeenCalled()
})

test('requires sidecar before acquiring lease; existing destination or rotation lock never creates files', async () => {
  const f = await fixture(); f.documents.clear()
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_backup_not_found')
  expect(f.lease.acquire).not.toHaveBeenCalled()
  f.documents.set(f.manifest.objectKey + '.manifest.json', f.manifest); f.strings.set(`unoapi-config:${phone}`, 'existing')
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_standalone_destination_exists')
  f.strings.delete(`unoapi-config:${phone}`); f.strings.set(`unoapi-backup-rotation:session-storage:${phone}`, 'busy')
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_standalone_destination_exists')
  await expect(stat(join(directory, 'session-storage'))).rejects.toHaveProperty('code', 'ENOENT')
})

test.each(['owner', 'busy socket', 'invalid socket token'])('invalid target %s cannot publish catalogue or alter source', async kind => {
  const f = await fixture()
  if (kind === 'owner') f.deps.owner = '../invalid'
  else if (kind === 'busy socket') f.strings.set(f.lease.ownership().key, 'existing owner')
  else f.lease.ownership = () => ({ key: `unoapi-lease:zapo-session:${phone}`, token: 'bad' })
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow(/^session_storage_/)
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
  expect(db.getValue(`unoapi-id:${phone}:UNO`)?.toString()).toBe('PROVIDER')
})

test('destination data appearing after download aborts before promotion', async () => {
  const f = await fixture(), initial = f.deps.destinationEmpty
  f.deps.destinationEmpty = jest.fn(async (target, owned) => owned.length < 3 && await initial(target, owned))
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_standalone_destination_exists')
  expect(await readdir(join(directory, 'session-storage'))).toEqual([])
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
})

test.each(['password', 'legacy-key-absent', 'corrupt'])('rejects %s, cleans only generated staging directory, and preserves source', async mode => {
  const f = await fixture({ legacy: mode !== 'corrupt' })
  if (mode === 'password') f.deps.password = 'a-different-synthetic-password'
  else if (mode === 'legacy-key-absent') f.deps.password = undefined
  else { const content = f.files.get(f.manifest.objectKey)!; content[content.length - 20] ^= 1 }
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow(mode === 'legacy-key-absent' ? 'session_storage_backup_legacy_key_required' : /^session_storage_/)
  expect(await readdir(join(directory, 'session-storage'))).toEqual([])
  expect(db.getValue(`unoapi-message:${phone}:UNO`)).toEqual(Buffer.from([0, 255, 13, 128]))
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
})

test.each([undefined, 'ignored-short-legacy-key'])('new plain standalone restore succeeds with optional key %s and remains offline', async key => {
  const f = await fixture(); f.deps.password = key
  expect(f.manifest.protection).toBe('none')
  expect(await restoreStandaloneSession(f.input, f.deps)).toMatchObject({ restored: true, autoConnect: false, connected: false, replayed: false, webhooksEnabled: false })
})

test.each(['forward', 'reverse'])('rejects live %s orphan ID mapping before promotion', async direction => {
  db.deleteValue(`unoapi-${direction === 'forward' ? 'id_rev' : 'id'}:${phone}:${direction === 'forward' ? 'PROVIDER' : 'UNO'}`)
  const f = await fixture()
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_standalone_database_invalid')
  expect(await readdir(join(directory, 'session-storage'))).toEqual([])
})

test('expired orphan is ignored, but foreign native session rows are rejected', async () => {
  db.run('INSERT INTO uno_kv(key,value,encoding,expires_at) VALUES(?,?,?,?)', [`unoapi-id:${phone}:OLD`, Buffer.from('STALE'), 'raw', 1])
  const f = await fixture(); db.close()
  await expect(validateStandaloneState(phone, db.path, f.manifest, f.supplement)).resolves.toHaveProperty('identityPhones', [phone])
  db = new SessionDatabase(join(directory, 'source.sqlite'))
  db.exec('CREATE TABLE synthetic_native(session_id TEXT, data BLOB)'); db.run('INSERT INTO synthetic_native VALUES(?,?)', ['999987654321', Buffer.from('foreign')])
  db.close()
  await expect(validateStandaloneState(phone, db.path, f.manifest, f.supplement)).rejects.toThrow('session_storage_standalone_database_invalid')
})

test('primary recovery preserves stable auth with rotated signed prekey, seals draft/registration/epoch and remains offline', async () => {
  const f = await fixture({ primary: true }), result = await restoreStandaloneSession(f.input, f.deps)
  const config = JSON.parse(f.strings.get(`unoapi-config:${phone}`)!), draft = JSON.parse(f.drafts.get(phone)!), vault = new RegistrationVault(registrationKey)
  expect(config).toMatchObject({ mobilePrimaryImported: true, mobilePrimaryDraftId: f.supplement.draftId, autoConnect: false })
  expect(draft).toEqual(f.supplement.draft)
  expect(vault.open(f.supplement.draftId, f.strings.get(`mobile-primary:{v1}:registration:${draft.id}`)!)).toMatchObject({ status: 'registered', canonicalPhone: phone, sessionPhone: phone })
  expect(vault.open(`mobile-primary:{v1}:companions:${draft.id}`, f.strings.get(`mobile-primary:{v1}:companions:${draft.id}`)!)).toEqual(f.supplement.companionEpoch)
  const restored = new SessionDatabase(join(directory, 'session-storage', result.storage.storageId, 'session.sqlite'))
  try { const auth = await createSqliteStore({ connection: sqliteSdkConnection(restored) }).stores!.auth!(phone).load(); expect(auth?.signedPreKey.keyId).toBe(18); expect(auth?.meJid).toBe(`${phone}@s.whatsapp.net`) } finally { restored.close() }
  expect(result.connected).toBe(false)
})

test.each([
  ['missing draft', (s: any) => { delete s.draft }],
  ['unimported native credentials', (s: any) => { s.configuration.mobilePrimaryImported = false }],
  ['mismatched draft ID', (s: any) => { s.draft.id = randomUUID() }],
  ['mismatched session identity', (s: any) => { s.registration.sessionPhone = '999987654321' }],
  ['mismatched device platform', (s: any) => { s.draft.platform = 'ios' }],
  ['invalid companion epoch', (s: any) => { s.companionEpoch.currentKeyIndex = -1 }],
  ['different valid noise pair', async (s: any) => { const pair = await X25519.generateKeyPair(); s.registration.store.noiseKeyPair = { private: Buffer.from(pair.privKey).toString('base64'), public: Buffer.concat([Buffer.from([5]), pair.pubKey]).toString('base64') } }],
])('primary rejects %s without credentials regeneration or catalogue write', async (_name, mutation) => {
  const f = await fixture({ primary: true }); await mutation(f.supplement); db.close()
  await expect(validateStandaloneState(phone, db.path, f.manifest, f.supplement, registrationKey)).rejects.toThrow(/^session_storage_/)
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
})

test('primary requires existing native auth and registration encryption key', async () => {
  const f = await fixture({ primary: true }); db.close()
  await expect(validateStandaloneState(phone, db.path, f.manifest, f.supplement)).rejects.toThrow('session_storage_mobile_registration_key_required')
  db = new SessionDatabase(join(directory, 'source.sqlite'))
  await createSqliteStore({ connection: sqliteSdkConnection(db) }).stores!.auth!(phone).clear()
  db.close()
  await expect(validateStandaloneState(phone, db.path, f.manifest, f.supplement, registrationKey)).rejects.toThrow('session_storage_standalone_primary_auth_required')
})

test.each(['phone metadata', 'source storage descriptor', 'provider'])('rejects inconsistent archive %s', async kind => {
  const f = await fixture()
  if (kind === 'phone metadata') db.run('UPDATE uno_storage_meta SET value=? WHERE key=?', ['999987654321', 'phone'])
  else if (kind === 'source storage descriptor') f.supplement.configuration.sessionStorage.storageId = randomUUID()
  else f.supplement.configuration.provider = 'baileys'
  db.close()
  await expect(validateStandaloneState(phone, db.path, f.manifest, f.supplement)).rejects.toThrow(/^session_storage_/)
})

test('CAS conflict after durable promotion preserves only new file with recovery identifiers, never overwrites config', async () => {
  const f = await fixture(); f.rejectCommit()
  let caught: any
  try { await restoreStandaloneSession(f.input, f.deps) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(StandaloneRestoreError)
  expect(caught.recovery).toMatchObject({ backupId: f.manifest.id, storageId: expect.any(String), operationId: expect.any(String) })
  expect((await stat(join(directory, 'session-storage', caught.recovery.storageId, 'session.sqlite'))).isFile()).toBe(true)
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
  expect(f.lease.release).toHaveBeenCalledTimes(1)
})

test('socket ownership lost during download aborts before promotion and does not release another owner', async () => {
  const f = await fixture(), originalOpen = f.objects.open
  f.objects.open = async key => { const source = await originalOpen(key); f.strings.set(f.lease.ownership().key, randomUUID()); return source }
  await expect(restoreStandaloneSession(f.input, f.deps)).rejects.toThrow('session_storage_standalone_restore_failed')
  expect(await readdir(join(directory, 'session-storage'))).toEqual([])
  expect(f.strings.has(f.lease.ownership().key)).toBe(true)
  expect(f.strings.has(`unoapi-config:${phone}`)).toBe(false)
})

test('standalone CLI parses strict inputs without importing runtime/network or exposing state in help', async () => {
  const { parseArgs, main } = require('../../scripts/restore-session-from-s3.cjs')
  expect(parseArgs(['--phone', phone, '--weekday', '0', '--confirm-offline'])).toEqual({ phone, weekday: 0, confirm: true, confirmOriginOffline: true })
  expect(parseArgs(['--phone', phone, '--backup-id', randomUUID(), '--confirm-offline']).confirmOriginOffline).toBe(true)
  for (const args of [[], ['--help', '--phone', phone], ['--phone', phone, '--weekday', '7', '--confirm-offline'], ['--phone', phone, '--weekday', '0'], ['--phone', phone, '--weekday', '0', '--phone', phone, '--confirm-offline']]) expect(() => parseArgs(args)).toThrow(/^session_storage_/)
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try { await main(['--help']); expect(write.mock.calls.map(call => call[0]).join('')).toContain('No connect or replay'); expect(write.mock.calls.map(call => call[0]).join('')).not.toContain(password) } finally { write.mockRestore() }
})
