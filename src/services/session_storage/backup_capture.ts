import { isDeepStrictEqual } from 'node:util'
import type { Config } from '../config'
import { SessionStorageError, type SessionStorageRedis } from './types'

export interface CapturedBackupState {
  configuration: Record<string, any>; primary?: Record<string, any>
  unchanged(): Promise<boolean>
}
interface CaptureRedis extends SessionStorageRedis { hGet(key: string, field: string): Promise<string | undefined | null> }

/** Double-read control-plane state around the SQLite snapshot. Changes abort before upload. */
export async function captureBackupState(phone: string, config: Config, redis: CaptureRedis, registrationKey: string): Promise<CapturedBackupState> {
  const configKey = `unoapi-config:${phone}`, raw = await redis.get(configKey)
  if (!raw) throw new SessionStorageError(409, 'session_storage_backup_configuration_required')
  const configuration = JSON.parse(raw)
  if (!isDeepStrictEqual(configuration.sessionStorage, config.sessionStorage) || configuration.provider !== 'zapo'
    || (configuration.mobilePrimaryDraftId || '') !== (config.mobilePrimaryDraftId || '')) throw new SessionStorageError(409, 'session_storage_generation_changed')
  const controls = new Map<string, string | null>([[configKey, raw]])
  let primary: Record<string, any> | undefined, draftRaw: string | undefined | null
  if (config.mobilePrimaryDraftId) {
    const { RegistrationVault } = await import('../mobile_primary/registration_vault.js')
    const { REGISTRATION_PREFIX } = await import('../mobile_primary/registration_service.js')
    const { backupRegistration } = await import('../mobile_primary/backup_manifest.js')
    const vault = new RegistrationVault(registrationKey), registrationId = REGISTRATION_PREFIX + config.mobilePrimaryDraftId
    const registration = await redis.get(registrationId)
    if (!registration) throw new SessionStorageError(409, 'session_storage_mobile_registration_required')
    controls.set(registrationId, registration)
    const epochKey = `mobile-primary:{v1}:companions:${config.mobilePrimaryDraftId}`, epoch = await redis.get(epochKey)
    controls.set(epochKey, epoch)
    draftRaw = await redis.hGet('mobile-primary:{v1}:drafts', phone)
    if (!draftRaw) throw new SessionStorageError(409, 'session_storage_mobile_draft_required')
    const draft = JSON.parse(draftRaw)
    if (draft.id !== config.mobilePrimaryDraftId || draft.phone !== phone) throw new SessionStorageError(409, 'session_storage_mobile_draft_required')
    primary = { draftId: config.mobilePrimaryDraftId, registration: backupRegistration(vault.open(config.mobilePrimaryDraftId, registration)),
      ...(epoch ? { companionEpoch: vault.open(epochKey, epoch) } : {}), phone, draft }
  }
  return { configuration, primary, unchanged: async () => {
    for (const [key, value] of controls) if (await redis.get(key) !== value) return false
    return !config.mobilePrimaryDraftId || (await redis.hGet('mobile-primary:{v1}:drafts', phone) || null) === (draftRaw || null)
  } }
}

export function backupPrimaryIdentity(primary: Record<string, unknown> | undefined) {
  // Match the encrypted JSON wire representation: optional undefined fields in
  // a freshly sanitized registration are absent after archive serialization.
  return primary && JSON.parse(JSON.stringify(Object.fromEntries(['draftId', 'registration', 'companionEpoch', 'phone'].filter(key => primary[key] !== undefined).map(key => [key, primary[key]]))))
}
