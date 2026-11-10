jest.mock('../../src/amqp', () => ({ amqpRpc: jest.fn(), amqpConsume: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/runtime', () => ({ executeStorageOperation: jest.fn(async () => ({ accepted: true })) }))
jest.mock('../../src/services/session_storage/standalone_web_worker', () => ({ executeStandaloneWebOperation: jest.fn(async () => ({ available: true })) }))
import { amqpRpc } from '../../src/amqp'
import { getConfigRedis } from '../../src/services/config_redis'
import { executeStorageOperation } from '../../src/services/session_storage/runtime'
import { executeStandaloneWebOperation } from '../../src/services/session_storage/standalone_web_worker'
import { sessionStorageRpc, handleSessionStorageRequest } from '../../src/services/session_storage/rpc'
import { storageReadTimeout } from '../../src/services/session_storage/rpc_deadline'

const phone = '999123456789', savedEnv = { ...process.env }
beforeEach(() => { jest.clearAllMocks(); process.env.UNOAPI_STORAGE_WORKER_ID = 'owner'; jest.mocked(getConfigRedis).mockResolvedValue({ server: 'owner' } as any); jest.mocked(amqpRpc).mockResolvedValue({ value: { ok: true } }) })
afterEach(() => { process.env = { ...savedEnv } })
test('explicit read operations have bounded time and epoch deadlines; accepted mutations keep their existing timeout/semantics', async () => {
  await sessionStorageRpc(phone, { server: 'owner' } as any, 'query.contacts', [])
  const call = jest.mocked(amqpRpc).mock.calls[0], payload: any = call[3]
  expect(call[4]).toMatchObject({ timeoutMs: 15000, maxRetries: 0 }); expect(payload.deadlineAt - payload.requestedAt).toBe(15000)
  await sessionStorageRpc(phone, { server: 'owner' } as any, 'restore', [{ confirm: true }])
  expect(jest.mocked(amqpRpc).mock.calls[1][4]).not.toHaveProperty('timeoutMs'); expect(jest.mocked(amqpRpc).mock.calls[1][3]).not.toHaveProperty('deadlineAt')
  for (const operation of ['backup', 'restore-upload', 'standalone.restore', 'data.setMessage', 'query.media', 'primary.auth.save']) expect(storageReadTimeout(operation)).toBeUndefined()
})
test('transport timeout/unavailability becomes an explicit safe 503 without raw queue/credentials in the error', async () => {
  jest.mocked(amqpRpc).mockRejectedValue(new Error('timeout private://secret@host'))
  await expect(sessionStorageRpc(phone, { server: 'owner' } as any, 'query.contacts')).rejects.toMatchObject({ code: 503, title: 'session_storage_worker_unavailable' })
})
test('expired or malformed reads are rejected before config lookup or owner-side effects', async () => {
  const request = { phone, operation: 'query.contacts', generation: 0, args: [], requestedAt: Date.now() - 20000, deadlineAt: Date.now() - 5000 }
  expect(await handleSessionStorageRequest(request)).toEqual({ storageError: 'session_storage_request_expired', status: 503 })
  expect(getConfigRedis).not.toHaveBeenCalled(); expect(executeStorageOperation).not.toHaveBeenCalled()
})
test('an already accepted mutation is not silently cancelled by a client-supplied expired read deadline', async () => {
  expect(await handleSessionStorageRequest({ phone, operation: 'restore', generation: 0, args: [], requestedAt: 1, deadlineAt: 2 })).toEqual({ value: { accepted: true } })
  expect(executeStorageOperation).toHaveBeenCalledTimes(1)
})
test('standalone owner RPC does not resolve or create an absent session configuration', async () => {
  expect(await handleSessionStorageRequest({ phone, targetOwner: 'owner', operation: 'standalone.capability', generation: 0, args: [] })).toEqual({ value: { available: true } })
  expect(getConfigRedis).not.toHaveBeenCalled(); expect(executeStandaloneWebOperation).toHaveBeenCalledWith(phone, 'owner', 'standalone.capability', [])
})
