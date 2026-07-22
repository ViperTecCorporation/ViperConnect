import { ZapoRedisMaintenance } from '../../src/services/zapo/zapo_redis_maintenance'

describe('Zapo Redis maintenance', () => {
  test('incrementally removes expired ids from official message indexes', async () => {
    const redis = {
      scan: jest.fn().mockResolvedValue({
        cursor: '7',
        keys: ['tenant:msg:idx:5511:123@lid', 'tenant:msg:idx:5511:group@g.us'],
      }),
      zRemRangeByScore: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2),
    }
    const maintenance = new ZapoRedisMaintenance(async () => redis as never, 'tenant:', 1_000)

    await expect(maintenance.pruneMessageIndexBatch('5511', 10_000)).resolves.toEqual({
      scanned: 2,
      removed: 6,
      cursor: '7',
    })
    expect(redis.zRemRangeByScore).toHaveBeenCalledWith('tenant:msg:idx:5511:123@lid', 0, 9_000)
  })
})
