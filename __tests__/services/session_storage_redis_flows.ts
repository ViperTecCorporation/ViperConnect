import { mockDeep } from 'jest-mock-extended'
import type { WaClient } from 'zapo-js'
import { amqpPublish } from '../../src/amqp'
import { configs, defaultConfig } from '../../src/services/config'
import { dataStores } from '../../src/services/data_store'
import { getDataStoreRedis } from '../../src/services/data_store_redis'
import { getBulkReport, getRedis } from '../../src/services/redis'
import { PRIVATE_REDIS_FENCE_LUA } from '../../src/services/session_storage/private_state'
import { SET_RETAINED_STATUS_LUA } from '../../src/services/messages/message_status_retention'
import { saveTranscriptionReference, loadTranscriptionReference, transcriptionId } from '../../src/services/transcription_reference'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { openSessionDatabase } from '../../src/services/session_storage/database'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'
import { BulkSenderJob } from '../../src/jobs/bulk_sender'
import { BulkStatusJob } from '../../src/jobs/bulk_status'

jest.mock('@redis/client', () => ({ createClient: jest.fn(() => mockRedis) }))
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined), amqpRpc: jest.fn(), amqpConsume: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
jest.mock('../../src/services/session_storage/database', () => ({ openSessionDatabase: jest.fn(() => { throw Error('unexpected_session_sqlite_open') }) }))
jest.mock('../../src/services/reply_warning_outbox', () => ({ saveReplyWarning: jest.fn(), completeReplyWarning: jest.fn() }))

const phone = '999123456789', configKey = `unoapi-config:${phone}`, participant = '12345@lid'
const values = new Map<string, string>(), sets = new Map<string, Set<string>>(), deadlines = new Map<string, number>()
let oldEnvironment: NodeJS.ProcessEnv

/** Bounded in-memory Redis port. It checks the real Lua fence/arguments before
 * applying only the GET/SET/MGET and retained-status effects used by these flows. */
const mockRedis: any = {
  connect: jest.fn(async () => undefined), on: jest.fn(), ping: jest.fn(async () => 'PONG'),
  get: jest.fn(async (key: string) => values.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, options?: { NX?: boolean; EX?: number }) => {
    if (options?.NX && values.has(key)) return null
    values.set(key, value)
    if (options?.EX) deadlines.set(key, Date.now() + options.EX * 1000); else deadlines.delete(key)
    return 'OK'
  }),
  scan: jest.fn(async () => ({ cursor: '0', keys: [] })),
  del: jest.fn(async (key: string) => Number(values.delete(key))),
  expire: jest.fn(async (key: string, seconds: number) => { deadlines.set(key, Date.now() + seconds * 1000); return 1 }),
  sAdd: jest.fn(async (key: string, member: string) => { const group = sets.get(key) || new Set<string>(), size = group.size; group.add(member); sets.set(key, group); return group.size - size }),
  sMembers: jest.fn(async (key: string) => [...sets.get(key) || []]),
  mGet: jest.fn(async (keys: string[]) => keys.map(key => values.get(key) ?? null)),
  eval: jest.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
    let keys = options.keys, args = options.arguments
    if (script.startsWith(PRIVATE_REDIS_FENCE_LUA)) {
      expect(keys.at(-1)).toBe(configKey)
      const expected = JSON.parse(args.at(-1)!), raw = values.get(configKey)
      if (!raw && expected.exists) throw Error('ERR session_storage_configuration_missing')
      const selected = raw ? JSON.parse(raw).sessionStorage : undefined
      if (selected && ['migrating', 'restoring'].includes(selected.state)) throw Error('ERR session_storage_operation_in_progress')
      if (selected?.backend && selected.backend !== 'redis' || expected.descriptor !== null) throw Error('ERR session_storage_generation_changed')
      keys = keys.slice(0, -1); args = args.slice(0, -1)
    }
    if (script.includes(SET_RETAINED_STATUS_LUA)) {
      const deadline = Math.min(Number(args[1]), ...keys.map(key => deadlines.get(key) ?? Infinity))
      if (deadline <= Number(args[0])) { values.delete(keys[0]); return 0 }
      values.set(keys[0], args[2]); deadlines.set(keys[0], deadline); return 1
    }
    if (script.includes("return redis.call('MGET'")) return keys.map(key => values.get(key) ?? null)
    if (script.includes("return redis.call('GET',KEYS[1]")) return values.get(keys[0]) ?? null
    if (script.includes("return redis.call('SET',KEYS[1]")) { values.set(keys[0], args[0]); deadlines.delete(keys[0]); return 'OK' }
    throw Error('unexpected_redis_lua_in_flow')
  }),
}

beforeEach(async () => {
  oldEnvironment = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith('SESSION_STORAGE_')) delete process.env[key]
  process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'redis_owner'
  jest.useFakeTimers(); values.clear(); sets.clear(); deadlines.clear(); jest.clearAllMocks()
  const config = { ...defaultConfig, provider: 'zapo' as const, useRedis: true, useS3: true, server: 'redis_owner' }
  expect(config.sessionStorage).toBeUndefined()
  configs.set(phone, config); values.set(configKey, JSON.stringify(config)); dataStores.delete(phone)
  await getRedis()
})

afterEach(() => {
  expect(openSessionDatabase).not.toHaveBeenCalled(); expect(sessionStorageRpc).not.toHaveBeenCalled()
  configs.delete(phone); dataStores.delete(phone); jest.clearAllTimers(); jest.useRealTimers(); process.env = oldEnvironment
})

test.each(['12345@g.us', '12345@lid'])('a valid Redis session resolves its transcription to the exact provider audio quote in %s', async conversation => {
  const local = await getDataStoreRedis(phone, configs.get(phone)!)
  const key = { id: 'provider-audio', remoteJid: conversation, fromMe: false, ...(conversation.endsWith('@g.us') ? { participant } : {}) }
  await local.setUnoId(key.id, 'uno-audio'); await local.setKey('uno-audio', key); await local.setKey(key.id, key)
  const id = transcriptionId(phone, conversation, 'uno-audio'), referenceKey = `unoapi-transcription-reference:${phone}:${id}`
  deadlines.set(referenceKey, Date.now() + 1000)
  expect(await saveTranscriptionReference(phone, conversation, 'uno-audio')).toBe(id)
  expect(JSON.parse(values.get(referenceKey)!)).toEqual({ conversation, audioId: 'uno-audio' })
  expect(deadlines.has(referenceKey)).toBe(false)
  expect(await loadTranscriptionReference(phone, id)).toBe('uno-audio')
  expect(mockRedis.eval).toHaveBeenCalledWith(expect.stringContaining(PRIVATE_REDIS_FENCE_LUA), expect.objectContaining({
    keys: [referenceKey, configKey], arguments: [JSON.stringify({ conversation, audioId: 'uno-audio' }), JSON.stringify({ exists: true, descriptor: null })],
  }))
  expect(mockRedis.set.mock.calls.some(([key]) => key === referenceKey)).toBe(false)
  const client = mockDeep<WaClient>(); client.message.send.mockResolvedValue({ id: 'reply-provider' } as never)
  const result = await new ZapoMessages(client, local, { phone }).send({ to: conversation, type: 'text', text: { body: 'Synthetic Redis reply' }, context: { message_id: id } }, { unoMessageId: 'reply-uno' })
  expect(client.message.send).toHaveBeenCalledTimes(1)
  expect(client.message.send).toHaveBeenCalledWith(conversation, { type: 'text', text: 'Synthetic Redis reply' }, expect.objectContaining({ quote: key }))
  expect(result.ok.warnings).toBeUndefined()
  expect(await local.loadProviderId('uno-audio')).toBe('provider-audio')
  expect(await local.loadUnoId('provider-audio')).toBe('uno-audio')
  expect(await local.loadProviderId('reply-uno')).toBe('reply-provider')
  expect(await local.loadKey('provider-audio')).toEqual(key)
})

test('a valid Redis session keeps actual campaign scheduling, error classification and reports in Redis without session SQLite', async () => {
  const incoming: any = { send: jest.fn().mockResolvedValue({ ok: { messages: [{ id: 'uno-campaign' }] } }) }
  const outgoing: any = { formatAndSend: jest.fn().mockResolvedValue(undefined) }
  await new BulkSenderJob(incoming, outgoing).consume(phone, { payload: { id: 'campaign-fixture', messages: [{ payload: { to: '12345', type: 'text', text: { body: 'Synthetic only' } } }], length: 1 } })
  expect(incoming.send).toHaveBeenCalledTimes(1)
  expect([...sets.get(`unoapi-bulk-index:${phone}:campaign-fixture`)!]).toEqual(['uno-campaign:12345'])
  expect(values.get(`unoapi-bulk-message:${phone}:campaign-fixture:uno-campaign:12345`)).toBe('scheduled')
  const statusKey = `unoapi-message-status:${phone}:uno-campaign`, firstDeadline = deadlines.get(statusKey)
  expect(values.get(statusKey)).toBe('scheduled'); expect(firstDeadline).toBeGreaterThan(Date.now())
  expect(await getBulkReport(phone, 'campaign-fixture')).toEqual({ report: { '12345': 'scheduled' }, status: { scheduled: 1 } })
  await new BulkStatusJob().consume(phone, { payload: { entry: [{ changes: [{ value: { statuses: [{ id: 'uno-campaign', status: 'failed', errors: [{ code: 7 }] }] } }] }] } })
  expect(values.get(statusKey)).toBe('invalid-phone-number')
  expect(await getBulkReport(phone, 'campaign-fixture')).toEqual({ report: { '12345': 'invalid-phone-number' }, status: { 'invalid-phone-number': 1 } })
  expect(deadlines.get(statusKey)).toBe(firstDeadline)
  const statusCalls = mockRedis.eval.mock.calls.filter(([script]) => script.includes(SET_RETAINED_STATUS_LUA))
  expect(statusCalls).toHaveLength(2)
  expect(statusCalls.every(([script, options]) => script.startsWith(PRIVATE_REDIS_FENCE_LUA) && options.keys.at(-1) === configKey)).toBe(true)
  expect(amqpPublish).toHaveBeenCalledTimes(1)
})
