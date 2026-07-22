import { mockDeep } from 'jest-mock-extended'
import type { RedisClientType } from 'redis'
import { ProfilePictureWebhookMarker } from '../../src/services/profile_picture_webhook_marker'

describe('ProfilePictureWebhookMarker', () => {
  const phone = '5566999999999'
  const lid = '190280070385782@lid'
  let redis: ReturnType<typeof mockDeep<RedisClientType>>

  beforeEach(() => {
    redis = mockDeep<RedisClientType>()
  })

  test('allows the first populated webhook and persists one ZSET member per identity', async () => {
    redis.zScore.mockResolvedValue(null)
    const marker = new ProfilePictureWebhookMarker({
      useRedis: true,
      intervalSeconds: 10_800,
      redisFactory: async () => redis,
    })

    await expect(marker.isDue(phone, lid, 20_000)).resolves.toBe(true)
    await marker.markSent(phone, lid, 20_000)

    expect(redis.zAdd).toHaveBeenCalledWith(
      expect.stringContaining(`profile-picture-webhook:${phone}`),
      [{ score: 20_000, value: lid }],
    )
    expect(redis.expire).toHaveBeenCalled()
  })

  test('suppresses the picture until the three-hour interval expires', async () => {
    redis.zScore.mockResolvedValue(1_000)
    const marker = new ProfilePictureWebhookMarker({
      useRedis: true,
      intervalSeconds: 10_800,
      redisFactory: async () => redis,
    })

    await expect(marker.isDue(phone, lid, 10_800_000)).resolves.toBe(false)
    await expect(marker.isDue(phone, lid, 10_802_000)).resolves.toBe(true)
  })

  test('invalidates the marker when the provider reports a picture change', async () => {
    const marker = new ProfilePictureWebhookMarker({
      useRedis: true,
      redisFactory: async () => redis,
    })

    await marker.invalidate(phone, '190280070385782:35@lid')

    expect(redis.zRem).toHaveBeenCalledWith(
      expect.stringContaining(`profile-picture-webhook:${phone}`),
      lid,
    )
  })

  test('falls back to memory when Redis is disabled', async () => {
    const marker = new ProfilePictureWebhookMarker({ useRedis: false, intervalSeconds: 10_800 })

    await expect(marker.isDue(phone, lid, 1_000)).resolves.toBe(true)
    await marker.markSent(phone, lid, 1_000)
    await expect(marker.isDue(phone, lid, 2_000)).resolves.toBe(false)
    await marker.invalidate(phone, lid)
    await expect(marker.isDue(phone, lid, 2_000)).resolves.toBe(true)
  })

  test('interval zero keeps compatibility with always-populated webhooks', async () => {
    const marker = new ProfilePictureWebhookMarker({ useRedis: false, intervalSeconds: 0 })

    await marker.markSent(phone, lid, 1_000)

    await expect(marker.isDue(phone, lid, 1_001)).resolves.toBe(true)
  })
})
