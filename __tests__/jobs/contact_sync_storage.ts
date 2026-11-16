jest.mock('../../src/defaults', () => ({ ...jest.requireActual('../../src/defaults'), CONTACT_SYNC_ENABLED: true, CONTACT_SYNC_INTERVAL_MS: 28800000 }))
jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: jest.fn(), getSessionPhones: jest.fn(), redisGet: jest.fn(), redisSetAndExpire: jest.fn(), redisSetIfNotExists: jest.fn(), delContactSyncPending: jest.fn() }))
import { ContactSyncJob } from '../../src/jobs/contact_sync'
import { defaultConfig, configs } from '../../src/services/config'
import { getRedis, redisGet, redisSetAndExpire, redisSetIfNotExists, delContactSyncPending } from '../../src/services/redis'
import { sessionContacts } from '../../src/services/session_storage/contacts_gateway'
import { markSessionConfigRegistration } from '../../src/services/session_storage/connection_registration'

const phone = '999123456789', other = '999123456788', contact = '999123456787'
const storage = { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'owner_fixture', generation: 2, state: 'offline' }
const saved = { redis: process.env.REDIS_URL, role: process.env.UNOAPI_PROCESS_ROLE, synthetic: process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY }
const config = (sessionStorage: any = storage) => ({ ...defaultConfig, provider: 'zapo', server: 'owner_fixture', sessionStorage })
beforeEach(() => {
  jest.clearAllMocks(); configs.clear(); process.env.REDIS_URL = 'redis://example.invalid'; process.env.UNOAPI_PROCESS_ROLE = 'web'; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  ;(redisGet as jest.Mock).mockResolvedValue(null); (redisSetIfNotExists as jest.Mock).mockResolvedValue(true)
})
afterAll(() => {
  configs.clear()
  for (const [key, value] of Object.entries({ REDIS_URL: saved.redis, UNOAPI_PROCESS_ROLE: saved.role, UNOAPI_STORAGE_SYNTHETIC_ONLY: saved.synthetic })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})
const read = (value: any = config()) => jest.fn(async () => value)
const items = (pn: string, name: string, username?: string) => ({ jid: `${pn}@s.whatsapp.net`, pn, name, username })

test('web periodic synchronization discovers SQLite in the catalog and requests owner pages, not Redis data or a local SDK', async () => {
  const send = jest.fn(), rpc = jest.fn().mockResolvedValueOnce({ contacts: [items(contact, 'Shadow')], has_more: true, next_cursor: 'page-2' })
    .mockResolvedValueOnce({ contacts: [items(contact, '', 'known.user'), items(other, 'Native')], has_more: false, next_cursor: null })
  const gateway = (p: string, c: any) => sessionContacts(p, c, rpc as any)
  const job = new ContactSyncJob({ send } as any, read() as any, async () => [phone], gateway)
  await job.run()
  expect(getRedis).not.toHaveBeenCalled()
  expect(rpc).toHaveBeenCalledTimes(2)
  expect(rpc).toHaveBeenNthCalledWith(1, phone, expect.objectContaining({ sessionStorage: storage }), 'query.contact-sync', [{ limit: 100 }])
  expect(rpc).toHaveBeenNthCalledWith(2, phone, expect.anything(), 'query.contact-sync', [{ cursor: 'page-2', limit: 100 }])
  expect(send).toHaveBeenCalledTimes(1)
  const delivered = send.mock.calls[0][1].entry[0].changes[0].value
  expect(delivered.contacts).toEqual([{ wa_id: contact, profile: { name: 'Shadow', phone: contact, username: 'known.user' } }, { wa_id: other, profile: { name: 'Native', phone: other } }])
  expect(delivered.messages[0].text.body).toBe('contacts.update')
  expect(redisSetAndExpire).toHaveBeenCalledWith(`unoapi-contact-sync:schedule:${phone}`, expect.any(String), expect.any(Number))
})

test('pending and periodic work share the per-session lock and honor the existing scheduling deadline', async () => {
  const send = jest.fn(), syncPage = jest.fn().mockResolvedValue({ contacts: [items(contact, 'Contact')], has_more: false, next_cursor: null })
  const held = new Set<string>()
  ;(redisSetIfNotExists as jest.Mock).mockImplementation(async key => { if (held.has(key)) return false; held.add(key); return true })
  const job = new ContactSyncJob({ send } as any, read() as any, async () => [phone], (() => ({ syncPage })) as any)
  await Promise.all([job.run(), job.runForPhone(phone)])
  expect(send).toHaveBeenCalledTimes(1)
  expect(syncPage).toHaveBeenCalledTimes(1)
  ;(redisGet as jest.Mock).mockResolvedValue('existing-schedule')
  await expect(job.runForPhone(phone)).resolves.toBe(false)
  expect(send).toHaveBeenCalledTimes(1)
})

test('pending discovery scans shared control markers only and removes one marker after confirmed synchronization', async () => {
  const client = { scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [`unoapi-contact-sync:pending:${phone}`] }) }
  ;(getRedis as jest.Mock).mockResolvedValue(client)
  const send = jest.fn(), syncPage = jest.fn().mockResolvedValue({ contacts: [items(contact, 'Contact')], has_more: false, next_cursor: null })
  await new ContactSyncJob({ send } as any, read() as any, async () => [phone], (() => ({ syncPage })) as any).runPending()
  expect(client.scan).toHaveBeenCalledWith('0', { MATCH: 'unoapi-contact-sync:pending:*', COUNT: expect.any(Number) })
  expect(delContactSyncPending).toHaveBeenCalledWith(phone)
  expect(send).toHaveBeenCalledTimes(1)
})

test('legacy Redis source remains scoped to the session and preserves username resolution and deduplication', async () => {
  const client = { hGetAll: jest.fn().mockResolvedValue({ 'lid:123456789@lid': 'indexed.user' }), scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [`unoapi-contact-info:${phone}:${contact}@s.whatsapp.net`, `unoapi-contact-info:${other}:${other}@s.whatsapp.net`] }), mGet: jest.fn().mockResolvedValue([JSON.stringify({ name: 'Legacy', pn: contact, lidJid: '123456789@lid' }), JSON.stringify({ name: 'Foreign', pn: other })]) }
  ;(getRedis as jest.Mock).mockResolvedValue(client)
  const send = jest.fn(), gateway = jest.fn()
  await new ContactSyncJob({ send } as any, read({ ...config(), sessionStorage: undefined }) as any, async () => [phone], gateway).runForPhone(phone)
  expect(gateway).not.toHaveBeenCalled()
  expect(client.scan).toHaveBeenCalledWith('0', { MATCH: `unoapi-contact-info:${phone}:*`, COUNT: expect.any(Number) })
  expect(send.mock.calls[0][1].entry[0].changes[0].value.contacts).toEqual([{ wa_id: contact, profile: { name: 'Legacy', phone: contact, username: 'indexed.user' } }])
})

test.each(['fixture', 'synthetic', 'migrating', 'restoring'])('%s session produces no contact publication or data access', async mode => {
  if (mode === 'synthetic') process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'
  const selected = mode === 'fixture' ? { ...storage, fixture: true } : mode === 'migrating' || mode === 'restoring' ? { ...storage, state: mode } : storage
  const send = jest.fn(), gateway = jest.fn()
  await expect(new ContactSyncJob({ send } as any, read(config(selected)) as any, async () => [phone], gateway).runForPhone(phone)).rejects.toThrow(/session_storage_/)
  expect(send).not.toHaveBeenCalled(); expect(getRedis).not.toHaveBeenCalled(); expect(gateway).not.toHaveBeenCalled()
  expect(redisSetAndExpire).not.toHaveBeenCalled()
})

test('owner failure or repeated page cursor never marks schedule success or falls back to Redis', async () => {
  const send = jest.fn(), syncPage = jest.fn().mockResolvedValue({ contacts: [items(contact, 'Contact')], has_more: true, next_cursor: 'same-page' })
  await expect(new ContactSyncJob({ send } as any, read() as any, async () => [phone], (() => ({ syncPage })) as any).runForPhone(phone)).rejects.toThrow('contact_sync_page_invalid')
  expect(syncPage).toHaveBeenCalledTimes(2)
  expect(send).not.toHaveBeenCalled(); expect(getRedis).not.toHaveBeenCalled(); expect(redisSetAndExpire).not.toHaveBeenCalled()
})

test('generation changing after contact retrieval prevents webhook publication and success marker', async () => {
  let selected = storage
  const send = jest.fn(), syncPage = jest.fn(async () => { selected = { ...storage, generation: 3 }; return { contacts: [items(contact, 'Contact')], has_more: false, next_cursor: null } })
  await expect(new ContactSyncJob({ send } as any, (() => Promise.resolve(config(selected))) as any, async () => [phone], (() => ({ syncPage })) as any).runForPhone(phone)).rejects.toThrow('session_storage_generation_changed')
  expect(send).not.toHaveBeenCalled(); expect(redisSetAndExpire).not.toHaveBeenCalled()
})

test('pending marker after configuration removal cannot republish old data through ENV defaults', async () => {
  const fallback = { ...config(), useRedis: true }
  markSessionConfigRegistration(fallback as any, false)
  const send = jest.fn(), gateway = jest.fn()
  await expect(new ContactSyncJob({ send } as any, read(fallback) as any, async () => [], gateway).runForPhone(phone)).rejects.toThrow('registration_required')
  expect(send).not.toHaveBeenCalled(); expect(getRedis).not.toHaveBeenCalled(); expect(gateway).not.toHaveBeenCalled()
})
