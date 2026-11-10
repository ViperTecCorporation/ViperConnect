import type { MobileDeviceDraft } from '../mobile_device_service'
import { MobileDeviceError } from '../mobile_device_service'
import { registrationSessionPhone } from './registration_identity'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export interface PrimaryStorageSelection { backend: 'redis' | 'sqlite'; owner: string; generation: number; storageId?: string; provisionId?: string }
export interface PrimaryAuthMutation { draftId: string; fence: { key: string; token: string }; selection: PrimaryStorageSelection }
export interface PrimaryActivation { config: any; draft: MobileDeviceDraft; registration: any }

/** Signed prekeys rotate; stable identity material must never be overwritten on retry. */
export function samePrimaryAuthIdentity(a: any, b: any): boolean {
  const equalBytes = (left: unknown, right: unknown) => left === undefined && right === undefined
    || left instanceof Uint8Array && right instanceof Uint8Array && Buffer.from(left).equals(Buffer.from(right))
  return a?.meJid === b?.meJid && a?.deviceInfo?.os === b?.deviceInfo?.os && a?.deviceInfo?.business === b?.deviceInfo?.business
    && a?.registrationInfo?.registrationId === b?.registrationInfo?.registrationId
    && equalBytes(a?.noiseKeyPair?.pubKey, b?.noiseKeyPair?.pubKey) && equalBytes(a?.noiseKeyPair?.privKey, b?.noiseKeyPair?.privKey)
    && equalBytes(a?.registrationInfo?.identityKeyPair?.pubKey, b?.registrationInfo?.identityKeyPair?.pubKey)
    && equalBytes(a?.registrationInfo?.identityKeyPair?.privKey, b?.registrationInfo?.identityKeyPair?.privKey)
    && equalBytes(a?.advSecretKey, b?.advSecretKey)
}

/** No descriptor is legacy Redis only when it was already imported, never an uncertain new bootstrap. */
export function primaryStorageSelection(config: any, draftId: string): PrimaryStorageSelection {
  if (!config || config.provider !== 'zapo' || config.mobilePrimaryDraftId !== draftId || config.mobilePrimaryDeleting
    || typeof config.server !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(config.server)) throw new MobileDeviceError(409, 'mobile_session_conflict')
  if (config.sessionStorageProvisionPending) throw new MobileDeviceError(409, 'session_storage_provision_unconfirmed')
  const storage = config.sessionStorage, receipt = config.sessionStorageProvisioned
  if (storage && (!['redis', 'sqlite'].includes(storage.backend) || !['active', 'offline'].includes(storage.state)
    || storage.owner !== config.server || !UUID.test(storage.storageId || '') || !Number.isSafeInteger(storage.generation) || storage.generation < 1)) throw new MobileDeviceError(409, 'mobile_storage_selection_invalid')
  const selected: PrimaryStorageSelection = { backend: storage?.backend || 'redis', owner: config.server, generation: storage?.generation || 0,
    ...(storage ? { storageId: storage.storageId } : {}) }
  // A receipt confirms the initial bootstrap only. Later migration/restore may
  // legitimately replace its storage UUID/generation; an already imported
  // Primary must follow the current validated descriptor, not that old receipt.
  if (receipt && config.mobilePrimaryImported !== true) {
    if (!UUID.test(receipt.id || '') || receipt.backend !== selected.backend || receipt.owner !== selected.owner
      || receipt.generation !== selected.generation || receipt.storageId !== selected.storageId) throw new MobileDeviceError(409, 'session_storage_provision_unconfirmed')
    selected.provisionId = receipt.id
  } else if (!storage && config.mobilePrimaryImported !== true) throw new MobileDeviceError(409, 'mobile_storage_selection_required')
  return selected
}

export function primarySourceIdentity(draft: MobileDeviceDraft, registration: any): string {
  const store = registration?.store
  return JSON.stringify([draft.id, draft.phone, draft.platform, draft.accountType, registration?.status,
    registration?.canonicalPhone, registrationSessionPhone(registration, draft.phone), registration?.advSecret,
    store?.registrationId, store?.noiseKeyPair, store?.identityKeyPair, store?.signedPreKey, store?.device])
}

export const ACTIVATE_PRIMARY_LUA = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] or redis.call('HGET',KEYS[3],ARGV[3])~=ARGV[4] or redis.call('GET',KEYS[4])~=ARGV[5] then return 0 end
redis.call('SET',KEYS[1],ARGV[6]); redis.call('PUBLISH','unoapi-config:update',ARGV[7]); return 1`

/** The final enable is one CAS over configuration, socket ownership, draft and registered identity. */
export async function activatePrimaryConnection(phone: string, expected: PrimaryActivation, fence: PrimaryAuthMutation['fence']) {
  if (fence.key !== `unoapi-lease:zapo-session:${phone}` || !UUID.test(fence.token)) throw new MobileDeviceError(409, 'mobile_session_in_use')
  const { getRedis } = module.require('../redis') as typeof import('../redis')
  const { RegistrationVault } = module.require('./registration_vault') as typeof import('./registration_vault')
  const redis = await getRedis(), configKey = `unoapi-config:${phone}`, raw = await redis.get(configKey), config = raw && JSON.parse(raw)
  const selected = primaryStorageSelection(config, expected.draft.id), before = primaryStorageSelection(expected.config, expected.draft.id)
  if (JSON.stringify(selected) !== JSON.stringify(before)) throw new MobileDeviceError(409, 'mobile_storage_selection_invalid')
  const draftRaw = await redis.hGet('mobile-primary:{v1}:drafts', expected.draft.phone)
  const registrationKey = `mobile-primary:{v1}:registration:${expected.draft.id}`, registrationRaw = await redis.get(registrationKey)
  if (!draftRaw || !registrationRaw) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
  const draft = JSON.parse(draftRaw), state = new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '').open(expected.draft.id, registrationRaw)
  if (draft.state !== 'draft' || primarySourceIdentity(draft, state) !== primarySourceIdentity(expected.draft, expected.registration)) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
  const changed = await redis.eval(ACTIVATE_PRIMARY_LUA, { keys: [configKey, fence.key, 'mobile-primary:{v1}:drafts', registrationKey],
    arguments: [raw!, fence.token, expected.draft.phone, draftRaw, registrationRaw, JSON.stringify({ ...config, mobilePrimaryImported: true, autoConnect: true }), phone] })
  if (Number(changed) !== 1) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
}
