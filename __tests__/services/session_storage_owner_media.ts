import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { downloadMediaMessage, proto } from 'zapo-js'
import { closeAllSessionDatabases, openSessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { prepareSqliteSessionMedia } from '../../src/services/session_storage/owner_sqlite_media'
import { SessionMessageMedia } from '../../src/services/messages/session_message_media'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'

jest.mock('zapo-js', () => ({ ...jest.requireActual('zapo-js'), downloadMediaMessage: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
const phone = '999123456789', id = 'ABC', jid = '123@lid'
let root: string, config: any, previous: NodeJS.ProcessEnv, mediaStore: any, native: ReturnType<typeof createSqliteStore>
beforeEach(async () => {
  previous = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'synthetic_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  root = mkdtempSync(join(tmpdir(), 'viper-owner-media-'))
  mediaStore = { hasMedia: jest.fn(async () => false), removeMedia: jest.fn(async () => {}), getFilePath: jest.fn((_phone, mediaId) => `${phone}/${mediaId}.png`), saveMediaStream: jest.fn(async () => true) }
  config = { provider: 'zapo', useRedis: true, useS3: true, baseStore: root,
    sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'synthetic_owner', generation: 1, state: 'offline' } }
  openSessionDatabase(phone, config, { create: true }); const dataStore = await getDataStoreSqlite(phone, config)
  config.getStore = jest.fn(async () => ({ mediaStore, dataStore }))
  native = createSqliteStore({ connection: sqliteSdkConnection(openSessionDatabase(phone, config)) })
  jest.clearAllMocks(); jest.mocked(downloadMediaMessage).mockResolvedValue(Readable.from(Buffer.from('synthetic-media')))
})
afterEach(() => { closeAllSessionDatabases(); process.env = previous; rmSync(root, { recursive: true, force: true }); jest.restoreAllMocks() })
const save = (message: any = { imageMessage: { mimetype: 'image/png', caption: 'synthetic', directPath: '/synthetic', mediaKey: Buffer.alloc(32, 7) } }) => native.stores.messages(phone).upsert({ id, threadJid: jid, fromMe: false, timestampMs: Date.now(), messageBytes: proto.Message.encode(message).finish() })

test('owner resolves migrated native record/UnoID and reuses existing shared media without CDN lookup', async () => {
  await save(); const { dataStore } = await config.getStore(phone, config)
  await dataStore.setUnoId(id, 'uno-mapped'); await dataStore.setMediaPayload('uno-mapped', { mime_type: 'image/png', filename: 'original.png' })
  mediaStore.hasMedia.mockResolvedValue(true)
  expect(await prepareSqliteSessionMedia(phone, config, id)).toEqual({ file: `${phone}/uno-mapped.png`, mime_type: 'image/png', filename: '' })
  expect(downloadMediaMessage).not.toHaveBeenCalled(); expect(mediaStore.saveMediaStream).not.toHaveBeenCalled()
})

test('owner streams a cache miss into S3 with bounded download and returns only safe internal location metadata', async () => {
  await save(); const stream = Readable.from(Buffer.from('synthetic')), destroy = jest.spyOn(stream, 'destroy')
  jest.mocked(downloadMediaMessage).mockResolvedValue(stream)
  const [first, second] = await Promise.all([prepareSqliteSessionMedia(phone, config, id), prepareSqliteSessionMedia(phone, config, id)])
  expect(first).toEqual(second); expect(first).toEqual({ file: `${phone}/${id}.png`, mime_type: 'image/png', filename: '' })
  expect(downloadMediaMessage).toHaveBeenCalledTimes(1)
  expect(downloadMediaMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 268435456, timeoutMs: 60000 }))
  expect(mediaStore.saveMediaStream).toHaveBeenCalledWith(`${phone}/${id}.png`, stream, 'image/png', false)
  expect(destroy).toHaveBeenCalled(); expect(Object.keys(first).sort()).toEqual(['file', 'filename', 'mime_type'])
})

test.each(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'])('blocks %s before S3 or CDN activity', async wrapper => {
  await save({ [wrapper]: { message: { imageMessage: { mimetype: 'image/png' } } } })
  await expect(prepareSqliteSessionMedia(phone, config, id)).rejects.toThrow('message_media_not_available')
  expect(config.getStore).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
})

test.each(['revoked', 'expired', 'tombstone', 'missing', 'text'])('does not recover unavailable native media (%s)', async reason => {
  const db = openSessionDatabase(phone, config)
  if (reason !== 'missing') await save(reason === 'text' ? { conversation: 'text' } : undefined)
  if (reason === 'revoked') db.putValue(`unoapi:zapo:panel:${phone}:state:${id}`, JSON.stringify({ type: 'revoked' }))
  if (reason === 'expired') db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', id, Date.now() - 1])
  if (reason === 'tombstone') { db.exec('CREATE TABLE uno_native_tombstones(domain TEXT,record_id TEXT)'); db.run('INSERT INTO uno_native_tombstones VALUES(?,?)', ['msg', id]) }
  await expect(prepareSqliteSessionMedia(phone, config, id)).rejects.toThrow(reason === 'revoked' ? 'message_media_not_available' : reason === 'text' ? 'message_has_no_media' : 'message_not_found')
  expect(config.getStore).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
})

test.each(['fixture', 'synthetic-runtime', 'wrong-owner', 'local-media', 'transition', 'invalid-id'])('owner/safety/capability guards fail before storage/CDN effects (%s)', async reason => {
  if (reason === 'fixture') config.sessionStorage.fixture = true
  if (reason === 'synthetic-runtime') process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'
  if (reason === 'wrong-owner') config.sessionStorage.owner = 'foreign'
  if (reason === 'local-media') config.useS3 = false
  if (reason === 'transition') config.sessionStorage.state = 'migrating'
  await expect(prepareSqliteSessionMedia(phone, config, reason === 'invalid-id' ? '../secret' : id)).rejects.toThrow()
  expect(config.getStore).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
})

test('failed or incomplete S3 writes are removed and do not poison the next retry', async () => {
  await save(); mediaStore.saveMediaStream.mockResolvedValueOnce(false)
  await expect(prepareSqliteSessionMedia(phone, config, id)).rejects.toThrow('session_storage_media_save_failed')
  expect(mediaStore.removeMedia).toHaveBeenCalledWith(`${phone}/${id}.png`)
  jest.mocked(downloadMediaMessage).mockResolvedValueOnce(Readable.from(Buffer.from('retry')))
  await expect(prepareSqliteSessionMedia(phone, config, id)).resolves.toHaveProperty('file')
})

test('HTTP-side lazy media requests use owner RPC rather than opening the worker SQLite file', async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'web'
  const service: any = { loadConfig: jest.fn(async () => config), index: jest.fn() }
  jest.mocked(sessionStorageRpc).mockResolvedValue({ file: `${phone}/${id}.png`, mime_type: 'image/png', filename: '' })
  expect(await new SessionMessageMedia(service).load(phone, id)).toHaveProperty('file', `${phone}/${id}.png`)
  expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'query.media', [id])
  expect(service.index).not.toHaveBeenCalled(); expect(config.getStore).not.toHaveBeenCalled()
})
