jest.mock('../../src/services/redis', () => ({
  BASE_KEY: 'unoapi-',
  getRedis: jest.fn(),
}))

import { getRedis } from '../../src/services/redis'
import { ZapoUsernameIndex } from '../../src/services/zapo/zapo_username_index'

describe('Zapo username index', () => {
  test('stores username aliases in one expiring Redis hash per session', async () => {
    const redis = {
      hSet: jest.fn().mockResolvedValue(1),
      hGet: jest.fn(),
      hDel: jest.fn().mockResolvedValue(1),
      hKeys: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(true),
      zCard: jest.fn().mockResolvedValue(0),
      zAdd: jest.fn().mockResolvedValue(1),
      zRangeByScore: jest.fn().mockResolvedValue([]),
      zRemRangeByScore: jest.fn().mockResolvedValue(0),
      zRem: jest.fn().mockResolvedValue(1),
    }
    ;(getRedis as jest.Mock).mockResolvedValue(redis)
    const index = new ZapoUsernameIndex(60)

    await index.touch('session', '@Maria', '123:4@lid')
    await expect(index.resolve('session', 'maria')).resolves.toBe('123@lid')

    expect(redis.hSet).toHaveBeenCalledWith('unoapi-zapo-username-lid:session', 'maria', '123@lid')
    expect(redis.zAdd).toHaveBeenCalledWith('unoapi-zapo-username-lid:session:seen', [{ score: expect.any(Number), value: 'maria' }])
    expect(redis.expire).toHaveBeenCalledWith('unoapi-zapo-username-lid:session', 60)

    await index.removeByLid('session', '123:8@lid')
    await expect(index.resolve('session', 'maria')).resolves.toBeUndefined()
    expect(redis.hDel).toHaveBeenCalledWith('unoapi-zapo-username-lid:session', 'maria')
  })
})
