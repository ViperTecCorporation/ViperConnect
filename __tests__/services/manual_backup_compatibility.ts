import { assertRedisManualBackup, installedBackupVersion, isBackupZapoVersion, validateBackupRuntime } from '../../src/services/mobile_primary/backup_compatibility'
import { validateMobileBackup } from '../../src/services/mobile_primary/backup_manifest'
import { validateSessionTransfer } from '../../src/services/session_transfer/manifest'
import { validateStreamMeta } from '../../src/services/session_transfer/stream_restore'
import { decryptMobileBackup, encryptMobileBackup } from '../../src/services/mobile_primary/backup_archive'

const phone = '999123456789', prefix = 'unoapi:zapo:'
const records = () => ['', ':noise_pub_key', ':noise_priv_key', ':identity_pub_key', ':identity_priv_key', ':signed_prekey_pub_key', ':signed_prekey_priv_key', ':signed_prekey_signature', ':adv_secret_key'].map(suffix => ({ key: `auth:${phone}${suffix}`, dump: 'AP8=' }))
const mobile = (zapo: string) => ({ version: 2, mode: 'complete', zapo, redisStore: '1.3.0', prefix, createdAt: new Date().toISOString(), device: { phone, name: 'Synthetic', platform: 'android', accountType: 'personal' }, registration: { status: 'registered', canonicalPhone: phone }, records: records() })
const linked = (zapo: string) => ({ kind: 'linked-session', version: 1, mode: 'complete', zapo, redisStore: '1.3.0', phone, name: 'Synthetic', identityJid: `${phone}:3@s.whatsapp.net`, createdAt: new Date().toISOString(), records: records() })

test('current installed runtime is exactly Zapo 1.11.0/store-redis 1.3.0, independently of accepted archive origins', () => {
  expect(installedBackupVersion('incompatible')).toBe('1.11.0')
  expect(validateBackupRuntime('1.11.0', '1.3.0', 'incompatible')).toBe('1.11.0')
  for (const [zapo, store] of [['1.9.0', '1.3.0'], ['1.10.0', '1.3.0'], ['1.12.0', '1.3.0'], ['1.11.0', '1.4.0'], ['1.11.0', undefined]]) expect(() => validateBackupRuntime(zapo, store, 'incompatible')).toThrow('incompatible')
})

test.each(['1.9.0', '1.11.0'])('encrypted manual archives from %s remain readable with complete metadata and strict scopes', async zapo => {
  expect(isBackupZapoVersion(zapo)).toBe(true)
  for (const value of [mobile(zapo), linked(zapo)]) {
    const ciphertext = await encryptMobileBackup(value, 'synthetic-password'), decoded = await decryptMobileBackup(ciphertext, 'synthetic-password')
    expect(decoded).toEqual(value); expect(ciphertext).not.toContain(phone)
    if ('device' in decoded) validateMobileBackup(decoded, prefix)
    else validateSessionTransfer(decoded, prefix)
    decoded.records.push({ key: 'auth:999987654321', dump: 'AP8=' })
    expect(() => 'device' in decoded ? validateMobileBackup(decoded, prefix) : validateSessionTransfer(decoded, prefix)).toThrow()
  }
  const { records: _records, ...metadata } = linked(zapo)
  expect(() => validateStreamMeta({ ...metadata, version: 2 })).not.toThrow()
})

test('unknown client versions and changed Redis schemas still fail closed for all three archive contracts', () => {
  for (const zapo of ['1.8.0', '1.10.0', '1.12.0', undefined]) {
    expect(isBackupZapoVersion(zapo)).toBe(false)
    expect(() => validateMobileBackup({ ...mobile('1.11.0'), zapo }, prefix)).toThrow()
    expect(() => validateSessionTransfer({ ...linked('1.11.0'), zapo }, prefix)).toThrow()
    const { records: _records, ...metadata } = linked('1.11.0')
    expect(() => validateStreamMeta({ ...metadata, version: 2, zapo })).toThrow()
  }
  expect(() => validateMobileBackup({ ...mobile('1.11.0'), redisStore: '1.4.0' }, prefix)).toThrow()
  expect(() => validateSessionTransfer({ ...linked('1.11.0'), redisStore: '1.4.0' }, prefix)).toThrow()
})

test('legacy manual export cannot read a SQLite session even though its shared catalogue sets useRedis=true', () => {
  for (const state of ['active', 'offline', 'migrating', 'restoring']) expect(() => assertRedisManualBackup({ useRedis: true, sessionStorage: { backend: 'sqlite', state } }, 'use_storage')).toThrow('use_storage')
  expect(() => assertRedisManualBackup({ useRedis: true }, 'use_storage')).not.toThrow()
  expect(() => assertRedisManualBackup({ sessionStorage: { backend: 'redis', state: 'active' } }, 'use_storage')).not.toThrow()
  for (const state of ['migrating', 'restoring']) expect(() => assertRedisManualBackup({ sessionStorage: { backend: 'redis', state } }, 'use_storage')).toThrow('session_storage_operation_in_progress')
})
