import { StatusRecipients } from '../../src/services/status/status_recipients'

describe('Status recipient index', () => {
  test('keeps all recipients in one temporal sorted-set and prunes inactive members', async () => {
    const redis = {
      zAdd: jest.fn().mockResolvedValue(2),
      zRemRangeByScore: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      zRange: jest.fn().mockResolvedValue(['5511999999999@s.whatsapp.net']),
    }
    const registry = new StatusRecipients(async () => redis as never, 60)

    await registry.touch('session', ['5511999999999', '5511999999999@s.whatsapp.net'], 100_000)
    await expect(registry.load('session', 100_000)).resolves.toEqual(['5511999999999@s.whatsapp.net'])

    expect(redis.zAdd).toHaveBeenCalledWith('unoapi-status-recipients:session', [
      { score: 100_000, value: '5511999999999@s.whatsapp.net' },
    ])
    expect(redis.zRemRangeByScore).toHaveBeenCalledWith('unoapi-status-recipients:session', 0, 40_000)
  })

  test('bootstraps the compact index and expires old per-contact keys', async () => {
    const transaction = { expire: jest.fn(), exec: jest.fn().mockResolvedValue([]) }
    transaction.expire.mockReturnValue(transaction)
    const redis = {
      zAdd: jest.fn().mockResolvedValue(1),
      zRemRangeByScore: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(true),
      zRange: jest.fn().mockResolvedValue([]),
      scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [
        'unoapi-contact-info:session:5511888888888@s.whatsapp.net',
        'unoapi-contact-info:session:123@lid',
      ] }),
      multi: jest.fn(() => transaction),
    }
    const registry = new StatusRecipients(async () => redis as never, 300)

    await expect(registry.loadOrBootstrap('session', 1_000)).resolves.toEqual([
      '5511888888888@s.whatsapp.net',
    ])
    expect(transaction.expire).toHaveBeenCalledTimes(2)
    expect(redis.zAdd).toHaveBeenCalledTimes(1)
  })
})
