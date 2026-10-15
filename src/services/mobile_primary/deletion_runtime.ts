import { MobileDeletionService } from './deletion_service'
import { MobileDeviceService } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { REGISTRATION_PREFIX } from './registration_service'
import { UNOAPI_SERVER_NAME } from '../../defaults'

// A missing configuration must not leave an old cached QR client reconnecting.
// Atomic NX fencing prevents overwriting a concurrently registered session.
export const SUSPEND_ORPHAN_MOBILE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1`

export async function suspendOrphanMobile(redis: { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }, baseKey: string, server: string, phone: string, id: string) {
  return Number(await redis.eval(SUSPEND_ORPHAN_MOBILE, {
    keys: [`${baseKey}config:${phone}`],
    arguments: [JSON.stringify({ provider: 'zapo', server, useRedis: true,
      autoConnect: false, mobilePrimaryDraftId: id, mobilePrimaryDeleting: true })],
  })) === 1
}

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
    suspendOrphan: async (phone, id) => suspendOrphanMobile(await redis.getRedis(), redis.BASE_KEY, UNOAPI_SERVER_NAME, phone, id),
    backupCompleted: async (phone, id) => (await (await redis.getRedis()).get(`mobile-primary:{v1}:backup-completed:${phone}`)) === id,
    dispatch: phone => new ReloadAmqp(getConfigRedis).run(phone),
    eval: async (script, options) => (await redis.getRedis()).eval(script, options),
    lease: name => new RedisLease(name, 120000),
    pause: () => new Promise(resolve => setTimeout(resolve, 200)),
    clear: async (phone, config) => {
      const store = createZapoStore({ useRedis: config.useRedis, baseStore: config.baseStore, redisUrl: process.env.REDIS_URL, redisKeyPrefix: ZAPO_REDIS_KEY_PREFIX })
      try { await clearZapoSession(store.session(phone)) } finally { await store.destroy() }
      await redis.delConfig(phone, true)
      await redis.delSessionTransientKeys(phone)
      await redis.delSessionStatus(phone)
    },
  })
}
