import { MobileDeviceService, MobileDeviceError } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { MobileCompanionOperations } from './companion_operations'
import { REGISTRATION_PREFIX } from './registration_service'
import { mobilePrimaryReady, mobilePrimaryServer } from './runtime_policy'
import { registrationSessionPhone } from './registration_identity'

export async function companionOperations(id: string) {
  const { getRedis, getConfig } = await import('../redis.js')
  if (!mobilePrimaryReady()) throw new MobileDeviceError(503, 'mobile_registration_key_required')
  const draft = await new MobileDeviceService().get(id)
  const redis = await getRedis(), vault = new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '')
  const raw = await redis.get(REGISTRATION_PREFIX + id)
  const registration = raw ? vault.open<{ status: string; canonicalPhone: string; sessionPhone?: string }>(id, raw) : undefined
  if (registration?.status !== 'registered' || !/^[1-9]\d{7,14}$/.test(registration.canonicalPhone || '')) throw new MobileDeviceError(409, 'mobile_registration_required')
  const config = await getConfig(registrationSessionPhone(registration, draft.phone))
  if (config?.mobilePrimaryDraftId !== id || config.provider !== 'zapo' || config.autoConnect === false || config.mobilePrimaryDeleting || config.server !== mobilePrimaryServer()) throw new MobileDeviceError(409, 'mobile_companion_connect_first')
  return new MobileCompanionOperations(redis, vault, draft.id)
}
