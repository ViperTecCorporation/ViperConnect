jest.mock('../../src/services/redis')
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/zapo/zapo_store_registry', () => ({ zapoStoreRegistry: { get: jest.fn() } }))
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn() }))
import { isInBlacklistInRedis, addToBlacklistRedis, addToBlacklistInMemory, isInBlacklistInMemory, cleanBlackList, addToBlacklistJob } from '../../src/services/blacklist'
import { redisGet, blacklist, setBlacklistAliases } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { zapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'
import { amqpPublish } from '../../src/amqp'

const pn = '5566996269251'
const lid = '50113712017501@lid'
const group = '120363426717231138@g.us'
const persisted = new Map<string, string>()
const contact = { jid: lid, lid, phoneNumber: pn }
const contacts = { getByJid: jest.fn(), getByPhoneNumber: jest.fn() }
const key = (to: string, session = 'session', hook = 'type') => `unoapi-blacklist:${session}:${hook}:${to}`
const event = (value: object) => ({ entry: [{ changes: [{ value }] }] })

beforeEach(async () => {
  jest.clearAllMocks()
  await cleanBlackList()
  persisted.clear()
  ;(getConfigRedis as jest.Mock).mockResolvedValue({ provider: 'zapo' })
  ;(zapoStoreRegistry.get as jest.Mock).mockReturnValue({ session: () => ({ contacts }) })
  contacts.getByJid.mockImplementation(async (id: string) => id === lid ? contact : null)
  contacts.getByPhoneNumber.mockImplementation(async (id: string) => id === pn || id === `${pn}@s.whatsapp.net` ? contact : null)
  ;(blacklist as jest.Mock).mockImplementation((session, hook, to) => key(to, session, hook))
  ;(redisGet as jest.Mock).mockImplementation(async (name: string) => persisted.get(name) ?? null)
  ;(setBlacklistAliases as jest.Mock).mockImplementation(async (session, hook, aliases: string[], ttl) => {
    for (const alias of aliases) {
      if (ttl === 0) persisted.delete(key(alias, session, hook))
      else persisted.set(key(alias, session, hook), '1')
    }
  })
})

test.each([[lid, pn], [pn, lid]])('blocks and removes both variants %s -> %s', async (added, opposite) => {
  await addToBlacklistRedis('session', 'type', added, -1)
  for (const to of [pn, lid]) expect(await isInBlacklistInRedis('session', 'type', { to })).not.toBe('')
  await addToBlacklistRedis('session', 'type', opposite, 0)
  for (const to of [pn, lid]) expect(await isInBlacklistInRedis('session', 'type', { to })).toBe('')
  expect(persisted.size).toBe(0)
})

test.each([pn, lid, `${pn}@s.whatsapp.net`])('recognizes/removes an existing Redis key without recadastro: %s', async stored => {
  persisted.set(key(stored), '1')
  for (const to of [pn, lid]) expect(await isInBlacklistInRedis('session', 'type', { to })).not.toBe('')
  await addToBlacklistRedis('session', 'type', stored === lid ? pn : lid, 0)
  expect(persisted.size).toBe(0)
})

test('existing group key blocks the group, not its participant elsewhere', async () => {
  persisted.set(key(group), '1')
  const payload = event({ contacts: [{ wa_id: pn, user_id: lid, group_id: group }], messages: [{ from: pn }] })
  expect(await isInBlacklistInRedis('session', 'type', payload)).toBe(group)
  expect(await isInBlacklistInRedis('session', 'type', { to: pn })).toBe('')
  await addToBlacklistRedis('session', 'type', group, 0)
  expect(await isInBlacklistInRedis('session', 'type', payload)).toBe('')
  expect(await isInBlacklistInRedis('session', 'type', { to: group })).toBe('')
})

test('sees changes by other replicas and mappings learned after registration', async () => {
  contacts.getByPhoneNumber.mockResolvedValue(null)
  persisted.set(key(lid), '1')
  expect(await isInBlacklistInRedis('session', 'type', { to: pn })).toBe('')
  contacts.getByPhoneNumber.mockResolvedValue(contact)
  expect(await isInBlacklistInRedis('session', 'type', { to: pn })).toBe(lid)
  persisted.clear()
  expect(await isInBlacklistInRedis('session', 'type', { to: pn })).toBe('')
})

test('isolates session/webhook, forwards TTL and propagates Redis errors', async () => {
  await addToBlacklistRedis('session', 'type', lid, 30)
  expect(setBlacklistAliases).toHaveBeenCalledWith('session', 'type', expect.arrayContaining([pn, lid]), 30)
  expect(await isInBlacklistInRedis('other', 'type', { to: pn })).toBe('')
  expect(await isInBlacklistInRedis('session', 'other', { to: pn })).toBe('')
  ;(redisGet as jest.Mock).mockRejectedValueOnce(new Error('redis down'))
  await expect(isInBlacklistInRedis('session', 'type', { to: lid })).rejects.toThrow('redis down')
})

test('memory mode honors expiry and removal via the opposite identity', async () => {
  jest.useFakeTimers()
  try {
    await addToBlacklistInMemory('session', 'type', lid, 1)
    expect(await isInBlacklistInMemory('session', 'type', { to: pn })).not.toBe('')
    jest.advanceTimersByTime(1100)
    expect(await isInBlacklistInMemory('session', 'type', { to: pn })).toBe('')
    await addToBlacklistInMemory('session', 'type', pn, -1)
    await addToBlacklistInMemory('session', 'type', lid, 0)
    expect(await isInBlacklistInMemory('session', 'type', { to: pn })).toBe('')
  } finally { jest.useRealTimers() }
})

test('queues the original identity for broker-side resolution', async () => {
  await addToBlacklistJob('session', 'type', lid, 0)
  expect(amqpPublish).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'session',
    { from: 'session', webhookId: 'type', to: lid, ttl: 0 }, { type: 'topic' })
})

test('store failure is not mistaken for an absent mapping during removal', async () => {
  contacts.getByJid.mockRejectedValueOnce(new Error('store unavailable'))
  await expect(addToBlacklistRedis('session', 'type', lid, 0)).rejects.toThrow('store unavailable')
  expect(setBlacklistAliases).not.toHaveBeenCalled()
})

test.each(['5566996269251', '94047083475061@lid'])('legacy production-shaped entry %s blocks and removes the mapped Brazilian variant', async stored => {
  const mapping = { jid: '94047083475061@lid', phoneNumber: '556696269251@s.whatsapp.net' }
  contacts.getByJid.mockResolvedValue(mapping)
  contacts.getByPhoneNumber.mockImplementation(async pn => pn === mapping.phoneNumber ? mapping : null)
  persisted.set(key(stored), '1')
  for (const to of ['5566996269251', '94047083475061@lid']) {
    expect(await isInBlacklistInRedis('session', 'type', { to })).not.toBe('')
  }
  await addToBlacklistRedis('session', 'type', stored.includes('@lid') ? '5566996269251' : '94047083475061@lid', 0)
  expect(persisted.size).toBe(0)
})

test('LID-only public events honor the existing key without knowing its phone', async () => {
  contacts.getByJid.mockResolvedValue(null)
  persisted.set(key(lid), '1')
  expect(await isInBlacklistInRedis('session', 'type', event({ contacts: [{ user_id: lid.split('@')[0] }] }))).toBe(lid)
  await addToBlacklistRedis('session', 'type', lid, 0)
  expect(persisted.size).toBe(0)
})
