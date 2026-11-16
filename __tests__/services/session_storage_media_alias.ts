jest.mock('zapo-js', () => ({ ...jest.requireActual('zapo-js'), downloadMediaMessage: jest.fn() }))
jest.mock('../../src/services/session_storage/database', () => ({ ...jest.requireActual('../../src/services/session_storage/database'), openSessionDatabase: jest.fn() }))
import { Readable } from 'node:stream'
import { createSqliteStore, ensureSqliteMigrations } from '@zapo-js/store-sqlite'
import { downloadMediaMessage, proto } from 'zapo-js'
import { SessionDatabase, openSessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { prepareSqliteSessionMedia } from '../../src/services/session_storage/owner_sqlite_media'
import { configs } from '../../src/services/config'

const phone = '999123456789', foreign = '999123456788', provider = 'PROVIDER_IMAGE', uno = '00000000-0000-4000-8000-000000000001'
const saved = { role: process.env.UNOAPI_PROCESS_ROLE, owner: process.env.UNOAPI_STORAGE_WORKER_ID, synthetic: process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY }
let db: SessionDatabase, config: any, native: ReturnType<typeof createSqliteStore>, mediaStore: any, dataStore: Awaited<ReturnType<typeof getDataStoreSqlite>>
const image = { imageMessage: { mimetype: 'image/png', caption: 'preserved caption', directPath: '/synthetic-fixture', mediaKey: Buffer.alloc(32, 7) } }
beforeEach(async () => {
  jest.clearAllMocks(); configs.clear()
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'alias_fixture'; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  db = new SessionDatabase(':memory:')
  jest.mocked(openSessionDatabase).mockReturnValue(db)
  const connection = sqliteSdkConnection(db)
  await ensureSqliteMigrations(connection, ['mailbox'])
  native = createSqliteStore({ connection })
  config = { provider: 'zapo', baseStore: '/unused/in-memory', useS3: true, sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'alias_fixture', generation: 2, state: 'offline' } }
  dataStore = await getDataStoreSqlite(phone, config)
  mediaStore = { hasMedia: jest.fn().mockResolvedValue(true), getFilePath: jest.fn((_phone, id) => `${phone}/${id}.png`), saveMediaStream: jest.fn().mockResolvedValue(true), removeMedia: jest.fn() }
  config.getStore = jest.fn().mockResolvedValue({ mediaStore, dataStore })
  jest.mocked(downloadMediaMessage).mockImplementation(async () => Readable.from(Buffer.from('synthetic image')))
  await native.stores.messages(phone).upsert({ id: provider, threadJid: '123456789@lid', fromMe: true, timestampMs: Date.now(), messageBytes: proto.Message.encode(image).finish() })
  await dataStore.setUnoId(provider, uno)
  await dataStore.setMediaPayload(uno, { mime_type: 'image/png', filename: 'original.png' })
})
afterEach(() => { db.close(); configs.clear() })
afterAll(() => {
  for (const [key, value] of Object.entries({ UNOAPI_PROCESS_ROLE: saved.role, UNOAPI_STORAGE_WORKER_ID: saved.owner, UNOAPI_STORAGE_SYNTHETIC_ONLY: saved.synthetic })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

test.each([uno, provider])('own native media requested with %s resolves the same live message and Uno cache without CDN calls', async id => {
  const before = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-id_rev:${phone}:${uno}`])?.expires_at
  expect(await prepareSqliteSessionMedia(phone, config, id)).toEqual({ file: `${phone}/${uno}.png`, mime_type: 'image/png', filename: '' })
  expect(downloadMediaMessage).not.toHaveBeenCalled(); expect(mediaStore.saveMediaStream).not.toHaveBeenCalled()
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-id_rev:${phone}:${uno}`])?.expires_at).toBe(before)
  expect(db.get('SELECT COUNT(*) n FROM mailbox_messages WHERE session_id=?', [phone])?.n).toBe(1)
})

test('concurrent UnoID and provider-ID cache misses share one canonical download and preserve native content', async () => {
  mediaStore.hasMedia.mockResolvedValue(false)
  const [one, two] = await Promise.all([prepareSqliteSessionMedia(phone, config, uno), prepareSqliteSessionMedia(phone, config, provider)])
  expect(one).toEqual(two)
  expect(one.file).toBe(`${phone}/${provider}.png`)
  expect(downloadMediaMessage).toHaveBeenCalledTimes(1)
  expect(downloadMediaMessage).toHaveBeenCalledWith(expect.objectContaining({ imageMessage: expect.objectContaining({ caption: 'preserved caption', directPath: '/synthetic-fixture' }) }), expect.objectContaining({ maxBytes: 268435456, timeoutMs: 60000 }))
  expect(mediaStore.saveMediaStream).toHaveBeenCalledTimes(1)
  const row = db.get('SELECT message_bytes FROM mailbox_messages WHERE session_id=? AND message_id=?', [phone, provider])
  expect(Buffer.from(row!.message_bytes)).toEqual(Buffer.from(proto.Message.encode(image).finish()))
})

test.each(['expired record', 'expired bytes', 'tombstone', 'revoked provider', 'revoked uno', 'missing native', 'view once'])('UnoID cannot bypass native media safety: %s', async reason => {
  if (reason === 'expired record') db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', provider, Date.now() - 1])
  if (reason === 'expired bytes') db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', `${provider}:message_bytes`, Date.now() - 1])
  if (reason === 'tombstone') { db.exec('CREATE TABLE uno_native_tombstones(domain TEXT,record_id TEXT)'); db.run('INSERT INTO uno_native_tombstones VALUES(?,?)', ['msg', provider]) }
  if (reason.startsWith('revoked')) db.putValue(`unoapi:zapo:panel:${phone}:state:${reason === 'revoked uno' ? uno : provider}`, JSON.stringify({ type: 'revoked' }))
  if (reason === 'missing native') db.run('DELETE FROM mailbox_messages WHERE session_id=? AND message_id=?', [phone, provider])
  if (reason === 'view once') await native.stores.messages(phone).upsert({ id: provider, threadJid: '123456789@lid', fromMe: true, timestampMs: Date.now(), messageBytes: proto.Message.encode({ viewOnceMessage: { message: image } }).finish() })
  await expect(prepareSqliteSessionMedia(phone, config, uno)).rejects.toThrow(reason.startsWith('revoked') || reason === 'view once' ? 'message_media_not_available' : 'message_not_found')
  expect(config.getStore).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled(); expect(mediaStore.hasMedia).not.toHaveBeenCalled()
})

test.each(['expired mapping', 'foreign mapping', 'one-sided mapping', 'invalid mapping'])('does not scan, revive or trust an unavailable mapping: %s', async reason => {
  if (reason === 'expired mapping') db.run('UPDATE uno_kv SET expires_at=? WHERE key=?', [Date.now() - 1, `unoapi-id_rev:${phone}:${uno}`])
  if (reason === 'foreign mapping') {
    db.deleteValue(`unoapi-id_rev:${phone}:${uno}`)
    db.putValue(`unoapi-id_rev:${foreign}:${uno}`, provider)
    db.putValue(`unoapi-id:${foreign}:${provider}`, uno)
  }
  if (reason === 'one-sided mapping') db.putValue(`unoapi-id:${phone}:${provider}`, 'DIFFERENT_UNO')
  if (reason === 'invalid mapping') db.putValue(`unoapi-id_rev:${phone}:${uno}`, '../other-session')
  await expect(prepareSqliteSessionMedia(phone, config, uno)).rejects.toThrow(reason === 'one-sided mapping' || reason === 'invalid mapping' ? 'session_storage_media_id_mapping_invalid' : 'message_not_found')
  expect(config.getStore).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
})
