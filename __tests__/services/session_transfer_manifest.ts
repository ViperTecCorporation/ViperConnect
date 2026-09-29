import { validateSessionTransfer } from '../../src/services/session_transfer/manifest'
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
