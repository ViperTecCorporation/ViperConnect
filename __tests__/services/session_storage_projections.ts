import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore, ensureSqliteMigrations } from '@zapo-js/store-sqlite'
import { proto } from 'zapo-js'
import { configs, type Config } from '../../src/services/config'
import { openSessionDatabase, closeAllSessionDatabases, type SessionDatabase } from '../../src/services/session_storage/database'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'
import { applySqliteStatuses, applySqliteMessageEvent } from '../../src/services/session_storage/status_projection'
import { sessionContacts, queryLocalSessionContact, publicSessionContact } from '../../src/services/session_storage/contacts_gateway'
import { zapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { recordSessionWebhookStatuses } from '../../src/services/messages/session_message_status'
import { recordSessionMessageEvent } from '../../src/services/messages/session_message_events'
import * as redisModule from '../../src/services/redis'

jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
const phone = '999123456789', jid = '123456789@lid', pn = '5566999999999'
const role = process.env.UNOAPI_PROCESS_ROLE, owner = process.env.UNOAPI_STORAGE_WORKER_ID
let root: string, config: Config, db: SessionDatabase, sdk: ReturnType<typeof createSqliteStore>
beforeEach(async () => {
  jest.clearAllMocks()
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'projection-test'
  root = mkdtempSync(join(tmpdir(), 'uno-storage-projection-test-'))
  config = { provider: 'zapo', useRedis: true, baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'projection-test', generation: 1, state: 'active', fixture: true } } as Config
  db = openSessionDatabase(phone, config, { create: true })
  const connection = sqliteSdkConnection(db)
  await ensureSqliteMigrations(connection, ['mailbox'])
  sdk = createSqliteStore({ connection })
})
afterEach(() => {
  configs.delete(phone)
  jest.restoreAllMocks(); closeAllSessionDatabases()
  if (!root || !resolve(root).startsWith(resolve(tmpdir())) || !root.includes('uno-storage-projection-test-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
  if (role === undefined) delete process.env.UNOAPI_PROCESS_ROLE; else process.env.UNOAPI_PROCESS_ROLE = role
  if (owner === undefined) delete process.env.UNOAPI_STORAGE_WORKER_ID; else process.env.UNOAPI_STORAGE_WORKER_ID = owner
})
async function message(id = 'PROVIDER', session = phone) {
  await sdk.stores.messages(session).upsert({ id, threadJid: jid, fromMe: true, timestampMs: Date.now() - 10000, messageBytes: proto.Message.encode({ conversation: 'Synthetic body must not leave via pubsub' }).finish() })
}
const panel = (part: string) => `unoapi:zapo:panel:${phone}:${part}`
const json = (key: string) => JSON.parse(db.getValue(key)!.toString())

test.each(['migrating', 'restoring'])('status and edit projections reject %s before opening a write transaction or notifying', async state => {
  await message()
  const selected = { ...config, sessionStorage: { ...config.sessionStorage!, state: state as any } }, notify = jest.fn()
  const transaction = jest.spyOn(db, 'transaction')
  await expect(applySqliteStatuses(phone, selected, [{ id: 'PROVIDER', status: 'read' }], notify)).rejects.toThrow('operation_in_progress')
  await expect(applySqliteMessageEvent(phone, selected, ['PROVIDER'], { edited: true, text: 'late' }, notify)).rejects.toThrow('operation_in_progress')
  expect(transaction).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled()
})

test('a current generation replacement fences an older local projection without touching the historical SQLite', async () => {
  await message(); const notify = jest.fn()
  configs.set(phone, { ...config, sessionStorage: { ...config.sessionStorage!, generation: 2 } })
  await expect(applySqliteStatuses(phone, config, [{ id: 'PROVIDER', status: 'read' }], notify)).rejects.toThrow('generation_changed')
  await expect(applySqliteMessageEvent(phone, config, ['PROVIDER'], { status: 'read' }, notify)).rejects.toThrow('generation_changed')
  expect(db.getValue(panel('state:PROVIDER'))).toBeUndefined(); expect(notify).not.toHaveBeenCalled()
})

test('worker SQL status projection persists UNO outgoing and native provider overlays and publishes only metadata', async () => {
  await message(); db.putValue(`unoapi-id_rev:${phone}:UNO`, 'PROVIDER')
  const notify = jest.fn().mockResolvedValue(undefined)
  expect(await applySqliteStatuses(phone, config, [{ id: 'UNO', status: 'read' }], notify)).toEqual({ applied: 1 })
  expect(json(panel('outgoing:UNO'))).toEqual({ id: 'UNO', status: 'read' })
  expect(json(panel('state:PROVIDER'))).toEqual({ status: 'read' })
  expect(notify).toHaveBeenCalledWith({ phone, conversation_id: '', outgoing: { id: 'UNO', status: 'read' } })
  expect(notify).toHaveBeenCalledWith({ phone, conversation_id: jid, id: 'PROVIDER' })
  expect(JSON.stringify(notify.mock.calls)).not.toMatch(/Synthetic body|message_bytes|mediaKey|token/)
})

test('out-of-order status updates never downgrade read or expose an old failure error', async () => {
  await message(); db.putValue(`unoapi-id_rev:${phone}:UNO`, 'PROVIDER')
  const notify = jest.fn().mockResolvedValue(undefined)
  await applySqliteStatuses(phone, config, [{ id: 'UNO', status: 'failed' }, { id: 'UNO', status: 'sent' }, { id: 'UNO', status: 'read' }, { id: 'UNO', status: 'delivered' }, { id: 'UNO', status: 'failed' }], notify)
  expect(json(panel('outgoing:UNO'))).toEqual({ id: 'UNO', status: 'read' })
  expect(json(panel('state:PROVIDER'))).toEqual({ status: 'read' })
  expect(notify.mock.calls.at(-2)[0].outgoing).toEqual({ id: 'UNO', status: 'read' })
})

test('status changes preserve earlier absolute retention on native and outgoing records', async () => {
  await message(); db.putValue(`unoapi-id_rev:${phone}:UNO`, 'PROVIDER')
  const deadline = Date.now() + 60000
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['msg', 'PROVIDER', deadline])
  db.putValue(panel('outgoing:UNO'), JSON.stringify({ id: 'UNO', status: 'sent' }), { expiresAt: deadline })
  await applySqliteStatuses(phone, config, [{ id: 'UNO', status: 'delivered' }], async () => {})
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [panel('state:PROVIDER')])?.expires_at).toBe(deadline)
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [panel('outgoing:UNO')])?.expires_at).toBe(deadline)
})

test('expired and foreign native records cannot be revived by status or edit events', async () => {
  await message('EXPIRED'); await message('FOREIGN', '999000000000')
  db.run('INSERT INTO uno_native_expiry(domain,record_id,expires_at) VALUES(?,?,?)', ['msg', 'EXPIRED', 1])
  await applySqliteStatuses(phone, config, [{ id: 'EXPIRED', status: 'read' }, { id: 'FOREIGN', status: 'read' }], async () => {})
  expect(db.getValue(panel('state:EXPIRED'))).toBeUndefined(); expect(db.getValue(panel('state:FOREIGN'))).toBeUndefined()
  expect(await applySqliteMessageEvent(phone, config, ['EXPIRED', 'FOREIGN'], { edited: true, text: 'No' }, async () => {})).toEqual({ applied: 0 })
})

test('receipts and caption edits share SQLite overlay without downgrading status or leaking text into events', async () => {
  await message()
  const notify = jest.fn().mockResolvedValue(undefined)
  await applySqliteMessageEvent(phone, config, ['PROVIDER'], { status: 'read' }, notify)
  await applySqliteMessageEvent(phone, config, ['PROVIDER'], { status: 'delivered' }, notify)
  await applySqliteMessageEvent(phone, config, ['PROVIDER'], { edited: true, text: 'Synthetic new caption' }, notify)
  expect(json(panel('state:PROVIDER'))).toEqual({ status: 'read', edited: true, text: 'Synthetic new caption' })
  expect(JSON.stringify(notify.mock.calls)).not.toContain('Synthetic new caption')
})

test('explicit tombstones cannot be overwritten by edited addon projections', async () => {
  await message()
  db.exec('CREATE TABLE uno_native_tombstones(domain TEXT,record_id TEXT,deleted_at INTEGER)')
  db.run('INSERT INTO uno_native_tombstones VALUES(?,?,?)', ['msg', 'PROVIDER', Date.now()])
  expect(await applySqliteMessageEvent(phone, config, ['PROVIDER'], { edited: true, text: 'No' }, async () => {})).toEqual({ applied: 0 })
  expect(db.getValue(panel('state:PROVIDER'))).toBeUndefined()
})

test('projection input is bounded and invalid batches do not partially mutate storage', async () => {
  const notify = jest.fn()
  await expect(applySqliteStatuses(phone, config, [{ id: 'VALID', status: 'sent' }, { id: '../bad', status: 'read' }], notify)).rejects.toThrow('statuses_invalid')
  await expect(applySqliteStatuses(phone, config, new Array(101).fill({ id: 'VALID', status: 'sent' }), notify)).rejects.toThrow('statuses_invalid')
  await expect(applySqliteMessageEvent(phone, config, ['VALID'], { text: 'x'.repeat(16001) }, notify)).rejects.toThrow('message_event_invalid')
  expect(db.getValue(panel('outgoing:VALID'))).toBeUndefined(); expect(notify).not.toHaveBeenCalled()
})

test('broker webhook statuses and message events dispatch bounded safe projections to owning worker', async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'broker'
  jest.mocked(sessionStorageRpc).mockResolvedValue({ applied: 1 })
  await recordSessionWebhookStatuses(phone, { entry: [{ changes: [{ value: { statuses: [{ id: 'UNO', status: 'failed', errors: ['private stack'] }, { id: '../bad', status: 'read' }] } }] }] }, config)
  expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'query.statuses', [[{ id: 'UNO', status: 'failed' }]])
  await recordSessionMessageEvent(phone, { targetMessageId: 'PROVIDER', decrypted: { kind: 'message_edit', message: { documentMessage: { caption: 'Caption', mediaKey: 'secret' } } } }, 'addon', config)
  expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'query.events', [['PROVIDER'], { edited: true, text: 'Caption' }])
  expect(JSON.stringify(jest.mocked(sessionStorageRpc).mock.calls)).not.toMatch(/private stack|mediaKey|secret/)
})

test('worker hooks persist SQLite status and receipt before publishing real-time invalidations', async () => {
  await message(); db.putValue(`unoapi-id_rev:${phone}:UNO`, 'PROVIDER')
  const publish = jest.fn().mockResolvedValue(1)
  jest.spyOn(redisModule, 'getRedis').mockResolvedValue({ publish } as any)
  await recordSessionWebhookStatuses(phone, { entry: [{ changes: [{ value: { statuses: [{ id: 'UNO', status: 'delivered' }] } }] }] }, config)
  expect(json(panel('state:PROVIDER')).status).toBe('delivered')
  await recordSessionMessageEvent(phone, { messageIds: ['PROVIDER'], status: 'read' }, 'receipt', config)
  expect(json(panel('state:PROVIDER')).status).toBe('read')
  expect(sessionStorageRpc).not.toHaveBeenCalled()
  expect(publish).toHaveBeenCalledWith('unoapi:session-messages:changes', JSON.stringify({ phone, conversation_id: jid, id: 'PROVIDER' }))
  expect(JSON.stringify(publish.mock.calls)).not.toContain('Synthetic body')
})

test('broker contact gateway never opens local SQLite and uses only safe contact fields', async () => {
  process.env.UNOAPI_PROCESS_ROLE = 'broker'
  const registry = jest.spyOn(zapoStoreRegistry, 'get').mockImplementation(() => { throw new Error('must_not_open') })
  const rpc = jest.fn().mockResolvedValue({ jid, lid: jid, phoneNumber: pn, displayName: 'Public', secret: 'private', mediaKey: 'secret' })
  const contacts = sessionContacts(phone, config, rpc)
  expect(await contacts.getByJid(jid)).toEqual({ jid, lid: jid, phoneNumber: pn, displayName: 'Public' })
  expect(await contacts.getByPhoneNumber(pn)).toEqual(expect.objectContaining({ lid: jid }))
  expect(rpc).toHaveBeenCalledWith(phone, config, 'query.contact', [`${pn}@s.whatsapp.net`])
  expect(registry).not.toHaveBeenCalled()
})

test('worker contact lookup uses actual native SQL contacts without guessing a LID from PN', async () => {
  await sdk.stores.contacts(phone).upsert({ jid, lid: jid, phoneNumber: pn, displayName: 'Actual native row', lastUpdatedMs: Date.now() })
  jest.spyOn(zapoStoreRegistry, 'get').mockReturnValue({ session: () => ({ contacts: sdk.stores.contacts(phone) }) } as any)
  expect(await queryLocalSessionContact(phone, config, pn)).toEqual(expect.objectContaining({ jid, lid: jid, phoneNumber: pn }))
  expect(await queryLocalSessionContact(phone, config, '1111111111111@s.whatsapp.net')).toBeNull()
  await expect(queryLocalSessionContact(phone, config, 'status@broadcast')).rejects.toThrow('contact_identity_invalid')
})

test('contact projection refuses malformed identity and never forwards native credentials', () => {
  expect(publicSessionContact({ jid: 'bad', lid: 'bad', phoneNumber: 'not a phone', secret: 'private' })).toBeNull()
  expect(publicSessionContact({ jid: '123:4@lid', lid: '123@lid', displayName: 'x'.repeat(1000), privateKey: 'secret' })).toEqual({ jid: '123@lid', lid: '123@lid', displayName: 'x'.repeat(200) })
})
