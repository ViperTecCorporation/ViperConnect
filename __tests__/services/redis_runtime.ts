jest.mock('../../src/services/redis', () => ({
  startRedis: jest.fn().mockResolvedValue(undefined),
  getRedis: jest.fn(),
}))

import { getRedis, startRedis } from '../../src/services/redis'
import { ensureRequiredRedis, requiredRedisUrl } from '../../src/services/redis_runtime'

const getRedisMock = getRedis as jest.MockedFunction<typeof getRedis>
const startRedisMock = startRedis as jest.MockedFunction<typeof startRedis>

describe('required Redis runtime', () => {
  test('rejects startup without an explicit REDIS_URL', () => {
    expect(() => requiredRedisUrl({})).toThrow('REDIS_URL is required')
  })

  test('rejects an empty REDIS_URL', () => {
    expect(() => requiredRedisUrl({ REDIS_URL: '  ' })).toThrow('REDIS_URL is required')
  })

  test('connects and pings Redis before allowing startup', async () => {
    const ping = jest.fn().mockResolvedValue('PONG')
    getRedisMock.mockResolvedValue({ ping } as Awaited<ReturnType<typeof getRedis>>)

    await ensureRequiredRedis({ REDIS_URL: 'redis://redis:6379' })

    expect(startRedisMock).toHaveBeenCalledWith('redis://redis:6379')
    expect(getRedisMock).toHaveBeenCalledWith('redis://redis:6379')
    expect(ping).toHaveBeenCalledTimes(1)
  })

  test('propagates connection failures and blocks startup', async () => {
    startRedisMock.mockRejectedValueOnce(new Error('connection refused'))

    await expect(ensureRequiredRedis({ REDIS_URL: 'redis://redis:6379' }))
      .rejects.toThrow('connection refused')
  })
})
