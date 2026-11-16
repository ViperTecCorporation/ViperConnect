import { MobileConnectionService } from './connection_service'
import { MobileDeviceService } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { REGISTRATION_PREFIX } from './registration_service'
import { mobilePrimaryReady, mobilePrimaryServer } from './runtime_policy'
import { primaryAuthStore } from '../session_storage/primary_state'
import { sessionStorageRpc } from '../session_storage/rpc'
import { configs } from '../config'
import { MobileDeviceError } from '../mobile_device_service'
import { activatePrimaryConnection, primaryStorageSelection } from './primary_bootstrap'
import { createProvisionPending, confirmSessionStorageProvision } from '../session_storage/provisioning'

export async function createMobileConnectionService() {
  const { getRedis, getConfig, setConfig, getSessionStatus } = module.require('../redis.js') as typeof import('../redis')
  const { getConfigRedis } = module.require('../config_redis.js') as typeof import('../config_redis')
  const { zapoStoreRegistry } = module.require('../zapo/zapo_store_registry.js') as typeof import('../zapo/zapo_store_registry')
  const { RedisLease } = module.require('../redis_lease.js') as typeof import('../redis_lease')
  const { ReloadAmqp } = module.require('../reload_amqp.js') as typeof import('../reload_amqp')
  const drafts = new MobileDeviceService()
  return new MobileConnectionService({
    enabled: mobilePrimaryReady,
    server: mobilePrimaryServer(),
    draft: id => drafts.get(id),
    registration: async id => {
      const raw = await (await getRedis()).get(REGISTRATION_PREFIX + id)
      return raw ? new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '').open(id, raw) : undefined
    },
    config: getConfig, saveConfig: setConfig,
    prepareStorage: async (phone, id, draft) => {
      let current = await getConfig(phone)
      if (current && (current.mobilePrimaryDraftId !== id || current.provider !== 'zapo' || current.server !== mobilePrimaryServer())) throw new MobileDeviceError(409, 'mobile_session_conflict')
      if (!current) {
        await setConfig(phone, { provider: 'zapo', server: mobilePrimaryServer(), name: draft.name, autoConnect: false, webhooks: [], markOnlineOnConnect: false,
          mobilePrimaryDraftId: id, sessionStorageProvisionPending: createProvisionPending(false) }, { expectedAbsent: true })
        current = await getConfig(phone)
      }
      const pending = current?.sessionStorageProvisionPending
      if (!pending?.id) throw new MobileDeviceError(409, 'session_storage_provision_unconfirmed')
      configs.delete(phone)
      const config = await getConfigRedis(phone)
      // Both intentional Redis and SQLite need the owner's durable receipt.
      // A lost RPC reply is harmless only when that exact pending ID committed.
      try { await sessionStorageRpc(phone, config, 'provision', [{ provisionId: pending.id }]) } catch { /* Confirmation below is authoritative. */ }
      await confirmSessionStorageProvision(phone, pending.id, mobilePrimaryServer())
      configs.delete(phone)
    },
    assertStorageReady: async (phone, id) => { primaryStorageSelection(await getConfig(phone), id) },
    auth: async (phone, mutation) => {
      const config = await getConfigRedis(phone)
      return primaryAuthStore(phone, config, () => zapoStoreRegistry.get(config).session(phone).auth, sessionStorageRpc, mutation)
    },
    activate: activatePrimaryConnection,
    status: getSessionStatus,
    lease: phone => new RedisLease(`zapo-session:${phone}`, 60000),
    dispatch: phone => new ReloadAmqp(getConfigRedis).run(phone),
  })
}
