jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: jest.fn(), redisGet: jest.fn(), redisSetAndExpire: jest.fn(), redisDelKey: jest.fn(), redisScanSome: jest.fn() }))
import { getRedis, redisGet, redisSetAndExpire } from '../../src/services/redis'
import { PASSKEY_BRIDGE_CAS_LUA, updatePasskeyBridgeSession } from '../../src/services/passkey_bridge'

const session = (status = 'request', expiresAt = new Date(Date.now() + 5000).toISOString()) => ({ bridgeId: 'bridge', phone: '999123456789', status, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt })
let raw: string | undefined, beforeCompare: (() => void) | undefined
const evaluate = jest.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
  expect(script).toBe(PASSKEY_BRIDGE_CAS_LUA); expect(options.keys).toEqual(['unoapi-passkey-bridge:bridge'])
  beforeCompare?.(); beforeCompare = undefined
  if (raw !== options.arguments[0]) return 0
  if (Number(options.arguments[2]) <= Date.now()) return -1
  raw = options.arguments[1]; return 1
})
beforeEach(() => {
  jest.clearAllMocks(); raw = JSON.stringify(session()); beforeCompare = undefined
  jest.mocked(redisGet).mockImplementation(async () => raw || null)
  jest.mocked(getRedis).mockResolvedValue({ eval: evaluate } as any)
})
test('status update uses an atomic compare/set with absolute expiry, never a fresh thirty-second TTL', async () => {
  const current = JSON.parse(raw!)
  const result = await updatePasskeyBridgeSession('bridge', { status: 'response-sent', expiresAt: new Date(Date.now() + 100000).toISOString(), phone: 'foreign' })
  expect(result).toMatchObject({ phone: current.phone, expiresAt: current.expiresAt, createdAt: current.createdAt, status: 'response-sent' })
  expect(evaluate).toHaveBeenCalledWith(PASSKEY_BRIDGE_CAS_LUA, { keys: ['unoapi-passkey-bridge:bridge'], arguments: [JSON.stringify(current), raw!, String(Date.parse(current.expiresAt))] })
  expect(PASSKEY_BRIDGE_CAS_LUA).toContain("redis.call('TIME')")
  expect(PASSKEY_BRIDGE_CAS_LUA).toContain("'PXAT',ARGV[3]")
  expect(redisSetAndExpire).not.toHaveBeenCalled()
})
test.each(['completed', 'timeout', 'error'])('terminal %s bridge never regresses or renews its TTL', async status => {
  const current = session(status); raw = JSON.stringify(current)
  await expect(updatePasskeyBridgeSession('bridge', { status: 'response-sent' })).resolves.toEqual(current)
  expect(evaluate).not.toHaveBeenCalled()
})
test.each(['missing', 'expired', 'invalid'])('an %s bridge cannot be revived through status update', async reason => {
  raw = reason === 'missing' ? undefined : JSON.stringify(session('request', reason === 'invalid' ? 'invalid' : new Date(Date.now() - 1000).toISOString()))
  await expect(updatePasskeyBridgeSession('bridge', { status: 'response-sent' })).resolves.toBeUndefined()
  expect(evaluate).not.toHaveBeenCalled()
})
test.each(['completed', 'cancelled', 'expired'])('a concurrent %s between read and CAS cannot be overwritten or resurrected', async reason => {
  beforeCompare = () => { raw = reason === 'cancelled' ? undefined : JSON.stringify(session(reason === 'completed' ? 'completed' : 'request', reason === 'expired' ? new Date(Date.now() - 1).toISOString() : undefined)) }
  const result = await updatePasskeyBridgeSession('bridge', { status: 'response-sent' })
  if (reason === 'completed') { expect(result?.status).toBe('completed'); expect(JSON.parse(raw!).status).toBe('completed') }
  else expect(result).toBeUndefined()
  expect(evaluate).toHaveBeenCalledTimes(1)
})
test('three competing writes produce an explicit conflict without an unbounded retry', async () => {
  evaluate.mockImplementationOnce(async () => 0).mockImplementationOnce(async () => 0).mockImplementationOnce(async () => 0)
  await expect(updatePasskeyBridgeSession('bridge', { status: 'response-sent' })).rejects.toThrow('passkey_bridge_update_conflict')
  expect(evaluate).toHaveBeenCalledTimes(3); expect(JSON.parse(raw!).status).toBe('request')
})
