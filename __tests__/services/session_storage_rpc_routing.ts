jest.mock('../../src/amqp', () => ({ amqpRpc: jest.fn(), amqpConsume: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/runtime', () => ({ executeStorageOperation: jest.fn() }))
jest.mock('../../src/services/session_storage/data_store_sqlite', () => ({ getDataStoreSqlite: jest.fn() }))
import { proto } from 'zapo-js/proto'
import { defaultConfig } from '../../src/services/config'
import { amqpRpc } from '../../src/amqp'
import { getConfigRedis } from '../../src/services/config_redis'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { executeStorageOperation } from '../../src/services/session_storage/runtime'
import { sessionStorageRpc, handleSessionStorageRequest, remoteSessionDataStore } from '../../src/services/session_storage/rpc'
import { storageWireEncode, storageWireDecode, assertSessionEffectsAllowed, assertLocalStorageOwner } from '../../src/services/session_storage/routing'

const phone = '5566999999999'
const config = () => ({ ...defaultConfig, server: 'server_1', sessionStorage: { backend: 'sqlite' as const, storageId: '93b7b52a-64a9-4b56-b871-76adcdfac120', owner: 'worker_1', generation: 3, state: 'active' as const } })
const savedEnv = { role: process.env.UNOAPI_PROCESS_ROLE, worker: process.env.UNOAPI_STORAGE_WORKER_ID, synthetic: process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY }
beforeEach(() => { jest.clearAllMocks(); process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = 'worker_1'; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY; (getConfigRedis as jest.Mock).mockResolvedValue(config()); (getDataStoreSqlite as jest.Mock).mockResolvedValue({ loadUnoId: jest.fn().mockResolvedValue('uno') }) })
afterAll(() => { for (const [key, value] of [['UNOAPI_PROCESS_ROLE', savedEnv.role], ['UNOAPI_STORAGE_WORKER_ID', savedEnv.worker], ['UNOAPI_STORAGE_SYNTHETIC_ONLY', savedEnv.synthetic]]) if (value === undefined) delete process.env[key!]; else process.env[key!] = value })

test('wire roundtrip preserves real protobuf Long timestamps and every delivered media byte', () => {
  const original = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode({ key: { id: 'provider', remoteJid: '12345@lid', fromMe: true }, messageTimestamp: 1794150000, message: { imageMessage: { caption: 'Legenda', mediaKey: Buffer.from([255, 0, 128]), fileLength: { low: -1, high: 2097152, unsigned: true } as any } } }).finish())
  const delivered = storageWireDecode(JSON.parse(JSON.stringify(storageWireEncode(original))))
  expect(Number(delivered.messageTimestamp)).toBe(1794150000)
  expect(Buffer.from(proto.WebMessageInfo.encode(delivered).finish())).toEqual(Buffer.from(proto.WebMessageInfo.encode(original).finish()))
})
test('wire codec preserves signed 64-bit values without Number rounding', () => {
  const value: any = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode({ messageTimestamp: { low: -1, high: -1, unsigned: true } as any }).finish()).messageTimestamp
  value.unsigned = false
  const result = storageWireDecode(JSON.parse(JSON.stringify(storageWireEncode(value))))
  expect(result.toString()).toBe('-1'); expect(result.unsigned).toBe(false)
})
test('wire decoder rejects corrupt binary and 64-bit frames instead of silently truncating data', () => {
  expect(() => storageWireDecode({ __storageBytes: 'not base64!' })).toThrow('invalid_binary_frame')
  expect(() => storageWireDecode({ __storageLong: { low: 2147483648, high: 0, unsigned: true } })).toThrow('invalid_long_frame')
  let deep: any = 1; for (let i = 0; i < 35; i++) deep = [deep]
  expect(() => storageWireEncode(deep)).toThrow('payload_too_deep')
  expect(() => storageWireDecode(deep)).toThrow('payload_too_deep')
})
test('routes RPC to the persisted owner and generation without retries', async () => {
  ;(amqpRpc as jest.Mock).mockResolvedValue({ value: storageWireEncode(Buffer.from([0, 128, 255])) })
  expect(await sessionStorageRpc(phone, config(), 'data.loadUnoId', ['provider'])).toEqual(Buffer.from([0, 128, 255]))
  expect(amqpRpc).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('worker_1'), '', expect.objectContaining({ phone, generation: 3, operation: 'data.loadUnoId' }), expect.objectContaining({ maxRetries: 0 }))
})
test('worker rejects wrong owners, stale generations and unsafe operations before opening SQLite', async () => {
  const request = { phone, generation: 3, operation: 'data.loadUnoId', args: ['provider'] }
  expect(await handleSessionStorageRequest({ ...request, generation: 2 })).toMatchObject({ storageError: 'session_storage_generation_changed', status: 409 })
  ;(getConfigRedis as jest.Mock).mockResolvedValue({ ...config(), sessionStorage: { ...config().sessionStorage, owner: 'other' } })
  expect(await handleSessionStorageRequest(request)).toMatchObject({ storageError: 'session_storage_wrong_owner', status: 409 })
  ;(getConfigRedis as jest.Mock).mockResolvedValue(config())
  expect(await handleSessionStorageRequest({ ...request, operation: 'data.toJSON' })).toMatchObject({ storageError: 'session_storage_invalid_operation', status: 400 })
  expect(getDataStoreSqlite).not.toHaveBeenCalled()
})
test('worker blocks data access during migration and calls only the allowlisted session method', async () => {
  const request = { phone, generation: 3, operation: 'data.loadUnoId', args: ['provider'] }
  ;(getConfigRedis as jest.Mock).mockResolvedValue({ ...config(), sessionStorage: { ...config().sessionStorage, state: 'migrating' } })
  expect(await handleSessionStorageRequest(request)).toMatchObject({ storageError: 'session_storage_operation_in_progress', status: 409 })
  ;(getConfigRedis as jest.Mock).mockResolvedValue(config())
  expect(await handleSessionStorageRequest(request)).toEqual({ value: 'uno' })
  expect(getDataStoreSqlite).toHaveBeenCalledWith(phone, expect.objectContaining({ sessionStorage: expect.objectContaining({ owner: 'worker_1' }) }))
})
test('fixture data writes preserve protobuf bytes and timestamps at the owning-worker boundary', async () => {
  const message = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode({ key: { id: 'provider', remoteJid: '12345@lid', fromMe: true }, messageTimestamp: 1794150000, message: { documentMessage: { caption: 'Legenda', mediaKey: Buffer.from([255, 128, 0]), directPath: '/fixture' } } }).finish())
  const setMessage = jest.fn().mockResolvedValue(undefined)
  ;(getDataStoreSqlite as jest.Mock).mockResolvedValue({ setMessage })
  ;(getConfigRedis as jest.Mock).mockResolvedValue({ ...config(), sessionStorage: { ...config().sessionStorage, fixture: true } })
  const response = await handleSessionStorageRequest({ phone, generation: 3, operation: 'data.setMessage', args: storageWireEncode(['12345@lid', message]) })
  expect(response).toEqual({ value: undefined })
  const delivered = setMessage.mock.calls[0][1]
  expect(Number(delivered.messageTimestamp)).toBe(1794150000)
  expect(Buffer.from(proto.WebMessageInfo.encode(delivered).finish())).toEqual(Buffer.from(proto.WebMessageInfo.encode(message).finish()))
  expect(executeStorageOperation).not.toHaveBeenCalled()
})
test('remote DataStore never serializes a socket object or performs destructive cleanup', async () => {
  ;(amqpRpc as jest.Mock).mockResolvedValue({ value: 'cached@lid' })
  const store = remoteSessionDataStore(phone, config()), socket = { secret: 'must-not-cross-rpc' } as any
  await store.loadJid('123', socket); await store.loadImageUrl('123@lid', socket); await store.loadGroupMetada('123@g.us', socket)
  expect(JSON.stringify((amqpRpc as jest.Mock).mock.calls)).not.toContain('must-not-cross-rpc')
  await expect(store.cleanSession(true)).rejects.toThrow('cleanup_requires_owner')
})
test('fixture, synthetic-only, migrating and foreign-worker sessions cannot cause WhatsApp effects', () => {
  expect(() => assertSessionEffectsAllowed({ sessionStorage: { ...config().sessionStorage, fixture: true } })).toThrow('external_effects_forbidden')
  process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'; expect(() => assertSessionEffectsAllowed(config())).toThrow('external_effects_forbidden'); delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  expect(() => assertSessionEffectsAllowed({ sessionStorage: { ...config().sessionStorage, state: 'restoring' } })).toThrow('operation_in_progress')
  process.env.UNOAPI_PROCESS_ROLE = 'web'; expect(() => assertLocalStorageOwner(config())).toThrow('wrong_owner')
})
test('public errors do not expose exception messages, credentials or SQL', async () => {
  ;(executeStorageOperation as jest.Mock).mockRejectedValue(new Error('secret=credential; SELECT auth_credentials'))
  const response = await handleSessionStorageRequest({ phone, generation: 3, operation: 'query.contacts', args: [] })
  expect(response).toEqual({ storageError: 'session_storage_unavailable', status: 503 }); expect(JSON.stringify(response)).not.toContain('credential')
})
