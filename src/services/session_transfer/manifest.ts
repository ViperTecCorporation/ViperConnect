import { MobileDeviceError } from '../mobile_device_service'
import { BackupRecord, BackupMode, validateBackupRecords } from '../mobile_primary/backup_manifest'
import { isBackupZapoVersion, type BackupZapoVersion } from '../mobile_primary/backup_compatibility'

export interface SessionTransferManifest {
  kind: 'linked-session'; version: 1; zapo: BackupZapoVersion; redisStore: '1.3.0'
  phone: string; name: string; identityJid: string; mode: BackupMode; createdAt: string; records: BackupRecord[]
}
export function validateSessionTransfer(value: any, prefix: string): asserts value is SessionTransferManifest {
  if (!value || value.kind !== 'linked-session' || value.version !== 1 || !isBackupZapoVersion(value.zapo) || value.redisStore !== '1.3.0' || !/^[1-9]\d{7,14}$/.test(value.phone) || typeof value.name !== 'string' || value.name.length > 80 || !/^\d+:\d+@s\.whatsapp\.net$/.test(value.identityJid) || !['credentials', 'complete'].includes(value.mode) || !Number.isFinite(Date.parse(value.createdAt))) throw new MobileDeviceError(400, 'session_backup_incompatible')
  validateBackupRecords(value.records, value.phone, prefix, value.mode)
}
