import { MobileDeletionService } from './deletion_service'
import { MobileDeviceService } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { REGISTRATION_PREFIX } from './registration_service'

export async function createMobileDeletionService() {
  const redis = await import('../redis.js')
  const { getConfigRedis } = await import('../config_redis.js')
  const { RedisLease } = await import('../redis_lease.js')
  const { ReloadAmqp } = await import('../reload_amqp.js')
  const { createZapoStore } = await import('../zapo/zapo_store.js')
  const { clearZapoSession } = await import('../zapo/zapo_session_cleanup.js')
  const { ZAPO_REDIS_KEY_PREFIX } = await import('../../defaults.js')
  return new MobileDeletionService({
    list: () => new MobileDeviceService().list(),
    registration: async id => {
      const raw = await (await redis.getRedis()).get(REGISTRATION_PREFIX + id)
      return raw ? new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '').open(id, raw) : undefined
    },
    config: redis.getConfig, saveConfig: redis.setConfig,
    dispatch: phone => new ReloadAmqp(getConfigRedis).run(phone),
    eval: async (script, options) => (await redis.getRedis()).eval(script, options),
    lease: name => new RedisLease(name, 120000),
    pause: () => new Promise(resolve => setTimeout(resolve, 200)),
    clear: async (phone, config) => {
      const store = createZapoStore({ useRedis: config.useRedis, baseStore: config.baseStore, redisUrl: process.env.REDIS_URL, redisKeyPrefix: ZAPO_REDIS_KEY_PREFIX })
      try { await clearZapoSession(store.session(phone)) } finally { await store.destroy() }
      await redis.delConfig(phone)
      await redis.delSessionTransientKeys(phone)
      await redis.delSessionStatus(phone)
    },
  })
}
