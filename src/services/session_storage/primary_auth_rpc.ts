import type { WaAuthCredentials } from 'zapo-js/auth'
import type { WaAuthStore } from 'zapo-js/store'
import type { Config } from '../config'
import { primaryStorageSelection, samePrimaryAuthIdentity, type PrimaryAuthMutation } from '../mobile_primary/primary_bootstrap'
import { sameRegistrationPhone } from '../mobile_primary/registration_identity'
import { assertLocalStorageOwner, assertSessionEffectsAllowed, storageOwner, isStorageWorker } from './routing'
import { SessionStorageError, type SessionStorageRedis } from './types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const AUTHORIZE_PRIMARY_AUTH_SAVE_LUA = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] or redis.call('EXISTS',KEYS[3])==1 then return 0 end
redis.call('PEXPIRE',KEYS[2],60000); return 1`
interface Dependencies { redis?: SessionStorageRedis; hasClient?(phone: string): boolean; auth?(phone: string, config: Config): WaAuthStore }

function validCredentials(value: any, phone: string): value is WaAuthCredentials {
  const pairs = [value?.noiseKeyPair, value?.registrationInfo?.identityKeyPair, value?.signedPreKey?.keyPair]
  const bytes = (input: any, length: number) => input instanceof Uint8Array && input.length === length
  const identity = typeof value?.meJid === 'string' && /^\d+@s\.whatsapp\.net$/.test(value.meJid) ? value.meJid.split('@')[0] : ''
  return !!identity && sameRegistrationPhone(phone, identity) && ['android', 'ios'].includes(value?.deviceInfo?.os) && typeof value.deviceInfo.business === 'boolean'
    && pairs.every(pair => bytes(pair?.pubKey, 32) && bytes(pair?.privKey, 32)) && bytes(value?.advSecretKey, 32) && bytes(value?.signedPreKey?.signature, 64)
    && Number.isSafeInteger(value?.registrationInfo?.registrationId) && value.registrationInfo.registrationId > 0 && value.registrationInfo.registrationId <= 16384
    && Number.isSafeInteger(value?.signedPreKey?.keyId) && value.signedPreKey.keyId > 0
}

/** Private owner RPC. Only an explicit paused bootstrap with current socket ownership may write auth. */
export async function executePrimaryAuth(phone: string, config: Config, operation: string, args: any[], deps: Dependencies = {}) {
  assertLocalStorageOwner(config)
  if (!isStorageWorker() || config.server !== storageOwner() || !config.mobilePrimaryDraftId
    || ['migrating', 'restoring'].includes(config.sessionStorage?.state || '')) throw new SessionStorageError(409, 'session_storage_primary_unavailable')
  const auth = () => deps.auth ? deps.auth(phone, config)
    : (module.require('../zapo/zapo_store_registry') as typeof import('../zapo/zapo_store_registry')).zapoStoreRegistry.get(config, phone).session(phone).auth
  if (operation === 'primary.auth.load') return auth().load()
  if (operation !== 'primary.auth.save' || args.length !== 2 || !validCredentials(args[0], phone)) throw new SessionStorageError(400, 'session_storage_primary_auth_invalid')
  assertSessionEffectsAllowed(config)
  const context: PrimaryAuthMutation = args[1], fence = context?.fence
  if (context?.draftId !== config.mobilePrimaryDraftId || !UUID.test(context?.draftId || '') || fence?.key !== `unoapi-lease:zapo-session:${phone}` || !UUID.test(fence?.token || '')) throw new SessionStorageError(409, 'session_storage_primary_auth_lease_lost')
  const redis = deps.redis || await (module.require('../redis') as typeof import('../redis')).getRedis(), configKey = `unoapi-config:${phone}`
  const hasClient = deps.hasClient || ((value: string) => (module.require('../client') as typeof import('../client')).clients.has(value))
  const authorize = async () => {
    const raw = await redis.get(configKey), current = raw && JSON.parse(raw)
    if (!current || current.autoConnect !== false || current.mobilePrimaryImported === true || current.mobilePrimaryDeleting || hasClient(phone)) throw new SessionStorageError(409, 'session_storage_primary_auth_requires_paused')
    const selected = primaryStorageSelection(current, context.draftId)
    if (JSON.stringify(selected) !== JSON.stringify(context.selection) || current.mobilePrimaryDraftId !== config.mobilePrimaryDraftId
      || JSON.stringify(current.sessionStorage) !== JSON.stringify(config.sessionStorage)) throw new SessionStorageError(409, 'session_storage_generation_changed')
    if (Number(await redis.eval(AUTHORIZE_PRIMARY_AUTH_SAVE_LUA, { keys: [configKey, fence.key, `unoapi-session-storage:task:lock:${phone}`], arguments: [raw!, fence.token] })) !== 1) throw new SessionStorageError(409, 'session_storage_primary_auth_lease_lost')
  }
  await authorize()
  const store = auth(), existing = await store.load()
  await authorize()
  if (existing) {
    if (!samePrimaryAuthIdentity(existing, args[0])) throw new SessionStorageError(409, 'session_storage_primary_auth_conflict')
    return { saved: false, alreadyPresent: true }
  }
  await store.save(args[0])
  await authorize()
  return { saved: true }
}
