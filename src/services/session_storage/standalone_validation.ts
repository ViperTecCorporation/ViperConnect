import { createSqliteStore } from '@zapo-js/store-sqlite'
import type { WaAuthCredentials } from 'zapo-js/auth'
import type { MobileDeviceDraft } from '../mobile_device_service'
import { validateMobileDraft } from '../mobile_device_service'
import { backupRegistration } from '../mobile_primary/backup_manifest'
import { deserializeCompanionEpoch, serializeCompanionEpoch } from '../mobile_primary/companion_persistence'
import { convertWhalibmobCredentials } from '../mobile_primary/whalibmob_credentials'
import { registrationSessionPhone, sameRegistrationPhone } from '../mobile_primary/registration_identity'
import { RegistrationVault } from '../mobile_primary/registration_vault'
import { openPreparedSessionDatabase } from './database'
import { sqliteSdkConnection } from './native_migration'
import { validateLiveIdMappings } from './id_validation'
import type { SqliteBackupManifest } from './backup'
import { SessionStorageError, validateStorageDescriptor } from './types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const fail = (code = 'session_storage_standalone_identity_invalid'): never => { throw new SessionStorageError(409, code) }
const object = (value: unknown): Record<string, any> => { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(); return value as Record<string, any> }
const ownPhone = (jid: unknown) => typeof jid === 'string' && /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0].split(':')[0] : undefined
const sameBytes = (a: Uint8Array, b: Uint8Array) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b))

export interface StandaloneValidatedState {
  configuration: Record<string, any>
  identityPhones: string[]
  draft?: MobileDeviceDraft
  registrationEnvelope?: string
  companionEnvelope?: string
}

/** Native signed prekeys rotate; only stable registration/noise/identity material is correlated. */
function stableMobileIdentity(native: WaAuthCredentials, converted: WaAuthCredentials): boolean {
  return ownPhone(native.meJid) === ownPhone(converted.meJid)
    && native.deviceInfo?.os === converted.deviceInfo?.os && native.deviceInfo?.business === converted.deviceInfo?.business
    && native.registrationInfo.registrationId === converted.registrationInfo.registrationId
    && sameBytes(native.noiseKeyPair.pubKey, converted.noiseKeyPair.pubKey) && sameBytes(native.noiseKeyPair.privKey, converted.noiseKeyPair.privKey)
    && sameBytes(native.registrationInfo.identityKeyPair.pubKey, converted.registrationInfo.identityKeyPair.pubKey)
    && sameBytes(native.registrationInfo.identityKeyPair.privKey, converted.registrationInfo.identityKeyPair.privKey)
}

/** Caller owns staging. No network/socket, catalogue write, credential regeneration or auth import. */
export async function validateStandaloneState(phone: string, path: string, manifest: SqliteBackupManifest,
  supplement: Record<string, unknown>, registrationKey?: string, now = Date.now()): Promise<StandaloneValidatedState> {
  const configuration = object(supplement.configuration), source = object(configuration.sessionStorage)
  validateStorageDescriptor(source)
  if (configuration.provider !== 'zapo' || source.backend !== 'sqlite' || source.storageId !== manifest.storageId || source.generation !== manifest.generation) return fail()
  const db = openPreparedSessionDatabase(path)
  try {
    if (db.get('PRAGMA quick_check')?.quick_check !== 'ok' || db.get('SELECT value FROM uno_storage_meta WHERE key=?', ['phone'])?.value !== phone || !validateLiveIdMappings(db, phone, now)) return fail('session_storage_standalone_database_invalid')
    // A per-session archive must not smuggle another session's native rows.
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return fail('session_storage_standalone_database_invalid')
      if (db.all(`PRAGMA table_info(${name})`).some(column => column.name === 'session_id') && db.get(`SELECT COUNT(*) AS n FROM ${name} WHERE session_id<>?`, [phone])?.n) return fail('session_storage_standalone_database_invalid')
    }
    const native = createSqliteStore({ connection: sqliteSdkConnection(db) }), auth = await native.stores!.auth!(phone).load()
    if (manifest.kind === 'linked-session') {
      if (configuration.mobilePrimaryDraftId || configuration.mobilePrimaryImported) return fail()
      if (auth?.deviceInfo || auth?.meJid && !sameRegistrationPhone(phone, ownPhone(auth.meJid) || '')) return fail()
      return { configuration, identityPhones: [...new Set([phone, ownPhone(auth?.meJid)].filter((value): value is string => !!value))] }
    }
    if (!configuration.mobilePrimaryImported || !auth) return fail('session_storage_standalone_primary_auth_required')
    if (!registrationKey || !/^[a-f0-9]{64}$/i.test(registrationKey)) return fail('session_storage_mobile_registration_key_required')
    const draftId = supplement.draftId, original = object(supplement.draft), registration = object(supplement.registration)
    if (typeof draftId !== 'string' || !UUID.test(draftId) || configuration.mobilePrimaryDraftId !== draftId || supplement.phone !== phone
      || original.id !== draftId || original.connectionMode !== 'mobile_primary' || original.state !== 'draft'
      || !Number.isFinite(Date.parse(original.createdAt)) || typeof original.createdBy !== 'string' || !original.createdBy.length || original.createdBy.length > 128 || /[\x00-\x1f\x7f]/.test(original.createdBy)
      || registration.status !== 'registered' || !sameRegistrationPhone(phone, registration.canonicalPhone) || !sameRegistrationPhone(original.phone, registration.canonicalPhone)
      || registrationSessionPhone(registration, original.phone) !== phone) return fail()
    const description = validateMobileDraft({ phone: original.phone, name: original.name, platform: original.platform, accountType: original.accountType, labConsent: true })
    const converted = await convertWhalibmobCredentials(registration.store, { expectedCanonicalPhone: registration.canonicalPhone, advSecretKey: Buffer.from(registration.advSecret || '', 'base64') })
    if (!stableMobileIdentity(auth, converted) || description.platform !== converted.deviceInfo?.os || (description.accountType === 'business') !== converted.deviceInfo?.business) return fail()
    const draft: MobileDeviceDraft = { ...description, id: draftId, connectionMode: 'mobile_primary', state: 'draft', createdAt: original.createdAt, createdBy: original.createdBy }
    const vault = new RegistrationVault(registrationKey), epochKey = `mobile-primary:{v1}:companions:${draftId}`
    const epoch = supplement.companionEpoch === undefined ? undefined : serializeCompanionEpoch(deserializeCompanionEpoch(supplement.companionEpoch))
    return { configuration, identityPhones: [...new Set([phone, draft.phone, registration.canonicalPhone])], draft, registrationEnvelope: vault.seal(draftId, backupRegistration(registration)), ...(epoch ? { companionEnvelope: vault.seal(epochKey, epoch) } : {}) }
  } catch (error) {
    if (error instanceof SessionStorageError) throw error
    return fail()
  } finally {
    try {
      const checkpoint = db.get('PRAGMA wal_checkpoint(TRUNCATE)')
      if (Number(checkpoint?.busy) !== 0) fail('session_storage_standalone_checkpoint_incomplete')
    } finally { db.close() }
  }
}
