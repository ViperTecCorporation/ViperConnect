import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore, ensureSqliteMigrations } from '@zapo-js/store-sqlite'
import { proto } from 'zapo-js'
import type { Config } from '../../src/services/config'
import { openSessionDatabase, closeAllSessionDatabases, type SessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { SqliteSessionQueries } from '../../src/services/session_storage/sqlite_queries'

const phone = '999123456789', direct = '123456789@lid', group = '120363000000001@g.us'
const processRole = process.env.UNOAPI_PROCESS_ROLE, workerId = process.env.UNOAPI_STORAGE_WORKER_ID
let root: string, config: Config, db: SessionDatabase, query: SqliteSessionQueries
let sdk: ReturnType<typeof createSqliteStore>
const stamp = () => Date.now() - 10000
beforeEach(async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'queries-test'
  root = mkdtempSync(join(tmpdir(), 'uno-session-query-test-'))
  config = { baseStore: root, sessionStorage: { backend: 'sqlite', owner: 'queries-test', storageId: randomUUID(), generation: 1, state: 'active', fixture: true } } as Config
  db = openSessionDatabase(phone, config, { create: true })
  const connection = sqliteSdkConnection(db)
  await ensureSqliteMigrations(connection, ['mailbox'])
  sdk = createSqliteStore({ connection })
  query = new SqliteSessionQueries(phone, config)
})
afterEach(() => {
  closeAllSessionDatabases()
  const expected = resolve(tmpdir())
  if (!root || !resolve(root).startsWith(expected) || !root.includes('uno-session-query-test-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
  if (processRole === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = processRole
  if (workerId === undefined) delete process.env.UNOAPI_STORAGE_WORKER_ID; else process.env.UNOAPI_STORAGE_WORKER_ID = workerId
})
async function message(id: string, thread = direct, timestamp = stamp(), content: any = { conversation: id }, owner = phone) {
  await sdk.stores.messages(owner).upsert({ id, threadJid: thread, fromMe: true, timestampMs: timestamp, messageBytes: proto.Message.encode(content).finish() })
}
async function contact(jid: string, displayName: string, username?: string, owner = phone) {
  await sdk.stores.contacts(owner).upsert({ jid, lid: jid.endsWith('@lid') ? jid : undefined, displayName, phoneNumber: '5566999999999', username, lastUpdatedMs: stamp() })
}

test('official native mailbox rows are queried without connecting any WhatsApp client', async () => {
  await message('A'); await contact(direct, 'Synthetic contact')
  const result = query.conversations()
  expect(result.data).toEqual([expect.objectContaining({ id: direct, last_message_id: 'A', name: 'Synthetic contact', preview: 'A' })])
  expect(query.messages(direct).data[0]).toEqual(expect.objectContaining({ id: 'A', text: 'A', from_me: true }))
})

test('tombstoned native media keeps a revoked history bubble but cannot return raw bytes for download', async () => {
  await message('REVOKED', direct, stamp(), { imageMessage: { caption: 'Secret caption', mediaKey: Buffer.alloc(32, 128), directPath: '/secret-media' } })
  db.exec('CREATE TABLE uno_native_tombstones(domain TEXT NOT NULL,record_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(domain,record_id))')
  db.run('INSERT INTO uno_native_tombstones VALUES(?,?,?)', ['msg', 'REVOKED', Date.now()])
  expect(query.record('REVOKED')).toBeUndefined()
  const row = query.messages(direct).data[0]
  expect(row).toMatchObject({ id: 'REVOKED', type: 'revoked', text: 'Mensagem removida' }); expect(row.media).toBeUndefined()
  expect(JSON.stringify(row)).not.toContain('Secret caption'); expect(JSON.stringify(row)).not.toContain('secret-media')
  expect(query.conversations().data[0].preview).toBe('Mensagem removida')
})

test('message keyset pagination preserves tied timestamps and does not duplicate new arrivals', async () => {
  const time = stamp()
  for (const id of ['A', 'B', 'C', 'D']) await message(id, direct, time)
  const first = query.messages(direct, { limit: 2 })
  expect(first.data.map(m => m.id)).toEqual(['D', 'C'])
  await message('E', direct, time + 1000)
  const second = query.messages(direct, { limit: 2, cursor: first.next_cursor })
  expect(second.data.map(m => m.id)).toEqual(['B', 'A'])
  expect(second.has_more).toBe(false)
})

test('conversation keyset cursor is scoped and handles identical activity timestamps', async () => {
  const time = stamp()
  for (const id of ['11111111@lid', '22222222@lid', '33333333@lid']) await message(id.replace('@lid', ''), id, time)
  const first = query.conversations({ limit: 2 })
  const second = query.conversations({ limit: 2, cursor: first.next_cursor })
  expect(first.data.map(m => m.id)).toEqual(['33333333@lid', '22222222@lid'])
  expect(second.data.map(m => m.id)).toEqual(['11111111@lid'])
  expect(() => query.conversations({ cursor: first.next_cursor, kind: 'group' })).toThrow('invalid_message_cursor')
})

test('expired and foreign session messages are not returned', async () => {
  await message('fresh'); await message('expired', direct, Date.now() - 40 * 86400000)
  await message('foreign', direct, stamp(), { conversation: 'foreign secret' }, '999000000000')
  expect(query.messages(direct).data.map(m => m.id)).toEqual(['fresh'])
  expect(query.record('expired')).toBeUndefined(); expect(query.record('foreign')).toBeUndefined()
})

test('IDs and monotonic status resolve from preserved Uno mappings and native overlays', async () => {
  await message('PROVIDER')
  db.putValue(`unoapi-id:${phone}:PROVIDER`, 'UNO_PUBLIC')
  db.putValue(`unoapi-message-status:${phone}:UNO_PUBLIC`, 'delivered')
  db.putValue(`unoapi:zapo:panel:${phone}:state:PROVIDER`, JSON.stringify({ status: 'sent', edited: true, text: 'Edited' }))
  db.putValue(`unoapi:zapo:panel:${phone}:outgoing:UNO_PENDING`, JSON.stringify({ id: 'UNO_PENDING', status: 'pending' }))
  const result = query.messages(direct, { statusIds: ['UNO_PENDING'] })
  expect(result.data[0]).toEqual(expect.objectContaining({ id: 'PROVIDER', reply_id: 'UNO_PUBLIC', text: 'Edited', status: 'delivered', edited: true }))
  expect(result.statuses).toEqual([{ id: 'UNO_PENDING', status: 'pending' }])
})

test('reply previews resolve original in same conversation without crossing to another chat', async () => {
  await message('PARENT', direct, stamp(), { conversation: 'Quoted text' })
  await message('REPLY', direct, stamp() + 100, { extendedTextMessage: { text: 'Reply', contextInfo: { stanzaId: 'PARENT' } } })
  await message('FOREIGN_PARENT', group, stamp(), { conversation: 'Private other chat' })
  await message('OTHER_REPLY', direct, stamp() + 200, { extendedTextMessage: { text: 'Other reply', contextInfo: { stanzaId: 'FOREIGN_PARENT' } } })
  const result = query.messages(direct)
  expect(result.data.find(m => m.id === 'REPLY')?.reply_preview).toEqual(expect.objectContaining({ id: 'PARENT', text: 'Quoted text', available: true }))
  expect(result.data.find(m => m.id === 'OTHER_REPLY')?.reply_preview).toBeUndefined()
})

test('fixture media and view-once projections cannot advertise media for external access', async () => {
  await message('MEDIA', direct, stamp(), { imageMessage: { caption: 'Caption', mimetype: 'image/jpeg', mediaKey: Buffer.from('synthetic secret'), directPath: '/secret' } })
  await message('ONCE', direct, stamp(), { viewOnceMessage: { message: { imageMessage: { caption: 'Private', mimetype: 'image/jpeg' } } } })
  const result = query.messages(direct)
  expect(result.data.find(m => m.id === 'MEDIA')?.media?.available).toBe(false)
  expect(result.data.find(m => m.id === 'ONCE')?.media).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('synthetic secret'); expect(JSON.stringify(result)).not.toContain('directPath')
})

test('group and direct filters respect native conversation identities and metadata', async () => {
  await message('DIRECT'); await message('GROUP', group)
  db.putValue(`unoapi-group:${phone}:${group}`, JSON.stringify({ subject: 'Synthetic group' }))
  expect(query.conversations({ kind: 'group' }).data).toEqual([expect.objectContaining({ id: group, name: 'Synthetic group', kind: 'group' })])
  expect(query.conversations({ kind: 'direct' }).data.map(m => m.id)).toEqual([direct])
})

test('contact listing is LID-first, counts aliases and isolates session data', async () => {
  await contact(direct, 'Alice'); await contact('5566999999999@s.whatsapp.net', 'Alias')
  await contact('33333333@lid', 'Carol'); await contact('44444444@lid', 'Foreign', undefined, '999000000000')
  const first = query.contacts({ limit: 1 })
  expect(first.total_count).toBe(2); expect(first.raw_total_count).toBe(3); expect(first.ignored_count).toBe(1)
  expect(first.contacts).toHaveLength(1); expect(first.has_more).toBe(true)
  const second = query.contacts({ limit: 1, cursor: first.next_cursor })
  expect(second.contacts).toHaveLength(1)
  expect(first.contacts[0].user_id).not.toBe(second.contacts[0].user_id)
  expect(query.contacts({ search: 'Alice' }).contacts.map(c => c.user_id)).toEqual([direct])
})

test('conversation and message selectors validate scopes and do not accept SQL syntax as ids', async () => {
  await message('A')
  expect(() => query.messages("' OR 1=1--")).toThrow('invalid_conversation_id')
  expect(() => query.messages(direct, { ids: ["' OR 1=1--"] })).toThrow('invalid_message_ids')
  expect(() => query.messages(direct, { statusIds: new Array(101).fill('A') })).toThrow('invalid_message_ids')
  expect(() => query.conversations({ search: 'a' })).toThrow('message_search_requires')
  expect(() => query.conversations({ conversationIds: ['status@broadcast'] })).toThrow('invalid_conversation_ids')
})

test('database survives worker-style close and reopen with same IDs and contents', async () => {
  await message('PERSISTED'); db.putValue(`unoapi-id:${phone}:PERSISTED`, 'UNO_FIXED')
  closeAllSessionDatabases()
  expect(new SqliteSessionQueries(phone, config).messages(direct).data[0]).toEqual(expect.objectContaining({ id: 'PERSISTED', reply_id: 'UNO_FIXED', text: 'PERSISTED' }))
})

test('around a tied timestamp must contain its requested message', async () => {
  const time = stamp()
  for (const id of ['A', 'B', 'C', 'D']) await message(id, direct, time)
  expect(query.messages(direct, { around: 'A', limit: 2 }).data.some(m => m.id === 'A')).toBe(true)
})

test('contact usernames survive native query projection and search', async () => {
  await contact(direct, 'Alice', 'alice.synthetic')
  expect(query.contacts().contacts[0]).toEqual(expect.objectContaining({ username: 'alice.synthetic' }))
  expect(query.contacts({ search: 'alice.synthetic' }).contacts).toHaveLength(1)
})

test('group participant names are preserved in message and quote previews', async () => {
  const sender = '987654321@lid'
  await contact(sender, 'Synthetic sender')
  await sdk.stores.messages(phone).upsert({ id: 'PARTICIPANT', threadJid: group, participantJid: sender, fromMe: false, timestampMs: stamp(), messageBytes: proto.Message.encode({ conversation: 'Hi group' }).finish() })
  await message('QUOTE_GROUP', group, stamp() + 100, { extendedTextMessage: { text: 'Reply', contextInfo: { stanzaId: 'PARTICIPANT' } } })
  const messages = query.messages(group).data
  expect(messages.find(m => m.id === 'PARTICIPANT')).toEqual(expect.objectContaining({ sender, sender_name: 'Synthetic sender' }))
  expect(messages.find(m => m.id === 'QUOTE_GROUP')?.reply_preview).toEqual(expect.objectContaining({ sender_name: 'Synthetic sender' }))
})

test('native earlier expiration migrated from Redis is honored without renewing history', async () => {
  await message('EARLIER_TTL')
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['msg', 'EARLIER_TTL', Date.now() - 1])
  expect(query.record('EARLIER_TTL')).toBeUndefined()
  expect(query.messages(direct).data).toHaveLength(0)
})

test('around cannot be combined with explicit IDs or a cursor', async () => {
  await message('A')
  expect(() => query.messages(direct, { around: 'A', ids: ['A'] })).toThrow('invalid_message_around')
})

test('expired native bytes cannot be exposed through a still-live header or conversation summary', async () => {
  await message('EXPIRED_BYTES')
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['msg', 'EXPIRED_BYTES:message_bytes', Date.now() - 1])
  expect(query.record('EXPIRED_BYTES')).toBeUndefined()
  expect(query.messages(direct).data).toHaveLength(0)
  expect(query.conversations().data).toHaveLength(0)
})

test('contacts and conversation names respect migrated earlier contact expiry', async () => {
  await contact(direct, 'Expired name'); await message('LIVE_MESSAGE')
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['contact', direct, Date.now() - 1])
  expect(query.contacts().contacts).toHaveLength(0)
  expect(query.contacts().total_count).toBe(0)
  expect(query.conversations().data[0].name).not.toBe('Expired name')
})

test('legacy mailbox schema uses migrated username index without fabricating identity', async () => {
  await contact(direct, 'Synthetic indexed')
  db.exec('ALTER TABLE mailbox_contacts DROP COLUMN username')
  db.run('INSERT INTO uno_hash(key,field,value,expires_at) VALUES(?,?,?,?)', [`unoapi-zapo-username-lid:${phone}`, `lid:${direct}`, Buffer.from('indexed.synthetic'), Date.now() + 10000])
  expect(query.contacts({ search: 'indexed.synthetic' }).contacts[0]).toEqual(expect.objectContaining({ user_id: direct, username: 'indexed.synthetic' }))
  db.run('UPDATE uno_hash SET expires_at=1')
  expect(query.contacts({ search: 'indexed.synthetic' }).contacts).toHaveLength(0)
})

test('participant device JIDs resolve preserved contact aliases and cached names', async () => {
  const sender = '987654321:4@lid', plain = '987654321@lid', pn = '5566999999999@s.whatsapp.net'
  db.putValue(`unoapi-contact-info:${phone}:${plain}`, JSON.stringify({ pnJid: pn }))
  db.putValue(`unoapi-contact-name:${phone}:${pn}`, 'Cached participant')
  await sdk.stores.messages(phone).upsert({ id: 'DEVICE_SENDER', threadJid: group, participantJid: sender, fromMe: false, timestampMs: stamp(), messageBytes: proto.Message.encode({ conversation: 'Synthetic' }).finish() })
  expect(query.messages(group).data[0]).toEqual(expect.objectContaining({ sender_name: 'Cached participant' }))
})
