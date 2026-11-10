import { captureBackupState, backupPrimaryIdentity } from '../../src/services/session_storage/backup_capture'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { isDeepStrictEqual } from 'node:util'
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(async () => { throw Error('unexpected_external_redis') }) }))
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn(), amqpRpc: jest.fn(), amqpConsume: jest.fn() }))
const vmTest = typeof module.require('node:vm').SourceTextModule === 'function' ? test : test.skip
const phone = '999123456789', storage = { backend: 'sqlite', storageId: '00000000-0000-4000-8000-000000000001', owner: 'worker_1', generation: 2, state: 'offline' }
test('captures persistent configuration and rejects control changes around snapshot without exposing them', async () => {
  const config: any = { provider: 'zapo', sessionStorage: storage }, values = new Map([[`unoapi-config:${phone}`, JSON.stringify(config)]])
  const redis: any = { get: async (key: string) => values.get(key) || null }
  const snapshot = await captureBackupState(phone, config, redis, '')
  expect(snapshot.configuration).toEqual(config); expect(snapshot.primary).toBeUndefined(); expect(await snapshot.unchanged()).toBe(true)
  values.set(`unoapi-config:${phone}`, JSON.stringify({ ...config, autoConnect: true }))
  expect(await snapshot.unchanged()).toBe(false)
  await expect(captureBackupState(phone, { ...config, sessionStorage: { ...storage, generation: 3 } }, redis, '')).rejects.toThrow('generation_changed')
  values.clear(); await expect(captureBackupState(phone, config, redis, '')).rejects.toThrow('configuration_required')
})
test('primary restore comparison excludes descriptive configuration/draft but preserves registration and epoch', () => {
  const identity = { draftId: 'one', phone, registration: { status: 'registered' }, companionEpoch: { rawId: 3 } }
  expect(backupPrimaryIdentity({ ...identity, configuration: { autoConnect: true }, draft: { name: 'description' } })).toEqual(identity)
  expect(backupPrimaryIdentity(undefined)).toBeUndefined()
})

test('primary identity comparison is stable when archive JSON omits undefined optional credential fields', () => {
  const value = { draftId: 'one', phone, registration: { status: 'registered', store: { registrationId: 123, codePending: undefined, device: { model: undefined } } } }
  expect(isDeepStrictEqual(backupPrimaryIdentity(value), backupPrimaryIdentity(JSON.parse(JSON.stringify(value))))).toBe(true)
})

test('linked capture treats an absent optional draft ID and the Config empty-string default as the same identity', async () => {
  const raw = { provider: 'zapo', sessionStorage: storage }, config: any = { ...raw, mobilePrimaryDraftId: '' }
  const redis: any = { get: async () => JSON.stringify(raw) }
  await expect(captureBackupState(phone, config, redis, '')).resolves.toMatchObject({ configuration: raw, primary: undefined })
})

vmTest('primary capture uses the encrypted vault/draft and its identity survives archive JSON serialization', async () => {
  const draftId = '00000000-0000-4000-8000-000000000002', secret = 'ac'.repeat(32), vault = new RegistrationVault(secret)
  const config: any = { provider: 'zapo', sessionStorage: storage, mobilePrimaryDraftId: draftId }
  const pair = { private: 'synthetic-private', public: 'synthetic-public' }, registration = { status: 'registered', canonicalPhone: phone, advSecret: 'synthetic-adv',
    store: { registered: true, registrationId: 123, noiseKeyPair: pair, identityKeyPair: pair, signedPreKey: { ...pair, id: 1, signature: 'synthetic-signature' } }, otp: 'not-archived', diagnostic: 'not-archived' }
  const registrationKey = `mobile-primary:{v1}:registration:${draftId}`, epochKey = `mobile-primary:{v1}:companions:${draftId}`
  const values = new Map([[`unoapi-config:${phone}`, JSON.stringify(config)], [registrationKey, vault.seal(draftId, registration)], [epochKey, vault.seal(epochKey, { generation: 8 })]])
  let draft = JSON.stringify({ id: draftId, phone, name: 'Synthetic primary' })
  const redis: any = { get: async (key: string) => values.get(key) ?? null, hGet: async (key: string, field: string) => key === 'mobile-primary:{v1}:drafts' && field === phone ? draft : null }
  const snapshot = await captureBackupState(phone, config, redis, secret)
  expect(snapshot.primary).toMatchObject({ draftId, phone, companionEpoch: { generation: 8 }, registration: { status: 'registered', store: { registrationId: 123 } } })
  expect(JSON.stringify(snapshot.primary?.registration)).not.toContain('not-archived')
  expect(await snapshot.unchanged()).toBe(true)
  const identity = backupPrimaryIdentity(snapshot.primary)
  expect(isDeepStrictEqual(identity, backupPrimaryIdentity(JSON.parse(JSON.stringify(snapshot.primary))))).toBe(true)
  const previousEpoch = values.get(epochKey)!; values.set(epochKey, vault.seal(epochKey, { generation: 9 })); expect(await snapshot.unchanged()).toBe(false); values.set(epochKey, previousEpoch)
  draft = JSON.stringify({ id: draftId, phone, name: 'Changed during snapshot' }); expect(await snapshot.unchanged()).toBe(false)
})

vmTest('missing/mismatched primary registration or draft fails explicitly before snapshot publication', async () => {
  const draftId = '00000000-0000-4000-8000-000000000003', secret = 'ad'.repeat(32), vault = new RegistrationVault(secret), config: any = { provider: 'zapo', sessionStorage: storage, mobilePrimaryDraftId: draftId }
  const values = new Map<string, string>([[`unoapi-config:${phone}`, JSON.stringify(config)]])
  const redis: any = { get: async (key: string) => values.get(key) ?? null, hGet: jest.fn(async () => null as string | null) }
  await expect(captureBackupState(phone, config, redis, secret)).rejects.toThrow('registration_required')
  values.set(`mobile-primary:{v1}:registration:${draftId}`, vault.seal(draftId, { status: 'registered', store: {} }))
  await expect(captureBackupState(phone, config, redis, secret)).rejects.toThrow('draft_required')
  redis.hGet.mockResolvedValueOnce(JSON.stringify({ id: 'wrong-draft', phone }))
  await expect(captureBackupState(phone, config, redis, secret)).rejects.toThrow('draft_required')
})
