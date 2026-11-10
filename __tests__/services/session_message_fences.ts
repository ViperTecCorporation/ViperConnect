jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../src/defaults', () => ({ ZAPO_REDIS_KEY_PREFIX: 'synthetic:', UNOAPI_EXCHANGE_BROKER_NAME: 'synthetic-broker', UNOAPI_QUEUE_OUTGOING: 'synthetic-outgoing', UNOAPI_QUEUE_HISTORY_OUTGOING: 'synthetic-history' }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }))
jest.mock('../../src/services/config', () => ({ configs: new Map(), isWebhookEnabled: (hook: any) => hook.enabled !== false }))
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), providerIdKey: (phone: string, id: string) => `unoapi-id_rev:${phone}:${id}` }))
jest.mock('../../src/services/transformer', () => ({ completeCloudApiWebHook: jest.fn() }))
jest.mock('../../src/services/zapo/zapo_store_registry', () => ({ zapoStoreRegistry: { get: jest.fn() } }))
jest.mock('../../src/services/zapo/zapo_store', () => ({ resolveZapoRedisKeyPrefix: () => 'synthetic:' }))
jest.mock('../../src/services/messages/session_message_index', () => ({ sessionMessageIndex: jest.fn(), MESSAGE_CHANGE_CHANNEL: 'synthetic-changes', MERGE_MESSAGE_STATUS_LUA: 'synthetic-merge' }))
jest.mock('../../src/services/session_storage/status_projection', () => ({ applySqliteStatuses: jest.fn(), applySqliteMessageEvent: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))
jest.mock('../../src/services/session_storage/state_redis', () => ({ getSessionStateRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/write_fence', () => ({ assertFreshSqliteWriteSelection: jest.fn() }))
import { amqpPublish } from '../../src/amqp'
import logger from '../../src/services/logger'
import { getRedis } from '../../src/services/redis'
import { OutgoingAmqp } from '../../src/services/outgoing_amqp'
import { recordSessionWebhookStatuses } from '../../src/services/messages/session_message_status'
import { recordSessionMessageEvent } from '../../src/services/messages/session_message_events'
import { sessionMessageIndex } from '../../src/services/messages/session_message_index'
import { zapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { applySqliteStatuses, applySqliteMessageEvent } from '../../src/services/session_storage/status_projection'
import { rethrowSessionStateFence } from '../../src/services/session_storage/private_state'
import { SessionStorageError } from '../../src/services/session_storage/types'
import { SendError } from '../../src/services/send_error'

const phone = '999123456789', payload = { entry: [{ changes: [{ value: { statuses: [{ id: 'UNO', status: 'delivered' }] } }] }] }
const receipt = { messageIds: ['PROVIDER'], status: 'read' }
const addon = { targetMessageId: 'PROVIDER', decrypted: { kind: 'message_edit', message: { imageMessage: { caption: 'Synthetic caption' } } } }
const config: any = { provider: 'zapo', useRedis: true, webhooks: [{ id: 'fixture', enabled: true }], sessionStorage: { backend: 'sqlite', owner: 'fence_owner', generation: 1, storageId: '12345678-1234-4234-8234-123456789abc', state: 'active' } }
let oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => { oldEnvironment = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'fence_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID; jest.clearAllMocks(); jest.mocked(applySqliteStatuses).mockResolvedValue({ applied: 1 }); jest.mocked(applySqliteMessageEvent).mockResolvedValue({ applied: 1 }); jest.mocked(sessionStorageRpc).mockResolvedValue({ applied: 1 }) })
afterEach(() => { process.env = oldEnvironment })

test('recognizes typed, RPC SendError.title and prefixed fence messages without treating generic failures as storage conflicts', () => {
  for (const error of [new SessionStorageError(409, 'session_storage_operation_in_progress'), new SendError(409, 'session_storage_generation_changed'),
    new Error('409: session_storage_wrong_owner'), { title: 'session_storage_configuration_missing' }]) expect(() => rethrowSessionStateFence(error)).toThrow()
  for (const error of [undefined, null, new Error('network unavailable'), new SendError(502, 'provider_offline'), new Error('text mentions session_storage_generation_changed inside a longer message')]) expect(() => rethrowSessionStateFence(error)).not.toThrow()
})

test.each(['worker', 'broker'])('status, receipt and caption edit propagate local/RPC storage conflicts from %s without a fallback or second operation', async role => {
  process.env.UNOAPI_PROCESS_ROLE = role
  const error = role === 'worker' ? new SessionStorageError(409, 'session_storage_operation_in_progress') : new SendError(409, 'session_storage_generation_changed')
  const status = role === 'worker' ? jest.mocked(applySqliteStatuses) : jest.mocked(sessionStorageRpc)
  status.mockRejectedValueOnce(error)
  await expect(recordSessionWebhookStatuses(phone, payload, config)).rejects.toBe(error)
  const events = role === 'worker' ? jest.mocked(applySqliteMessageEvent) : jest.mocked(sessionStorageRpc)
  events.mockRejectedValueOnce(error); await expect(recordSessionMessageEvent(phone, receipt, 'receipt', config)).rejects.toBe(error)
  events.mockRejectedValueOnce(error); await expect(recordSessionMessageEvent(phone, addon, 'addon', config)).rejects.toBe(error)
  expect(logger.warn).not.toHaveBeenCalled(); expect(sessionMessageIndex).not.toHaveBeenCalled(); expect(zapoStoreRegistry.get).not.toHaveBeenCalled(); expect(getRedis).not.toHaveBeenCalled()
  if (role === 'worker') { expect(applySqliteStatuses).toHaveBeenCalledTimes(1); expect(applySqliteMessageEvent).toHaveBeenCalledTimes(2); expect(sessionStorageRpc).not.toHaveBeenCalled() }
  else { expect(sessionStorageRpc).toHaveBeenCalledTimes(3); expect(applySqliteStatuses).not.toHaveBeenCalled(); expect(applySqliteMessageEvent).not.toHaveBeenCalled() }
})

test('OutgoingAmqp does not publish a webhook before the status fence succeeds; an explicit retry publishes exactly once', async () => {
  const send = new OutgoingAmqp(jest.fn().mockResolvedValue(config)), error = new SessionStorageError(409, 'session_storage_operation_in_progress')
  jest.mocked(applySqliteStatuses).mockRejectedValueOnce(error)
  await expect(send.send(phone, payload)).rejects.toBe(error)
  expect(amqpPublish).not.toHaveBeenCalled()
  await send.send(phone, payload)
  expect(applySqliteStatuses).toHaveBeenCalledTimes(2); expect(amqpPublish).toHaveBeenCalledTimes(1)
  expect(amqpPublish).toHaveBeenCalledWith('synthetic-broker', 'synthetic-outgoing', phone, { webhooks: config.webhooks, payload, split: true }, { type: 'topic' })
  expect(getRedis).not.toHaveBeenCalled(); expect(zapoStoreRegistry.get).not.toHaveBeenCalled()
})

test('generic optional projection failures retain their previous warning behavior, while unknown events do no work', async () => {
  jest.mocked(applySqliteStatuses).mockRejectedValueOnce(Error('generic cache outage'))
  jest.mocked(applySqliteMessageEvent).mockRejectedValueOnce(Error('generic cache outage'))
  await expect(recordSessionWebhookStatuses(phone, payload, config)).resolves.toBeUndefined()
  await expect(recordSessionMessageEvent(phone, receipt, 'receipt', config)).resolves.toBeUndefined()
  expect(logger.warn).toHaveBeenCalledTimes(2)
  await recordSessionMessageEvent(phone, { messageIds: ['PROVIDER'], status: 'unknown' }, 'receipt', config)
  await recordSessionMessageEvent(phone, { decrypted: { kind: 'reaction' } }, 'addon', config)
  expect(applySqliteMessageEvent).toHaveBeenCalledTimes(1)
})

test('legacy Redis event/status hooks also propagate a recognized fence but never a generic projection error', async () => {
  const error = new SendError(409, 'session_storage_generation_changed'), state = jest.fn().mockRejectedValueOnce(error)
  const pipe: any = { eval: jest.fn().mockReturnThis(), get: jest.fn().mockReturnThis(), publish: jest.fn().mockReturnThis(), exec: jest.fn().mockRejectedValueOnce(error) }
  jest.mocked(sessionMessageIndex).mockReturnValue({ state, redis: { pipeline: () => pipe }, key: (_phone: string, key: string) => key, ttl: 1000 } as any)
  await expect(recordSessionMessageEvent(phone, receipt, 'receipt')).rejects.toBe(error)
  await expect(recordSessionWebhookStatuses(phone, payload, { provider: 'zapo', useRedis: true } as any)).rejects.toBe(error)
  expect(state).toHaveBeenCalledTimes(1); expect(pipe.exec).toHaveBeenCalledTimes(1); expect(logger.warn).not.toHaveBeenCalled()
})
