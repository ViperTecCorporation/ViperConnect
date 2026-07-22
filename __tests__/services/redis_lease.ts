import { RedisLease } from '../../src/services/redis_lease'

describe('RedisLease', () => {
  test('acquires, renews and releases only its own token', async () => {
    let value = ''
    const redis = {
      set: jest.fn(async (_key, token) => {
        if (value) return null
        value = token
        return 'OK'
      }),
      eval: jest.fn(async (script, options) => {
        if (value !== options.arguments[0]) return 0
        if (script.includes('pexpire')) return 1
        value = ''
        return 1
      }),
    }
    const lease = new RedisLease('zapo:test', 60_000, async () => redis as never)
    expect(await lease.acquire()).toBe(true)
    expect(await lease.acquire()).toBe(true)
    expect(await lease.renew()).toBe(true)
    expect(await lease.release()).toBe(true)
    expect(value).toBe('')
  })

  test('does not acquire an already owned session', async () => {
    const redis = { set: jest.fn().mockResolvedValue(null) }
    const lease = new RedisLease('zapo:test', 60_000, async () => redis as never)
    await expect(lease.acquire()).resolves.toBe(false)
  })
})
