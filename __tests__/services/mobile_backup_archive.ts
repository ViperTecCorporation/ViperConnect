import { decryptMobileBackup, encryptMobileBackup, validateBackupPassword, BACKUP_MAX_BYTES } from '../../src/services/mobile_primary/backup_archive'
import { BACKUP_DOMAINS, isMobileBackupKey, validateMobileBackup, backupRegistration } from '../../src/services/mobile_primary/backup_manifest'

const password = 'test-only-backup-password'
test('registration backup strips OTP, provider diagnostics and infrastructure fields', () => {
  const value = backupRegistration({ status: 'registered', canonicalPhone: '999123456789', code: 'sensitive', diagnostic: 'sensitive', store: { registered: true, code: 'sensitive', proxy: 'sensitive', device: { os: 'android', token: 'sensitive' }, noiseKeyPair: { public: 'pub', private: 'priv', token: 'sensitive' } } })
  expect(JSON.stringify(value)).not.toContain('sensitive')
  expect(value.store.noiseKeyPair).toEqual({ public: 'pub', private: 'priv' })
})
test('portable backup round-trips without a stack key and is randomized', async () => {
  const value = { privateMaterial: 'synthetic-only', binary: Buffer.from([0, 255]).toString('base64') }
  const archive = await encryptMobileBackup(value, password)
  expect(archive).not.toContain('synthetic-only')
  expect(archive).not.toContain(password)
  expect(await decryptMobileBackup(archive, password)).toEqual(value)
  expect(await encryptMobileBackup(value, password)).not.toBe(archive)
})
test('wrong password, tampering, invalid headers and truncation fail closed', async () => {
  const archive = await encryptMobileBackup({ fixture: true }, password)
  await expect(decryptMobileBackup(archive, 'wrong-password-value')).rejects.toThrow('mobile_backup_invalid_or_wrong_password')
  for (const field of ['data', 'salt', 'iv', 'tag', 'format']) {
    const altered = JSON.parse(archive); altered[field] = 'tampered'
    await expect(decryptMobileBackup(JSON.stringify(altered), password)).rejects.toThrow('mobile_backup_invalid_or_wrong_password')
  }
  await expect(decryptMobileBackup(archive.slice(0, -4), password)).rejects.toThrow('mobile_backup_invalid_or_wrong_password')
})
test('password and archive size limits reject before processing', async () => {
  for (const value of ['', 'short', undefined, 'x'.repeat(129)]) expect(() => validateBackupPassword(value)).toThrow('mobile_backup_password_required')
  await expect(decryptMobileBackup('x'.repeat(BACKUP_MAX_BYTES + 1), password)).rejects.toThrow('mobile_backup_too_large')
  await expect(encryptMobileBackup('x'.repeat(BACKUP_MAX_BYTES), password)).rejects.toThrow('mobile_backup_too_large')
})
const phone = '999123456789'
const manifest = () => ({ version: 1, zapo: '1.9.0', redisStore: '1.3.0', prefix: 'unoapi:zapo:', device: { phone, name: 'Synthetic', platform: 'android', accountType: 'personal' }, registration: { status: 'registered', canonicalPhone: phone }, records: ['', ':noise_pub_key', ':noise_priv_key', ':identity_pub_key', ':identity_priv_key', ':signed_prekey_pub_key', ':signed_prekey_priv_key', ':signed_prekey_signature', ':adv_secret_key'].map(suffix => ({ key: `auth:${phone}${suffix}`, dump: 'AQ==' })) })
test('manifest requires complete auth and exact SDK versions/prefix', () => {
  expect(() => validateMobileBackup(manifest(), 'unoapi:zapo:')).not.toThrow()
  for (const [key, value] of [['zapo', '1.8.0'], ['redisStore', '2.0.0'], ['prefix', 'other:'], ['version', 2]]) {
    expect(() => validateMobileBackup({ ...manifest(), [key]: value }, 'unoapi:zapo:')).toThrow('mobile_backup_incompatible')
  }
  const value = manifest(); value.records.pop()
  expect(() => validateMobileBackup(value, 'unoapi:zapo:')).toThrow()
})

test('manifest validates optional companion epoch while accepting older backups without it', () => {
  const epoch = { rawId: 42, currentKeyIndex: 2, companions: [{ deviceJid: phone + ':2@s.whatsapp.net', keyIndex: 2, companionIdentityPublicKey: Buffer.alloc(32, 1).toString('base64'), addedAtSeconds: 100 }] }
  expect(() => validateMobileBackup({ ...manifest(), companionEpoch: epoch }, 'unoapi:zapo:')).not.toThrow()
  expect(() => validateMobileBackup({ ...manifest(), companionEpoch: { ...epoch, currentKeyIndex: 0 } }, 'unoapi:zapo:')).toThrow('incompatible')
})
test('key scope includes Signal indexes and rejects other sessions or operational keys', () => {
  for (const domain of BACKUP_DOMAINS) {
    expect(isMobileBackupKey(`${domain}:${phone}`, phone)).toBe(true)
    expect(isMobileBackupKey(`${domain}:${phone}:extra`, phone)).toBe(true)
  }
  for (const key of [`auth:${phone}0`, `auth:111${phone}`, 'unoapi-config:999123456789', `lease:${phone}`, `auth:${phone}:*`, `auth:${phone}:x\ny`]) expect(isMobileBackupKey(key, phone)).toBe(false)
  const value = manifest(); value.records.push(value.records[0])
  expect(() => validateMobileBackup(value, value.prefix)).toThrow()
})
