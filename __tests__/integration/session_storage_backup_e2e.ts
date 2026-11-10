/**
 * Opt-in synthetic end-to-end pipeline (no service/WA credentials or live network).
 * Run: node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand
 *   --coverage=false __tests__/integration/session_storage_backup_e2e.ts
 * NodeNext runtime imports require Jest's VM-module flag. Normal runs explicitly
 * skip this suite; passing unit tests is not evidence that this harness ran.
 */
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { downloadMediaMessage, proto } from 'zapo-js'
import { amqpRpc } from '../../src/amqp'
import { defaultConfig, type Config } from '../../src/services/config'
import { getConfigRedis } from '../../src/services/config_redis'
import { sessionStorageRouter } from '../../src/controllers/session_storage_controller'
import { SessionMessagesController } from '../../src/controllers/session_messages_controller'
import { SessionMessages } from '../../src/services/messages/session_messages'
import { mediaStoreFile } from '../../src/services/media_store_file'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { remoteSessionDataStore, handleSessionStorageRequest, sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { sessionStorageGateway } from '../../src/services/session_storage/gateway'
import { SessionStorageTasks } from '../../src/services/session_storage/tasks'
import { STORAGE_CAS_LUA } from '../../src/services/session_storage/catalog'
import { closeAllSessionDatabases, getSessionSqlitePath, openSessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { decorateSqliteBackend } from '../../src/services/session_storage/native_backend'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { SessionStorageError } from '../../src/services/session_storage/types'
import { decodeBackupStream } from '../../src/services/session_storage/backup_stream'
import type { BackupObjects } from '../../src/services/session_storage/backup_objects'

jest.mock('../../src/amqp', () => ({ amqpRpc: jest.fn(), amqpConsume: jest.fn(), amqpPublish: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/backup_objects', () => ({ createBackupObjects: jest.fn(() => mockBackupObjects) }))
jest.mock('../../src/services/meta_alias', () => ({ resolveSessionPhoneByMetaId: async (phone: string) => phone }))
jest.mock('../../src/services/redis', () => ({
  BASE_KEY: 'unoapi-', getRedis: jest.fn(async () => mockRedis), getSessionPhones: jest.fn(async () => []),
  unoIdKey: (phone: string, id: string) => `unoapi-id:${phone}:${id}`,
  messageStatusKey: (phone: string, id: string) => `unoapi-message-status:${phone}:${id}`,
}))
jest.mock('../../src/services/session_storage/capability', () => ({
  ...jest.requireActual('../../src/services/session_storage/capability'),
  requireStorageVolume: () => process.env.SESSION_STORAGE_ROOT,
}))
jest.mock('../../src/services/redis_lease', () => ({ RedisLease: class {
  readonly token = module.require('node:crypto').randomUUID()
  readonly key: string
  constructor(name: string) { this.key = `unoapi-lease:${name}` }
  async acquire() { if (mockRedis.values.has(this.key)) return false; mockRedis.values.set(this.key, this.token); return true }
  async renew() { return mockRedis.values.get(this.key) === this.token }
  async release() { if (mockRedis.values.get(this.key) === this.token) mockRedis.values.delete(this.key) }
  ownership() { return { key: this.key, token: this.token } }
} }))
jest.mock('zapo-js', () => ({ ...jest.requireActual('zapo-js'), downloadMediaMessage: jest.fn(async () => { throw new Error('unexpected_whatsapp_network') }) }))

const phone = '999123456789', owner = 'synthetic_worker', group = '123456789@g.us', participant = '987654321@lid'
const token = 'synthetic-session-token'
const binary = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 1, 128, 0])
const integrationTest = typeof module.require('node:vm').SourceTextModule === 'function' ? test : test.skip
let root: string, app: express.Express, originalEnvironment: NodeJS.ProcessEnv
let mockRedis: ReturnType<typeof memoryRedis>
let mockBackupObjects: BackupObjects
let taskFailure: Error | undefined

/** Explicit transport boundary: no RabbitMQ/Redis server or real socket is used. */
function memoryRedis() {
  const values = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  return {
    values, hashes,
    get: async (key: string) => values.get(key) ?? null,
    hGet: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); return 'OK' },
    publish: async () => 0,
    eval: async (script: string, input: { keys: string[]; arguments: string[] }) => {
      const [key, second] = input.keys, args = input.arguments
      if (script.startsWith("redis.call('SET',KEYS[1],ARGV[1]); local old=")) {
        values.set(key, args[0]); const previous = values.get(second)
        if (!previous || JSON.parse(previous).createdAt <= args[1]) values.set(second, args[0])
        return 1
      }
      if (script === STORAGE_CAS_LUA) {
        const raw = values.get(key); if (!raw) return 0
        const config = JSON.parse(raw), old = config.sessionStorage
        if ((old?.generation || 0) !== Number(args[0]) || (old?.backend || 'redis') !== args[1]
          || args[3] && config.sessionStorageTaskId !== args[3]) return 0
        const next = JSON.parse(args[2]); if ((old?.owner || config.server) !== next.owner) return 0
        config.sessionStorage = next
        if (args[4]) config.sessionStorageTaskId = args[4]; else delete config.sessionStorageTaskId
        if (args[5]) config.autoConnect = JSON.parse(args[5])
        values.set(key, JSON.stringify(config)); return 1
      }
      if (script.includes("redis.call('EXISTS',KEYS[1])")) {
        if (values.has(key)) return 0
        values.set(key, args[0]); values.set(second, args[1]); return 1
      }
      if (script.includes("redis.call('PEXPIRE'")) { if (values.get(key) !== args[0]) return 0; values.set(second, args[1]); return 1 }
      if (script.includes("return redis.call('DEL',KEYS[1])")) { if (values.get(key) !== args[0]) return 0; values.delete(key); return 1 }
      if (script === "redis.call('SET',KEYS[1],ARGV[1]); return 1") { values.set(key, args[0]); return 1 }
      throw new Error('unexpected_control_plane_script')
    },
  }
}

/** Caller-owned disk emulator; it never constructs an S3 client or schedules media deletion. */
function backupObjects(): BackupObjects {
  const keys = new Set<string>(), path = (key: string) => {
    if (!key.startsWith(`backups/session-storage/${phone}/`) || key.includes('..') || key.includes('\\')) throw Error('unsafe_fixture_backup_key')
    return join(root, 'medias', key)
  }
  const readJson = async (key: string) => {
    try { const file = path(key), value = await readFile(file); return { value: JSON.parse(value.toString()), etag: createHash('sha256').update(value).digest('hex'), modifiedAt: (await stat(file)).mtimeMs } }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  return {
    save: async (key, stream) => { const file = path(key), chunks: Buffer[] = []; await mkdir(dirname(file), { recursive: true }); for await (const chunk of stream) chunks.push(Buffer.from(chunk)); await writeFile(file, Buffer.concat(chunks)); keys.add(key) },
    open: async key => createReadStream(path(key)),
    remove: async key => { await rm(path(key), { force: true }); keys.delete(key) },
    json: readJson,
    putJson: async (key, value, previous) => {
      const before = await readJson(key)
      if (previous === null ? !!before : before?.etag !== previous) return false
      const file = path(key); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value), { flag: previous === null ? 'wx' : 'w' }); keys.add(key); return true
    },
    keys: async function* (prefix) { for (const key of keys) if (key.startsWith(prefix)) yield key },
  }
}

async function configFor(value: string): Promise<Config> {
  const raw = await mockRedis.get(`unoapi-config:${value}`)
  if (!raw) throw new SessionStorageError(404, 'session_storage_session_not_found')
  const config = { ...defaultConfig, ...JSON.parse(raw), baseStore: root } as Config
  config.getStore = async () => {
    const dataStore = process.env.UNOAPI_PROCESS_ROLE === 'worker' ? await getDataStoreSqlite(value, config) : remoteSessionDataStore(value, config)
    // Disk-backed object-store emulator delegates every byte operation to the
    // real file MediaStore. Its explicit S3 capability is a test boundary, NOT
    // evidence for AWS protocol, remote credentials or cross-host accessibility.
    const objects = { ...mediaStoreFile(value, config, async () => dataStore), type: 's3' }
    return { dataStore, mediaStore: objects, sessionStore: {} } as any
  }
  return config
}

async function asOwner<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.UNOAPI_PROCESS_ROLE; process.env.UNOAPI_PROCESS_ROLE = 'worker'
  try { return await action() } finally { if (previous === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = previous }
}

async function waitTask(id: string) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const task = await new SessionStorageTasks(mockRedis).status(phone, id)
    if (task.status !== 'running') return task
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('synthetic_task_timeout')
}

beforeEach(async () => {
  originalEnvironment = { ...process.env }; root = await mkdtemp(join(tmpdir(), 'viper-storage-http-e2e-'))
  process.env.SESSION_STORAGE_ROOT = root; process.env.UNOAPI_SERVER_NAME = owner; process.env.UNOAPI_PROCESS_ROLE = 'web'
  delete process.env.UNOAPI_STORAGE_WORKER_ID; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  delete process.env.SESSION_STORAGE_BACKUP_ROTATION
  delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE
  process.env.MOBILE_REGISTRATION_KEY = 'ab'.repeat(32)
  await mkdir(join(root, 'medias'), { recursive: true })
  mockRedis = memoryRedis()
  mockBackupObjects = backupObjects()
  taskFailure = undefined
  const start = SessionStorageTasks.prototype.start
  jest.spyOn(SessionStorageTasks.prototype, 'start').mockImplementation(function (this: SessionStorageTasks, value, operation, run) {
    return start.call(this, value, operation, async (id, progress) => { try { return await run(id, progress) } catch (error) { taskFailure = error as Error; throw error } })
  })
  await mockRedis.set(`unoapi-config:${phone}`, JSON.stringify({ provider: 'zapo', server: owner, authToken: token, useRedis: true, useS3: true, autoConnect: false,
    sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner, generation: 1, state: 'offline' } }))
  jest.mocked(getConfigRedis).mockImplementation(configFor)
  jest.mocked(amqpRpc).mockImplementation(async (_exchange, queue, _key, payload: any) => {
    expect(queue).toMatch(new RegExp(`\\.session-storage\\.${owner}$`))
    return asOwner(async () => {
      const response = await handleSessionStorageRequest(payload)
      // Keep the isolated owner context until its async task settles. Real AMQP
      // returns the accepted task immediately; polling itself is tested below.
      if (response.value?.id && ['backup', 'restore'].includes(payload.operation)) await waitTask(response.value.id)
      return response
    })
  })
  await asOwner(async () => {
    const config = await configFor(phone), db = openSessionDatabase(phone, config, { create: true })
    const native = createSqliteStore({ connection: sqliteSdkConnection(db) }), decorated = decorateSqliteBackend(native, phone, config)
    const pair = { pubKey: Buffer.alloc(32, 7), privKey: Buffer.alloc(32, 8) }
    await native.stores!.auth!(phone).save({ noiseKeyPair: pair, registrationInfo: { registrationId: 123, identityKeyPair: pair }, signedPreKey: { keyId: 7, keyPair: pair, signature: Buffer.alloc(64, 9) }, advSecretKey: Buffer.alloc(32, 10), meJid: `${phone}:1@s.whatsapp.net` })
    await decorated.stores!.contacts!(phone).upsert({ jid: participant, lid: participant, displayName: 'Synthetic Participant', username: 'synthetic.user', phoneNumber: '999987654321', lastUpdatedMs: Date.now() })
    await decorated.stores!.messages!(phone).upsert({ id: 'GROUP_MEDIA', threadJid: group, participantJid: participant, fromMe: false, timestampMs: Date.now(),
      messageBytes: proto.Message.encode({ imageMessage: { caption: 'Synthetic caption', mimetype: 'image/png', mediaKey: Buffer.alloc(32, 42), directPath: '/must-not-download' } }).finish() })
    const { dataStore, mediaStore } = await config.getStore(phone, config)
    await dataStore.setUnoId('GROUP_MEDIA', 'UNO_MEDIA'); await dataStore.setMediaPayload('UNO_MEDIA', { mime_type: 'image/png' })
    await dataStore.setGroupMetada(group, { id: group, subject: 'Synthetic Group', participants: [{ id: participant }] } as any)
    await mediaStore.saveMediaStream(`${phone}/UNO_MEDIA.png`, Readable.from(binary), 'image/png', false)
    db.putValue(`unoapi-id:${phone}:IMPORTED`, 'UNO_IMPORTED', { expiresAt: Date.now() + 60000 })
    db.putValue(`unoapi-id_rev:${phone}:UNO_IMPORTED`, 'IMPORTED', { expiresAt: Date.now() + 60000 })
  })
  app = express()
  app.use('/manager', sessionStorageRouter(sessionStorageGateway, { authenticate: async value => value === 'synthetic-admin' ? { role: 'admin', kind: 'login' } : undefined } as any))
  const controller = new SessionMessagesController(new SessionMessages(configFor), configFor)
  app.get('/v15.0/:phone/conversations', controller.handle.bind(controller))
  app.get('/v15.0/:phone/conversations/:conversationId/messages', controller.handle.bind(controller))
  app.get('/v15.0/:phone/messages/:messageId/media', controller.handle.bind(controller))
})

afterEach(async () => { closeAllSessionDatabases(); process.env = originalEnvironment; jest.restoreAllMocks(); jest.clearAllMocks(); await rm(root, { recursive: true, force: true }) })
const admin = () => request(app)
const taskFor = async (id: string) => (await admin().get(`/manager/${phone}/storage/tasks/${id}`).set('Authorization', 'Bearer synthetic-admin').expect(200)).body
const backup = async () => {
  const response = await admin().post(`/manager/${phone}/storage/backups`).set('Authorization', 'Bearer synthetic-admin').send({ confirm: true }).expect(202)
  const task = await taskFor(response.body.id)
  if (task.status === 'failed') throw taskFailure || new Error(task.error)
  return task
}

integrationTest('HTTP → real RPC handlers/runtime → keyless streamed backup/restore preserves auth, group media, IDs and absolute expiry', async () => {
  const old = await configFor(phone), oldPath = getSessionSqlitePath(phone, old)
  const deadline = await asOwner(async () => openSessionDatabase(phone, old).get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-id:${phone}:IMPORTED`])!.expires_at)
  const saved = await backup(); expect(saved.status).toBe('ready'); expect(saved.result.protection).toBe('none')
  await asOwner(async () => { openSessionDatabase(phone, old).putValue('synthetic-after-backup', 'old-file-only') })
  const restored = await admin().post(`/manager/${phone}/storage/restores`).set('Authorization', 'Bearer synthetic-admin').send({ confirm: true, mode: 'offline', backupId: saved.result.id }).expect(202)
  const result = await taskFor(restored.body.id); expect(result).toMatchObject({ status: 'ready', result: { restored: true, autoConnect: false, previousStoragePreserved: true } })
  const current = await configFor(phone); expect(current.sessionStorage!.storageId).not.toBe(old.sessionStorage!.storageId)
  await asOwner(async () => {
    const db = openSessionDatabase(phone, current), native = createSqliteStore({ connection: sqliteSdkConnection(db) })
    expect(db.getValue('synthetic-after-backup')).toBeUndefined()
    expect(openSessionDatabase(phone, old).getValue('synthetic-after-backup')?.toString()).toBe('old-file-only')
    expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-id:${phone}:IMPORTED`])?.expires_at).toBe(deadline)
    expect((await native.stores!.auth!(phone).load())?.advSecretKey).toEqual(new Uint8Array(Buffer.alloc(32, 10)))
    await expect((await getDataStoreSqlite(phone, current)).loadProviderId('UNO_MEDIA')).resolves.toBe('GROUP_MEDIA')
  })
  expect(await readFile(oldPath)).toBeDefined()
  const conversations = await request(app).get(`/v15.0/${phone}/conversations?kind=group`).set('Authorization', `Bearer ${token}`).expect(200)
  expect(conversations.body.data).toEqual([expect.objectContaining({ id: group, name: 'Synthetic Group', kind: 'group' })])
  const messages = await request(app).get(`/v15.0/${phone}/conversations/${encodeURIComponent(group)}/messages`).set('Authorization', `Bearer ${token}`).expect(200)
  expect(messages.body.data).toEqual([expect.objectContaining({ id: 'GROUP_MEDIA', reply_id: 'UNO_MEDIA', sender: participant, sender_name: 'Synthetic Participant', text: 'Synthetic caption' })])
  const media = await request(app).get(`/v15.0/${phone}/messages/GROUP_MEDIA/media`).set('Authorization', `Bearer ${token}`)
  expect({ status: media.status, error: media.body.error }).toEqual({ status: 200, error: undefined })
  expect(media.body).toEqual(binary); expect(media.headers['x-content-type-options']).toBe('nosniff')
  expect(downloadMediaMessage).not.toHaveBeenCalled()
  expect(jest.mocked(amqpRpc).mock.calls.map(call => (call[3] as any).operation)).toEqual(expect.arrayContaining(['backup', 'restore', 'query.conversations', 'query.messages', 'query.media']))
}, 20000)

integrationTest('real object corruption causes failed restore without promoting a new database or destroying the prior one', async () => {
  const old = await configFor(phone), saved = await backup(); expect(saved.status).toBe('ready')
  const path = join(root, 'medias', saved.result.objectKey), bytes = await readFile(path)
  bytes[bytes.length - 20] ^= 1; await writeFile(path, bytes)
  const response = await admin().post(`/manager/${phone}/storage/restores`).set('Authorization', 'Bearer synthetic-admin').send({ confirm: true, mode: 'offline', backupId: saved.result.id }).expect(202)
  expect(await taskFor(response.body.id)).toMatchObject({ status: 'failed' })
  const current = await configFor(phone); expect(current.sessionStorage!.storageId).toBe(old.sessionStorage!.storageId); expect(current.autoConnect).toBe(false)
  await asOwner(async () => { await expect((await getDataStoreSqlite(phone, current)).loadProviderId('UNO_MEDIA')).resolves.toBe('GROUP_MEDIA') })
  expect(await readFile(getSessionSqlitePath(phone, old))).toBeDefined()
}, 20000)

integrationTest('mobile-primary keyless backup preserves vault contents without changing the live vault and refuses changed primary state', async () => {
  const draftId = randomUUID(), vault = new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY!)
  const registrationKey = `mobile-primary:{v1}:registration:${draftId}`, epochKey = `mobile-primary:{v1}:companions:${draftId}`
  const pair = { private: 'synthetic-private-fixture', public: 'synthetic-public-fixture' }
  const state = { status: 'registered', canonicalPhone: phone, advSecret: 'synthetic-adv-fixture', store: { registered: true, registrationId: 123, name: 'Synthetic primary', noiseKeyPair: pair, identityKeyPair: pair, signedPreKey: { ...pair, id: 7, signature: 'synthetic-signature-fixture' } }, diagnostic: 'must-not-be-backed-up', otp: 'not-a-real-otp' }
  const encrypted = vault.seal(draftId, state), epoch = vault.seal(epochKey, { generation: 7 })
  mockRedis.values.set(registrationKey, encrypted); mockRedis.values.set(epochKey, epoch)
  mockRedis.hashes.set('mobile-primary:{v1}:drafts', new Map([[phone, JSON.stringify({ id: draftId, phone, name: 'Synthetic primary', platform: 'android', accountType: 'personal' })]]))
  const config = JSON.parse(mockRedis.values.get(`unoapi-config:${phone}`)!); config.mobilePrimaryDraftId = draftId
  mockRedis.values.set(`unoapi-config:${phone}`, JSON.stringify(config))
  const saved = await backup(); expect(saved).toMatchObject({ status: 'ready', result: { kind: 'mobile-primary' } })
  expect(mockRedis.values.get(registrationKey)).toBe(encrypted); expect(mockRedis.values.get(epochKey)).toBe(epoch)
  const archive = await readFile(join(root, 'medias', saved.result.objectKey))
  expect(saved.result.protection).toBe('none')
  expect(archive.includes(Buffer.from('Synthetic primary'))).toBe(true)
  expect(archive.includes(Buffer.from(token))).toBe(true)
  let meta: any
  for await (const frame of decodeBackupStream(Readable.from([archive]))) if (frame.kind === 'meta') meta = frame.value
  expect(meta.supplement).toMatchObject({ phone, draftId, companionEpoch: { generation: 7 }, registration: { advSecret: state.advSecret, store: { registrationId: 123, noiseKeyPair: pair, identityKeyPair: pair, signedPreKey: state.store.signedPreKey } }, configuration: { authToken: token } })
  expect(JSON.stringify(meta.supplement.registration)).not.toContain('must-not-be-backed-up')
  expect(JSON.stringify(meta.supplement.registration)).not.toContain('not-a-real-otp')
  const validRestore = await admin().post(`/manager/${phone}/storage/restores`).set('Authorization', 'Bearer synthetic-admin').send({ confirm: true, mode: 'offline', backupId: saved.result.id }).expect(202)
  const validTask = await taskFor(validRestore.body.id)
  expect({ status: validTask.status, error: validTask.error }).toEqual({ status: 'ready', error: undefined })
  expect(mockRedis.values.get(registrationKey)).toBe(encrypted); expect(mockRedis.values.get(epochKey)).toBe(epoch)
  mockRedis.values.set(registrationKey, vault.seal(draftId, { ...state, store: { ...state.store, registrationId: 456 } }))
  const response = await admin().post(`/manager/${phone}/storage/restores`).set('Authorization', 'Bearer synthetic-admin').send({ confirm: true, mode: 'offline', backupId: saved.result.id }).expect(202)
  expect(await taskFor(response.body.id)).toMatchObject({ status: 'failed', error: 'session_storage_primary_state_changed' })
}, 20000)

integrationTest('HTTP authorization and actual owner/generation RPC guards reject unsafe requests before backup files exist', async () => {
  expect(sessionStorageGateway.restoreUpload).toEqual(expect.any(Function))
  await admin().post(`/manager/${phone}/storage/backups`).send({ confirm: true }).expect(401)
  await admin().post(`/manager/${phone}/storage/backups`).set('Authorization', 'Bearer synthetic-admin').send({ confirm: false }).expect(400)
  const current = await configFor(phone)
  await expect(sessionStorageRpc(phone, { ...current, sessionStorage: { ...current.sessionStorage!, generation: 9 } }, 'backup')).rejects.toThrow('session_storage_generation_changed')
  expect([...mockRedis.values.keys()].filter(key => key.startsWith('unoapi-session-storage:backup:'))).toEqual([])
  expect(downloadMediaMessage).not.toHaveBeenCalled()
})
