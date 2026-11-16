const mockValues = new Map<string, string>()
const mockDrafts = new Map<string, string>()
const mockRpc = jest.fn()
const mockDispatch = jest.fn(async () => {})
const mockNativeFallback = jest.fn(() => { throw new Error('web_must_not_open_native_auth') })
const mockConfig = jest.fn(async (phone: string) => { const raw = mockValues.get(`unoapi-config:${phone}`); return raw ? JSON.parse(raw) : undefined })
const mockSetConfig = jest.fn(async (phone: string, value: any, guard?: any) => {
  if (guard?.expectedAbsent && mockValues.has(`unoapi-config:${phone}`)) throw new Error('configuration_exists')
  mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ ...await mockConfig(phone), ...value }))
})
const mockRedis = { get: jest.fn(async (key: string) => mockValues.get(key) || null), hGet: jest.fn(async (_key: string, phone: string) => mockDrafts.get(phone) || null),
  set: jest.fn(async (key: string, value: string, options: any) => { if (options?.NX && mockValues.has(key)) return null; mockValues.set(key, value); return 'OK' }),
  eval: jest.fn(async (script: string, input: any) => {
    const { keys, arguments: args } = input
    if (script === CONFIRM_PROVISION_LUA) {
      if (mockValues.get(keys[0]) !== args[0]) return 0
      const config = JSON.parse(args[0])
      if (config.sessionStorageProvisionPending?.id !== args[1] || config.sessionStorageProvisioned?.id !== args[1] || config.sessionStorageProvisioned?.owner !== args[2] || config.autoConnect !== false) return 0
      mockValues.set(keys[0], JSON.stringify({ ...config, autoConnect: config.sessionStorageProvisionPending.autoConnect, sessionStorageProvisionPending: null })); return 1
    }
    if (script === ACTIVATE_PRIMARY_LUA) {
      if (mockValues.get(keys[0]) !== args[0] || mockValues.get(keys[1]) !== args[1] || mockDrafts.get(args[2]) !== args[3] || mockValues.get(keys[3]) !== args[4]) return 0
      mockValues.set(keys[0], args[5]); return 1
    }
    if (script === AUTHORIZE_PRIMARY_AUTH_SAVE_LUA) return mockValues.get(keys[0]) === args[0] && mockValues.get(keys[1]) === args[1] && !mockValues.has(keys[2]) ? 1 : 0
    if (script.includes("redis.call('get', KEYS[1]) == ARGV[1]")) {
      if (mockValues.get(keys[0]) !== args[0]) return 0
      if (script.includes("redis.call('del'")) mockValues.delete(keys[0])
      return 1
    }
    throw new Error('unexpected_redis_script')
  }) }

jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: async () => mockRedis, getConfig: (...args: any[]) => (mockConfig as any)(...args),
  setConfig: (...args: any[]) => (mockSetConfig as any)(...args), getSessionStatus: jest.fn(async () => 'offline') }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: (...args: any[]) => (mockConfig as any)(...args) }))
jest.mock('../../src/services/reload_amqp', () => ({ ReloadAmqp: class { run = mockDispatch } }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: (...args: any[]) => mockRpc(...args) }))
jest.mock('../../src/services/zapo/zapo_store_registry', () => ({ zapoStoreRegistry: { get: mockNativeFallback } }))
jest.mock('../../src/services/mobile_primary/whalibmob_credentials', () => ({ convertWhalibmobCredentials: jest.fn() }))

import { randomUUID } from 'node:crypto'
import { createMobileConnectionService } from '../../src/services/mobile_primary/connection_runtime'
import { MobileDeviceService } from '../../src/services/mobile_device_service'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { convertWhalibmobCredentials } from '../../src/services/mobile_primary/whalibmob_credentials'
import { ACTIVATE_PRIMARY_LUA, primaryStorageSelection, samePrimaryAuthIdentity } from '../../src/services/mobile_primary/primary_bootstrap'
import { CONFIRM_PROVISION_LUA } from '../../src/services/session_storage/provisioning'
import { executePrimaryAuth, AUTHORIZE_PRIMARY_AUTH_SAVE_LUA } from '../../src/services/session_storage/primary_auth_rpc'
import { configs } from '../../src/services/config'

const phone = '999123456789', owner = 'primary_owner', id = '12345678-1234-4234-8234-123456789abc', savedEnv = { ...process.env }
const credentials: any = { meJid: `${phone}@s.whatsapp.net`, deviceInfo: { os: 'ios', business: false },
  noiseKeyPair: { pubKey: Buffer.alloc(32, 1), privKey: Buffer.alloc(32, 2) }, registrationInfo: { registrationId: 1234, identityKeyPair: { pubKey: Buffer.alloc(32, 3), privKey: Buffer.alloc(32, 4) } },
  signedPreKey: { keyId: 7, signature: Buffer.alloc(64, 5), keyPair: { pubKey: Buffer.alloc(32, 6), privKey: Buffer.alloc(32, 7) } }, advSecretKey: Buffer.alloc(32, 8) }
const draft: any = { id, phone, name: 'Synthetic Primary', platform: 'ios', accountType: 'personal', state: 'draft' }
let native: any, provisionFailure: 'before' | 'after' | undefined, authFailure: 'before' | 'after' | undefined, selectedBackend: 'redis' | 'sqlite', authStore: any

beforeEach(() => {
  jest.clearAllMocks(); mockValues.clear(); mockDrafts.clear(); configs.clear()
  process.env.MOBILE_PRIMARY_LAB_ENABLED = 'true'; process.env.MOBILE_REGISTRATION_KEY = 'ab'.repeat(32)
  process.env.UNOAPI_PROCESS_ROLE = 'web'; process.env.UNOAPI_SERVER_NAME = owner; process.env.UNOAPI_STORAGE_WORKER_ID = owner
  delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  selectedBackend = 'sqlite'; native = null; provisionFailure = undefined; authFailure = undefined
  const state = { status: 'registered', canonicalPhone: phone, sessionPhone: phone, advSecret: Buffer.alloc(32, 8).toString('base64'), store: { registrationId: 1234 } }
  mockValues.set(`mobile-primary:{v1}:registration:${id}`, new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY).seal(id, state))
  mockDrafts.set(phone, JSON.stringify(draft)); jest.spyOn(MobileDeviceService.prototype, 'get').mockImplementation(async () => JSON.parse(mockDrafts.get(phone)!))
  ;(convertWhalibmobCredentials as jest.Mock).mockResolvedValue(credentials)
  authStore = { load: jest.fn(async () => native), save: jest.fn(async value => { native = value }), clear: jest.fn() }
  mockRpc.mockImplementation(async (number: string, selected: any, operation: string, args: any[]) => {
    expect(process.env.UNOAPI_PROCESS_ROLE).toBe('web'); expect(number).toBe(phone)
    if (operation === 'provision') {
      if (provisionFailure === 'before') { provisionFailure = undefined; throw new Error('provision_reply_lost_before_commit') }
      const config = await mockConfig(phone), provisionId = args[0].provisionId
      if (config.sessionStorageProvisioned?.id !== provisionId) {
        const storageId = provisionId
        mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ ...config,
          ...(selectedBackend === 'sqlite' ? { sessionStorage: { backend: 'sqlite', owner, storageId, generation: 1, state: 'active' } } : {}),
          sessionStorageProvisioned: { id: provisionId, backend: selectedBackend, owner, generation: selectedBackend === 'sqlite' ? 1 : 0, ...(selectedBackend === 'sqlite' ? { storageId } : {}) } }))
      }
      if (provisionFailure === 'after') { provisionFailure = undefined; throw new Error('provision_reply_lost_after_commit') }
      return undefined
    }
    if (authFailure === 'before' && operation === 'primary.auth.save') { authFailure = undefined; throw new Error('auth_reply_lost_before_commit') }
    // Model the process boundary explicitly: the HTTP side has no native store.
    // Only this private owner execution is allowed to access worker auth.
    const role = process.env.UNOAPI_PROCESS_ROLE; process.env.UNOAPI_PROCESS_ROLE = 'worker'
    let result: unknown
    try { result = await executePrimaryAuth(phone, selected, operation, args, { redis: mockRedis as any, hasClient: () => false, auth: () => authStore }) }
    finally { process.env.UNOAPI_PROCESS_ROLE = role }
    if (authFailure === 'after' && operation === 'primary.auth.save') { authFailure = undefined; throw new Error('auth_reply_lost_after_commit') }
    return result
  })
})
afterEach(() => { jest.restoreAllMocks(); configs.clear(); process.env = { ...savedEnv } })

test.each(['redis', 'sqlite'] as const)('new %s Primary durably confirms owner selection before auth import and final activation', async backend => {
  selectedBackend = backend
  await expect((await createMobileConnectionService()).connect(id, { confirm: true })).resolves.toMatchObject({ imported: true, status: 'connection_requested' })
  const config = await mockConfig(phone)
  expect(config.mobilePrimaryImported).toBe(true); expect(config.autoConnect).toBe(true); expect(config.sessionStorageProvisionPending).toBeNull()
  expect(primaryStorageSelection(config, id).backend).toBe(backend)
  expect(mockSetConfig).toHaveBeenCalledTimes(1)
  expect(mockSetConfig).toHaveBeenCalledWith(phone, expect.objectContaining({ autoConnect: false, sessionStorageProvisionPending: expect.objectContaining({ id: expect.any(String) }) }), { expectedAbsent: true })
  expect(authStore.save).toHaveBeenCalledTimes(1); expect(mockNativeFallback).not.toHaveBeenCalled(); expect(mockDispatch).toHaveBeenCalledWith(phone)
  expect(mockValues.has(`unoapi-lease:zapo-session:${phone}`)).toBe(false)
})

test('reply lost before provision commit stays paused and retries the exact pending ID instead of falling back to Redis', async () => {
  provisionFailure = 'before'
  const service = await createMobileConnectionService()
  await expect(service.connect(id, { confirm: true })).rejects.toThrow('provision_unconfirmed')
  const pending = await mockConfig(phone)
  expect(pending.autoConnect).toBe(false); expect(pending.mobilePrimaryImported).toBeUndefined(); expect(pending.sessionStorage).toBeUndefined()
  expect(authStore.save).not.toHaveBeenCalled(); expect(mockDispatch).not.toHaveBeenCalled(); expect(mockValues.has(`unoapi-lease:zapo-session:${phone}`)).toBe(false)
  await service.connect(id, { confirm: true })
  const provisionCalls = mockRpc.mock.calls.filter(call => call[2] === 'provision')
  expect(provisionCalls.map(call => call[3][0].provisionId)).toEqual([pending.sessionStorageProvisionPending.id, pending.sessionStorageProvisionPending.id])
  expect((await mockConfig(phone)).sessionStorage.backend).toBe('sqlite'); expect(authStore.save).toHaveBeenCalledTimes(1)
})

test.each(['redis', 'sqlite'] as const)('lost provision reply after committed %s receipt can be safely confirmed without an auth fallback', async backend => {
  selectedBackend = backend; provisionFailure = 'after'
  await (await createMobileConnectionService()).connect(id, { confirm: true })
  expect((await mockConfig(phone)).sessionStorageProvisioned.backend).toBe(backend)
  expect(authStore.save).toHaveBeenCalledTimes(1); expect(mockNativeFallback).not.toHaveBeenCalled(); expect(mockDispatch).toHaveBeenCalledTimes(1)
})

test.each(['before', 'after'] as const)('lost native auth reply %s commit keeps imported=false and retries without replacing native identity', async when => {
  authFailure = when
  const service = await createMobileConnectionService()
  await expect(service.connect(id, { confirm: true })).rejects.toThrow(`auth_reply_lost_${when}_commit`)
  const paused = await mockConfig(phone)
  expect(paused.autoConnect).toBe(false); expect(paused.mobilePrimaryImported).toBeUndefined(); expect(paused.sessionStorage.backend).toBe('sqlite')
  expect(mockDispatch).not.toHaveBeenCalled()
  if (when === 'after') native = { ...native, meLid: '123456@lid', signedPreKey: { ...native.signedPreKey, keyId: 999 } }
  const retained = native
  selectedBackend = 'redis' // An ENV/default change cannot reprovision an already selected session.
  await service.connect(id, { confirm: true })
  expect((await mockConfig(phone)).sessionStorage.backend).toBe('sqlite')
  expect(mockRpc.mock.calls.filter(call => call[2] === 'provision')).toHaveLength(1)
  expect(authStore.save).toHaveBeenCalledTimes(1)
  if (retained) expect(native).toBe(retained)
})

test('legacy partial Primary without selection/receipt fails closed, preserving all configuration and native auth', async () => {
  const partial = { provider: 'zapo', server: owner, autoConnect: false, mobilePrimaryDraftId: id, webhooks: [{ id: 'keep' }] }
  mockValues.set(`unoapi-config:${phone}`, JSON.stringify(partial))
  await expect((await createMobileConnectionService()).connect(id, { confirm: true })).rejects.toThrow('mobile_storage_selection_required')
  expect(await mockConfig(phone)).toEqual(partial); expect(mockRpc).not.toHaveBeenCalled(); expect(authStore.save).not.toHaveBeenCalled(); expect(mockDispatch).not.toHaveBeenCalled()
})

test.each(['migration', 'restore'])('an imported Primary reconnects through its current descriptor after %s despite an old bootstrap receipt', async operation => {
  const staleReceipt = { id: randomUUID(), backend: operation === 'migration' ? 'redis' : 'sqlite', owner, generation: operation === 'migration' ? 0 : 1,
    ...(operation === 'restore' ? { storageId: randomUUID() } : {}) }
  const storage = { backend: 'sqlite', owner, storageId: randomUUID(), generation: 7, state: 'offline' }
  mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ provider: 'zapo', server: owner, autoConnect: false, mobilePrimaryImported: true,
    mobilePrimaryDraftId: id, sessionStorage: storage, sessionStorageProvisioned: staleReceipt }))
  native = { ...credentials, signedPreKey: { ...credentials.signedPreKey, keyId: 999 } }
  const retained = native
  await (await createMobileConnectionService()).connect(id, { confirm: true })
  const config = await mockConfig(phone)
  expect(config.sessionStorage).toEqual(storage); expect(config.mobilePrimaryImported).toBe(true); expect(config.autoConnect).toBe(true)
  expect(mockRpc.mock.calls.filter(call => call[2] === 'provision')).toHaveLength(0)
  expect(mockRpc.mock.calls.filter(call => call[2] === 'primary.auth.load').every(call => call[1].sessionStorage.generation === 7)).toBe(true)
  expect(authStore.save).not.toHaveBeenCalled(); expect(native).toBe(retained); expect(mockDispatch).toHaveBeenCalledTimes(1)
})

test('a stale receipt still blocks an unimported bootstrap and imported sessions still enforce current owner/generation', () => {
  const storage = { backend: 'sqlite', owner, storageId: randomUUID(), generation: 7, state: 'offline' }
  const config = { provider: 'zapo', server: owner, mobilePrimaryDraftId: id, autoConnect: false, sessionStorage: storage,
    sessionStorageProvisioned: { id: randomUUID(), backend: 'sqlite', owner, storageId: randomUUID(), generation: 1 } }
  expect(() => primaryStorageSelection(config, id)).toThrow('provision_unconfirmed')
  expect(() => primaryStorageSelection({ ...config, mobilePrimaryImported: false }, id)).toThrow('provision_unconfirmed')
  expect(primaryStorageSelection({ ...config, mobilePrimaryImported: true }, id)).toEqual({ backend: 'sqlite', owner, storageId: storage.storageId, generation: 7 })
  expect(() => primaryStorageSelection({ ...config, mobilePrimaryImported: true, sessionStorage: { ...storage, owner: 'other_worker' } }, id)).toThrow('storage_selection_invalid')
  expect(() => primaryStorageSelection({ ...config, mobilePrimaryImported: true, sessionStorage: { ...storage, generation: 0 } }, id)).toThrow('storage_selection_invalid')
})

test('expired socket fence during auth loading refuses import/activation and leaves the selected SQLite offline', async () => {
  authStore.load.mockImplementationOnce(async () => { mockValues.delete(`unoapi-lease:zapo-session:${phone}`); return null })
  await expect((await createMobileConnectionService()).connect(id, { confirm: true })).rejects.toThrow('mobile_session_in_use')
  const config = await mockConfig(phone)
  expect(config.autoConnect).toBe(false); expect(config.mobilePrimaryImported).toBeUndefined(); expect(config.sessionStorage.backend).toBe('sqlite')
  expect(authStore.save).not.toHaveBeenCalled(); expect(mockDispatch).not.toHaveBeenCalled()
})

test('draft deletion after auth save cannot atomically enable the Primary, and retry never clears its native identity', async () => {
  authStore.save.mockImplementationOnce(async value => { native = value; mockDrafts.set(phone, JSON.stringify({ ...draft, state: 'deleting' })) })
  await expect((await createMobileConnectionService()).connect(id, { confirm: true })).rejects.toThrow('mobile_registration_state_conflict')
  const config = await mockConfig(phone)
  expect(config.autoConnect).toBe(false); expect(config.mobilePrimaryImported).toBeUndefined(); expect(mockDispatch).not.toHaveBeenCalled(); expect(authStore.clear).not.toHaveBeenCalled()
})

test('a config edit racing the final enable CAS is preserved and cannot be silently marked imported', async () => {
  const original = mockRedis.eval.getMockImplementation()!
  mockRedis.eval.mockImplementation(async (script, input) => {
    if (script === ACTIVATE_PRIMARY_LUA) {
      const config = await mockConfig(phone)
      mockValues.set(`unoapi-config:${phone}`, JSON.stringify({ ...config, webhooks: [{ id: 'concurrent-change' }] }))
    }
    return original(script, input)
  })
  try {
    await expect((await createMobileConnectionService()).connect(id, { confirm: true })).rejects.toThrow('mobile_registration_state_conflict')
    const config = await mockConfig(phone)
    expect(config.webhooks).toEqual([{ id: 'concurrent-change' }]); expect(config.autoConnect).toBe(false); expect(config.mobilePrimaryImported).toBeUndefined()
    expect(mockDispatch).not.toHaveBeenCalled(); expect(authStore.save).toHaveBeenCalledTimes(1)
  } finally { mockRedis.eval.mockImplementation(original) }
})

test('stable identity comparison ignores signed-prekey rotation but rejects changed auth secret or private key', () => {
  expect(samePrimaryAuthIdentity(credentials, { ...credentials, meLid: '123@lid', signedPreKey: { rotated: true } })).toBe(true)
  expect(samePrimaryAuthIdentity(credentials, { ...credentials, advSecretKey: Buffer.alloc(32, 99) })).toBe(false)
  expect(samePrimaryAuthIdentity(credentials, { ...credentials, noiseKeyPair: { ...credentials.noiseKeyPair, privKey: Buffer.alloc(32, 99) } })).toBe(false)
})
