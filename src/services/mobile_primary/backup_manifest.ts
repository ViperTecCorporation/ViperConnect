import { MobileDeviceError, validateMobileDraft } from '../mobile_device_service'
import { deserializeCompanionEpoch } from './companion_persistence'

// Audited against @zapo-js/store-redis 1.3.0. Domain comes BEFORE the session ID.
export const BACKUP_DOMAINS = ['auth', 'signal:reg', 'signal:spk', 'signal:meta', 'signal:pk', 'signal:pk:ids', 'signal:pk:avail', 'signal:sess', 'signal:ident', 'sk', 'sk:grp', 'skd', 'appstate:key', 'appstate:key:idx', 'appstate:col', 'appstate:idx', 'appstate:idx:set', 'privtoken'] as const
export const BACKUP_DATA_DOMAINS = ['msg', 'msg:idx', 'contact', 'contact_pn', 'thread'] as const
export const BACKUP_UNO_DOMAINS = ['message', 'id', 'id_rev', 'key', 'message-status', 'jidmap', 'contact-name', 'contact-info', 'last-incoming'] as const
export type BackupMode = 'credentials' | 'complete'
export interface BackupRecord { key: string; dump: string; namespace?: 'uno'; expiresAt?: number }
export interface MobileBackupManifest {
  version: 1 | 2; mode?: BackupMode; zapo: '1.9.0'; redisStore: '1.3.0'; prefix: string; createdAt: string
  device: { phone: string; name: string; platform: 'android' | 'ios'; accountType: 'personal' | 'business' }
  registration: any
  companionEpoch?: ReturnType<typeof import('./companion_persistence').serializeCompanionEpoch>
  records: BackupRecord[]
}

/** Keep only fields used by the credential converter, never provider diagnostics or OTPs. */
export function backupRegistration(state: any) {
  const source = state.store
  const pair = (value: any) => ({ private: value?.private, public: value?.public })
  return {
    status: state.status, canonicalPhone: state.canonicalPhone, advSecret: state.advSecret,
    store: {
      registered: source?.registered, codePending: source?.codePending, phoneNumber: source?.phoneNumber,
      registrationId: source?.registrationId, name: source?.name, version: source?.version,
      noiseKeyPair: pair(source?.noiseKeyPair), identityKeyPair: pair(source?.identityKeyPair),
      signedPreKey: { ...pair(source?.signedPreKey), id: source?.signedPreKey?.id, signature: source?.signedPreKey?.signature },
      device: Object.fromEntries(['os', 'business', 'manufacturer', 'model', 'modelId', 'osVersion', 'osBuildNumber'].map(key => [key, source?.device?.[key]])),
    },
  }
}

export function isMobileBackupKey(key: string, phone: string, mode: BackupMode = 'credentials', namespace?: 'uno'): boolean {
  const domains: readonly string[] = namespace === 'uno' ? (mode === 'complete' ? BACKUP_UNO_DOMAINS : []) : [...BACKUP_DOMAINS, ...(mode === 'complete' ? BACKUP_DATA_DOMAINS : [])]
  return typeof key === 'string' && key.length <= 1024 && !/[\x00-\x1f\x7f*?\[\]\\]/.test(key) && domains.some(domain => key === `${domain}:${phone}` || key.startsWith(`${domain}:${phone}:`))
}

export function backupRecordKey(record: BackupRecord, prefix: string): string {
  return (record.namespace === 'uno' ? 'unoapi-' : prefix) + record.key
}

export function validateMobileBackup(value: any, prefix: string): asserts value is MobileBackupManifest {
  const fail = () => { throw new MobileDeviceError(400, 'mobile_backup_incompatible') }
  if (!value || ![1, 2].includes(value.version) || value.zapo !== '1.9.0' || value.redisStore !== '1.3.0' || value.prefix !== prefix) return fail()
  if (value.version === 2 && (!['credentials', 'complete'].includes(value.mode) || !Number.isFinite(Date.parse(value.createdAt)))) return fail()
  if (value.version === 1 && value.mode !== undefined) return fail()
  if (value.companionEpoch !== undefined) { try { deserializeCompanionEpoch(value.companionEpoch) } catch { return fail() } }
  try { validateMobileDraft({ ...value.device, labConsent: true }) } catch { return fail() }
  if (value.registration?.status !== 'registered' || value.registration.canonicalPhone !== value.device.phone || JSON.stringify(value.registration).length > 180000) return fail()
  validateBackupRecords(value.records, value.device.phone, prefix, value.mode, value.version)
}

export function validateBackupRecords(records: BackupRecord[], phone: string, prefix: string, mode: BackupMode = 'credentials', version = 2): void {
  const fail = () => { throw new MobileDeviceError(400, 'mobile_backup_incompatible') }
  const value = { records, device: { phone }, mode, version }
  if (!Array.isArray(value.records) || value.records.length < 9 || value.records.length > 10000) return fail()
  const keys = new Set<string>()
  for (const record of value.records) {
    if (!record || (record.namespace !== undefined && record.namespace !== 'uno') || (value.version === 1 && (record.namespace !== undefined || record.expiresAt !== undefined)) || !isMobileBackupKey(record.key, value.device.phone, value.mode, record.namespace) || typeof record.dump !== 'string' || record.dump.length > 2000000 || !record.dump.length || Buffer.from(record.dump, 'base64').toString('base64') !== record.dump) return fail()
    if (record.expiresAt !== undefined && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0)) return fail()
    const target = backupRecordKey(record, prefix)
    if (keys.has(target)) return fail()
    keys.add(target)
  }
  for (const suffix of ['', ':noise_pub_key', ':noise_priv_key', ':identity_pub_key', ':identity_priv_key', ':signed_prekey_pub_key', ':signed_prekey_priv_key', ':signed_prekey_signature', ':adv_secret_key']) {
    if (!keys.has(`${prefix}auth:${value.device.phone}${suffix}`)) return fail()
  }
}
