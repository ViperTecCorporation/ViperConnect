import { MobileDeviceService, MobileDeviceError } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { MobileCompanionOperations } from './companion_operations'
import { REGISTRATION_PREFIX } from './registration_service'

export async function companionOperations(id: string) {
  const { getRedis, getConfig } = await import('../redis.js')
  if (process.env.UNOAPI_MOBILE_PRIMARY_LAB !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab') throw new MobileDeviceError(404, 'mobile_feature_disabled')
  const draft = await new MobileDeviceService().get(id)
  const redis = await getRedis(), vault = new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '')
  const raw = await redis.get(REGISTRATION_PREFIX + id)
  const registration = raw ? vault.open<{ status: string; canonicalPhone: string }>(id, raw) : undefined
  if (registration?.status !== 'registered' || !/^[1-9]\d{7,14}$/.test(registration.canonicalPhone || '')) throw new MobileDeviceError(409, 'mobile_registration_required')
  const config = await getConfig(registration.canonicalPhone)
  if (config?.mobilePrimaryDraftId !== id || config.provider !== 'zapo' || config.autoConnect === false || config.mobilePrimaryDeleting || config.server !== 'mobile_lab') throw new MobileDeviceError(409, 'mobile_companion_connect_first')
  return new MobileCompanionOperations(redis, vault, draft.id)
}
