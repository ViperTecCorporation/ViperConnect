import { suspendOrphanMobile, SUSPEND_ORPHAN_MOBILE } from '../../src/services/mobile_primary/deletion_runtime'

describe('orphan mobile deletion fencing', () => {
  test.each([1, 0])('creates a suspended configuration only when Redis accepts NX (%s)', async result => {
    const redis = { eval: jest.fn().mockResolvedValue(result) }
    expect(await suspendOrphanMobile(redis, 'unoapi-', 'server_1', '5566000000001', 'draft-id')).toBe(result === 1)
    const [script, options] = redis.eval.mock.calls[0]
    expect(script).toBe(SUSPEND_ORPHAN_MOBILE)
    expect(script).toContain("if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end")
    expect(options.keys).toEqual(['unoapi-config:5566000000001'])
    expect(JSON.parse(options.arguments[0])).toEqual({ provider: 'zapo', server: 'server_1', useRedis: true, autoConnect: false, mobilePrimaryDraftId: 'draft-id', mobilePrimaryDeleting: true })
  })
  test('Redis failure propagates instead of dispatching with an unfenced session', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('redis down')) }
    await expect(suspendOrphanMobile(redis, 'unoapi-', 'server_1', '5566000000001', 'draft-id')).rejects.toThrow('redis down')
  })
})
