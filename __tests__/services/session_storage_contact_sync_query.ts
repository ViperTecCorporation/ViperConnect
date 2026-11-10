import { createSqliteStore, ensureSqliteMigrations } from '@zapo-js/store-sqlite'
import { SessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { queryLocalContactSyncPage } from '../../src/services/session_storage/contact_sync_query'
import type { Config } from '../../src/services/config'

const phone = '999123456789', foreign = '999123456788', pn = '999123456787'
const saved = { role: process.env.UNOAPI_PROCESS_ROLE, owner: process.env.UNOAPI_STORAGE_WORKER_ID }
const config = { baseStore: '/not-used/in-memory', sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'query_fixture', generation: 2, state: 'offline', fixture: true } } as Config
let db: SessionDatabase, sdk: ReturnType<typeof createSqliteStore>
beforeEach(async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'query_fixture'
  db = new SessionDatabase(':memory:')
  const connection = sqliteSdkConnection(db)
  await ensureSqliteMigrations(connection, ['mailbox'])
  sdk = createSqliteStore({ connection })
})
afterEach(() => db.close())
afterAll(() => {
  if (saved.role === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = saved.role
  if (saved.owner === undefined) delete process.env.UNOAPI_STORAGE_WORKER_ID; else process.env.UNOAPI_STORAGE_WORKER_ID = saved.owner
})
const page = (query: any = {}, selected = config) => queryLocalContactSyncPage(phone, selected, query, db)

test('SQLite read-only pages cover preserved shadows and official native contacts without changing TTL or exposing a foreign session', async () => {
  const deadline = Date.now() + 60000
  db.putValue(`unoapi-contact-info:${phone}:${pn}@s.whatsapp.net`, JSON.stringify({ name: 'Shadow', pn, lidJid: '123456789@lid' }), { expiresAt: deadline })
  db.run('INSERT INTO uno_hash(key,field,value,expires_at) VALUES(?,?,?,?)', [`unoapi-zapo-username-lid:${phone}`, 'lid:123456789@lid', Buffer.from('known.user'), deadline])
  db.putValue(`unoapi-contact-info:${foreign}:${foreign}@s.whatsapp.net`, JSON.stringify({ name: 'Foreign', pn: foreign }))
  await sdk.stores.contacts(phone).upsert({ jid: '123456789@lid', lid: '123456789@lid', phoneNumber: pn, displayName: 'Native', lastUpdatedMs: Date.now() })
  await sdk.stores.contacts(foreign).upsert({ jid: '888888888@lid', phoneNumber: foreign, displayName: 'Foreign', lastUpdatedMs: Date.now() })
  const first = page({ limit: 1 })
  expect(first.contacts).toEqual([{ jid: `${pn}@s.whatsapp.net`, pn, name: 'Shadow', username: 'known.user' }])
  const second = page({ cursor: first.next_cursor, limit: 1 })
  expect(second.contacts).toEqual([{ jid: `${pn}@s.whatsapp.net`, pn, name: 'Native', username: 'known.user' }])
  expect(second.has_more).toBe(false)
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-contact-info:${phone}:${pn}@s.whatsapp.net`])?.expires_at).toBe(deadline)
  expect(JSON.stringify([first, second])).not.toContain('Foreign')
})

test('expired shadows, native contacts and usernames are omitted without extending their deadlines or treating LID as a phone', async () => {
  const expired = Date.now() - 1000
  db.run('INSERT INTO uno_kv(key,value,expires_at) VALUES(?,?,?)', [`unoapi-contact-info:${phone}:${pn}@s.whatsapp.net`, Buffer.from(JSON.stringify({ pn, name: 'Expired shadow' })), expired])
  await sdk.stores.contacts(phone).upsert({ jid: '123456789@lid', phoneNumber: pn, displayName: 'Expired native', lastUpdatedMs: Date.now() })
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['contact', '123456789@lid', expired])
  await sdk.stores.contacts(phone).upsert({ jid: '222222222@lid', displayName: 'Opaque LID', lastUpdatedMs: Date.now() })
  await sdk.stores.contacts(phone).upsert({ jid: '333333333@lid', phoneNumber: foreign, displayName: 'Alive', lastUpdatedMs: Date.now() })
  db.run('INSERT INTO uno_hash(key,field,value,expires_at) VALUES(?,?,?,?)', [`unoapi-zapo-username-lid:${phone}`, 'lid:333333333@lid', Buffer.from('expired.username'), expired])
  const first = page(), second = page({ cursor: first.next_cursor })
  expect(first.contacts).toEqual([])
  expect(second.contacts).toEqual([{ jid: `${foreign}@s.whatsapp.net`, pn: foreign, name: 'Alive' }])
})

test('cursor validation scopes every page to phone, storage generation, phase and bounded size', () => {
  const first = page({ limit: 1 })
  expect(() => page({ cursor: first.next_cursor }, { ...config, sessionStorage: { ...config.sessionStorage!, generation: 3 } })).toThrow('cursor_invalid')
  for (const cursor of ['not-json', 'x'.repeat(2049), Buffer.from(JSON.stringify({ scope: `${foreign}:${config.sessionStorage!.storageId}:2`, phase: 'native', after: '' })).toString('base64url')]) expect(() => page({ cursor })).toThrow('cursor_invalid')
  for (const limit of [0, 201, NaN, 1.5]) expect(() => page({ limit })).toThrow('limit_invalid')
})

test('ordered pages advance without Redis scans and refuse wrong owner or storage transition', async () => {
  for (const n of ['111111111', '222222222', '333333333']) await sdk.stores.contacts(phone).upsert({ jid: `${n}@lid`, phoneNumber: `999${n}`, displayName: n, lastUpdatedMs: Date.now() })
  const empty = page({ limit: 1 }), first = page({ cursor: empty.next_cursor, limit: 1 }), second = page({ cursor: first.next_cursor, limit: 1 }), third = page({ cursor: second.next_cursor, limit: 1 })
  expect([...first.contacts, ...second.contacts, ...third.contacts].map(row => row.name)).toEqual(['111111111', '222222222', '333333333'])
  expect(third.has_more).toBe(false)
  expect(() => page({}, { ...config, sessionStorage: { ...config.sessionStorage!, owner: 'other' } })).toThrow('wrong_owner')
  expect(() => page({}, { ...config, sessionStorage: { ...config.sessionStorage!, state: 'migrating' } })).toThrow('operation_in_progress')
})
