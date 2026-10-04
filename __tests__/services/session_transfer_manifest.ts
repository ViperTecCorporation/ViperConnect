import { validateSessionTransfer } from '../../src/services/session_transfer/manifest'
import { BACKUP_MAX_RECORDS, validateBackupRecords } from '../../src/services/mobile_primary/backup_manifest'
import { encryptMobileBackup, decryptMobileBackup } from '../../src/services/mobile_primary/backup_archive'
const phone = '999123456789'
const fixture = () => ({ kind: 'linked-session', version: 1, zapo: '1.9.0', redisStore: '1.3.0', phone, name: 'Session', identityJid: phone + ':3@s.whatsapp.net', createdAt: new Date().toISOString(), mode: 'complete', records: ['', ':noise_pub_key', ':noise_priv_key', ':identity_pub_key', ':identity_priv_key', ':signed_prekey_pub_key', ':signed_prekey_priv_key', ':signed_prekey_signature', ':adv_secret_key'].map(suffix => ({ key: `auth:${phone}${suffix}`, dump: 'AQ==' })) })
test('linked session archives require explicit kind, identity and SDK versions', () => {
  expect(() => validateSessionTransfer(fixture(), 'unoapi:zapo:')).not.toThrow()
  for (const change of [{ kind: undefined }, { version: 2 }, { phone: '*' }, { identityJid: '' }, { zapo: 'other' }, { mode: 'all' }, { createdAt: '' }]) expect(() => validateSessionTransfer({ ...fixture(), ...change }, 'unoapi:zapo:')).toThrow()
})
test('rejects foreign keys, duplicate records, missing credentials and invalid expiry', () => {
  const sample = fixture()
  for (const records of [sample.records.slice(1), [...sample.records, sample.records[0]], [...sample.records, { key: 'auth:123456789', dump: 'AQ==' }], [...sample.records, { key: `msg:${phone}:x`, dump: 'AQ==', expiresAt: -1 }]]) expect(() => validateSessionTransfer({ ...sample, records }, 'unoapi:zapo:')).toThrow()
})

test('27009 records round-trip and validate for both shared and linked backup validation', async () => {
  const sample = fixture()
  for (let i = sample.records.length; i < 27009; i++) sample.records.push({ key: `appstate:idx:${phone}:${i}`, dump: 'AQ==' })
  const restored = await decryptMobileBackup(await encryptMobileBackup(sample, 'synthetic-password'), 'synthetic-password')
  expect(restored.records).toHaveLength(27009)
  expect(() => validateSessionTransfer(restored, 'unoapi:zapo:')).not.toThrow()
  expect(() => validateBackupRecords(restored.records, phone, 'unoapi:zapo:', 'credentials')).not.toThrow()
})

test('shared record cap accepts its boundary and rejects overflow without truncation', () => {
  const sample = fixture()
  for (let i = sample.records.length; i < BACKUP_MAX_RECORDS; i++) sample.records.push({ key: `signal:sess:${phone}:${i}`, dump: 'AQ==' })
  expect(() => validateSessionTransfer(sample, 'unoapi:zapo:')).not.toThrow()
  sample.records.push({ key: `signal:sess:${phone}:overflow`, dump: 'AQ==' })
  expect(() => validateSessionTransfer(sample, 'unoapi:zapo:')).toThrow('mobile_backup_incompatible')
})
