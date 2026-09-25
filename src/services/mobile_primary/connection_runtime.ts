import { MobileConnectionService } from './connection_service'
import { MobileDeviceService } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { REGISTRATION_PREFIX } from './registration_service'

export async function createMobileConnectionService() {
  const { getRedis, getConfig, setConfig, getSessionStatus } = await import('../redis.js')
  const { getConfigRedis } = await import('../config_redis.js')
  const { zapoStoreRegistry } = await import('../zapo/zapo_store_registry.js')
  const { RedisLease } = await import('../redis_lease.js')
  const { ReloadAmqp } = await import('../reload_amqp.js')
  const drafts = new MobileDeviceService()
  return new MobileConnectionService({
    enabled: () => process.env.UNOAPI_MOBILE_PRIMARY_LAB === 'true' && process.env.UNOAPI_SERVER_NAME === 'mobile_lab',
    server: 'mobile_lab',
    draft: id => drafts.get(id),
    registration: async id => {
      const raw = await (await getRedis()).get(REGISTRATION_PREFIX + id)
      return raw ? new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '').open(id, raw) : undefined
    },
    config: getConfig, saveConfig: setConfig,
    auth: async phone => zapoStoreRegistry.get(await getConfigRedis(phone)).session(phone).auth,
    status: getSessionStatus,
    lease: phone => new RedisLease(`zapo-session:${phone}`, 60000),
    dispatch: phone => new ReloadAmqp(getConfigRedis).run(phone),
  })
}
