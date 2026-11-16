jest.mock('../../src/amqp', () => ({ amqpRpc: jest.fn(), amqpConsume: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/passkey_bridge', () => ({ getPasskeyBridgeSession: jest.fn(), updatePasskeyBridgeSession: jest.fn() }))
import { amqpRpc } from '../../src/amqp'
import { clients } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import { getConfigRedis } from '../../src/services/config_redis'
import { getPasskeyBridgeSession, updatePasskeyBridgeSession } from '../../src/services/passkey_bridge'
import { executePasskeyBridgeOperation } from '../../src/services/passkey_bridge_operation'
import { handleSessionStorageRequest, sessionStorageRpc } from '../../src/services/session_storage/rpc'

const phone = '999123456789', bridgeId = 'bridge-fixture', owner = 'owner_fixture'
let config: any, bridge: any, client: any, oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  oldEnvironment = { ...process.env }; process.env.UNOAPI_SERVER_NAME = owner; process.env.UNOAPI_PROCESS_ROLE = 'worker'
  delete process.env.UNOAPI_STORAGE_WORKER_ID; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  clients.clear(); jest.resetAllMocks()
  config = { ...defaultConfig, provider: 'zapo', server: owner, autoConnect: true }
  bridge = { phone, bridgeId, status: 'request', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }
  client = { sendPasskeyResponse: jest.fn().mockResolvedValue({ ok: { success: true, bridge_id: bridgeId } }), sendPasskeyConfirmation: jest.fn().mockResolvedValue({ ok: { success: true, provider_managed_confirmation: true, bridge_id: bridgeId } }) }
  jest.mocked(getConfigRedis).mockImplementation(async () => config)
  jest.mocked(getPasskeyBridgeSession).mockImplementation(async () => bridge)
  jest.mocked(updatePasskeyBridgeSession).mockImplementation(async (_id, patch) => { bridge = { ...bridge, ...patch }; return bridge })
})
afterEach(() => { clients.clear(); process.env = oldEnvironment })

test.each(['redis', 'sqlite'])('web assertion reaches only the existing %s owner client and preserves binary payload and bridge identity', async backend => {
  if (backend === 'sqlite') config.sessionStorage = { backend, owner, generation: 7, state: 'active', storageId: '12345678-1234-4234-8234-123456789abc' }
  process.env.UNOAPI_SERVER_NAME = 'web_process'; process.env.UNOAPI_PROCESS_ROLE = 'web'
  jest.mocked(amqpRpc).mockImplementation(async (_exchange, queue, _key, request: any, options) => {
    expect(queue).toContain(`.session-storage.${owner}`); expect(options).toMatchObject({ maxRetries: 0 })
    expect(request.generation).toBe(backend === 'sqlite' ? 7 : 0); expect(clients.has(phone)).toBe(false)
    process.env.UNOAPI_SERVER_NAME = owner; process.env.UNOAPI_PROCESS_ROLE = 'worker'; clients.set(phone, client)
    try { return await handleSessionStorageRequest(request) }
    finally { clients.clear(); process.env.UNOAPI_SERVER_NAME = 'web_process'; process.env.UNOAPI_PROCESS_ROLE = 'web' }
  })
  const payload = { credentialId: Buffer.from([0, 128, 255]), assertionJson: '{"authenticatorData":"synthetic"}' }
  await expect(sessionStorageRpc(phone, config, 'passkey.assertion', [bridgeId, payload])).resolves.toEqual({ bridgeId, status: 'response-sent' })
  expect(client.sendPasskeyResponse).toHaveBeenCalledWith(payload, bridgeId)
  expect(clients.has(phone)).toBe(false); expect(bridge.status).toBe('response-sent')
})

test('owner confirmation does not mark provider-managed Zapo auth completed', async () => {
  clients.set(phone, client); bridge.status = 'response-sent'
  await expect(executePasskeyBridgeOperation(phone, config, 'confirm', bridgeId)).resolves.toEqual({ bridgeId, status: 'response-sent', providerManagedConfirmation: true })
  expect(client.sendPasskeyConfirmation).toHaveBeenCalledWith(bridgeId)
  expect(updatePasskeyBridgeSession).not.toHaveBeenCalled(); expect(bridge.status).toBe('response-sent')
})

test.each(['missing-bridge', 'different-bridge', 'missing-result'])('provider-managed confirmation without matching ownership is not success: %s', async reason => {
  clients.set(phone, client); bridge.status = 'response-sent'
  client.sendPasskeyConfirmation.mockResolvedValue(reason === 'missing-result' ? undefined : { ok: { success: true, provider_managed_confirmation: true, ...(reason === 'different-bridge' ? { bridge_id: 'other' } : {}) } })
  await expect(executePasskeyBridgeOperation(phone, config, 'confirm', bridgeId)).rejects.toThrow('result_unconfirmed')
  expect(updatePasskeyBridgeSession).not.toHaveBeenCalled()
})

test.each(['cancelled', 'expired', 'different-phone'])('a bridge changed during confirmation cannot produce stale success: %s', async reason => {
  clients.set(phone, client); bridge.status = 'response-sent'
  client.sendPasskeyConfirmation.mockImplementation(async () => {
    bridge = reason === 'cancelled' ? undefined : { ...bridge, ...(reason === 'expired' ? { expiresAt: new Date(Date.now() - 1).toISOString() } : { phone: '999123456788' }) }
    return { ok: { success: true, provider_managed_confirmation: true, bridge_id: bridgeId } }
  })
  await expect(executePasskeyBridgeOperation(phone, config, 'confirm', bridgeId)).rejects.toThrow('result_unconfirmed')
})

test.each(['foreign-phone', 'expired', 'no-client', 'suspended', 'deleting', 'wrong-owner', 'transition', 'fixture', 'already-sent'])('unsafe assertion never resolves the signer or creates a replacement client: %s', async reason => {
  clients.set(phone, client)
  if (reason === 'foreign-phone') bridge.phone = '999123456788'
  if (reason === 'expired') bridge.expiresAt = new Date(Date.now() - 1).toISOString()
  if (reason === 'no-client') clients.clear()
  if (reason === 'suspended') config.autoConnect = false
  if (reason === 'deleting') config.mobilePrimaryDeleting = true
  if (reason === 'wrong-owner') config.server = 'other_owner'
  if (reason === 'transition' || reason === 'fixture') config.sessionStorage = { backend: 'sqlite', owner, state: reason === 'transition' ? 'migrating' : 'active', fixture: reason === 'fixture' }
  if (reason === 'already-sent') bridge.status = 'response-sent'
  await expect(executePasskeyBridgeOperation(phone, config, 'assertion', bridgeId, { credentialId: Buffer.from([1]), assertionJson: '{}' })).rejects.toThrow()
  expect(client.sendPasskeyResponse).not.toHaveBeenCalled(); expect(updatePasskeyBridgeSession).not.toHaveBeenCalled()
})

test.each(['missing', 'wrong-bridge', 'failure'])('unconfirmed provider output cannot produce assertion success: %s', async reason => {
  clients.set(phone, client)
  client.sendPasskeyResponse.mockResolvedValue(reason === 'missing' ? undefined : { ok: { success: reason !== 'failure', bridge_id: reason === 'wrong-bridge' ? 'other' : bridgeId } })
  await expect(executePasskeyBridgeOperation(phone, config, 'assertion', bridgeId, { credentialId: Buffer.from([1]), assertionJson: '{}' })).rejects.toThrow('result_unconfirmed')
  expect(updatePasskeyBridgeSession).not.toHaveBeenCalled()
})

test('generation mismatch is rejected by the owner RPC before a passkey method is invoked', async () => {
  clients.set(phone, client)
  config.sessionStorage = { backend: 'sqlite', owner, generation: 4, state: 'active' }
  const result = await handleSessionStorageRequest({ phone, operation: 'passkey.confirm', generation: 3, args: [bridgeId] })
  expect(result).toEqual({ storageError: 'session_storage_generation_changed', status: 409 })
  expect(client.sendPasskeyConfirmation).not.toHaveBeenCalled()
})
