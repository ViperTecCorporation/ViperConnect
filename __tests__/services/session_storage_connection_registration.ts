jest.mock('../../src/services/redis')
jest.mock('../../src/services/client_zapo', () => ({ ClientZapo: jest.fn().mockImplementation(() => ({ connect: jest.fn(), disconnect: jest.fn() })) }))
import { configs, defaultConfig } from '../../src/services/config'
import { clients } from '../../src/services/client'
import { getConfig as storedConfig, setBusinessAccountIdMapping } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { ClientZapo } from '../../src/services/client_zapo'
import { getClientProvider } from '../../src/services/providers/client_factory'
import { assertSessionConfigRegistered, markSessionConfigRegistration } from '../../src/services/session_storage/connection_registration'
import { readSessionLifecycleConfig } from '../../src/services/session_storage/lifecycle_transition'

const phone = '5566000000881'
beforeEach(() => { configs.clear(); clients.clear(); jest.clearAllMocks() })
afterEach(() => { configs.clear(); clients.clear() })

test('registration provenance is private, cannot come from JSON and does not change config serialization', () => {
  const config = { ...defaultConfig, useRedis: true }
  const before = JSON.stringify(config)
  markSessionConfigRegistration(config, false)
  expect(JSON.stringify(config)).toBe(before)
  expect(() => assertSessionConfigRegistered(config)).toThrow('session_storage_registration_required')
  markSessionConfigRegistration(config, true)
  expect(() => assertSessionConfigRegistered(config)).not.toThrow()
  expect(() => assertSessionConfigRegistered({ ...defaultConfig })).not.toThrow()
})

test('real Redis config resolver + client factory never opens a new implicit Redis socket', async () => {
  ;(storedConfig as jest.Mock).mockResolvedValue(undefined)
  const read = async () => { const config = await getConfigRedis(phone); config.provider = 'zapo'; return config }
  const existing = {} as any
  clients.set(phone, existing)
  await expect(getClientProvider({ phone, getConfig: read, listener: {} as any, onNewLogin: jest.fn() }))
    .rejects.toMatchObject({ code: 409, title: 'session_storage_registration_required' })
  expect(ClientZapo).not.toHaveBeenCalled()
  expect(clients.get(phone)).toBe(existing)
})

test.each(['redis', 'sqlite'])('an existing %s session keeps its selected backend, not the environment default', async backend => {
  const descriptor = backend === 'sqlite' ? { backend: 'sqlite', owner: 'server_1', storageId: 'synthetic', generation: 2, state: 'offline' } : undefined
  ;(storedConfig as jest.Mock).mockResolvedValue({ provider: 'zapo', autoConnect: true, sessionStorage: descriptor })
  const config = await readSessionLifecycleConfig(phone, getConfigRedis)
  expect(config.sessionStorage?.backend || 'redis').toBe(backend)
  expect(() => assertSessionConfigRegistered(config)).not.toThrow()
})

test('after confirmed registration a fresh read removes the missing-registration fence', async () => {
  ;(storedConfig as jest.Mock).mockResolvedValue(undefined)
  await getConfigRedis(phone)
  ;(storedConfig as jest.Mock).mockResolvedValue({ provider: 'zapo', autoConnect: true })
  await expect(readSessionLifecycleConfig(phone, getConfigRedis)).resolves.toMatchObject({ provider: 'zapo' })
})

test('pending bootstrap and a Primary without imported auth are fenced even if another caller enabled autoConnect', () => {
  const config = { ...defaultConfig, useRedis: true, autoConnect: true }
  markSessionConfigRegistration(config, true)
  expect(() => assertSessionConfigRegistered({ ...config, sessionStorageProvisionPending: { id: 'pending', autoConnect: true } })).toThrow('provision_unconfirmed')
  expect(() => assertSessionConfigRegistered({ ...config, mobilePrimaryDraftId: 'draft' })).toThrow('mobile_auth_import_required')
  expect(() => assertSessionConfigRegistered({ ...config, mobilePrimaryDraftId: 'draft', mobilePrimaryImported: true })).not.toThrow()
})

test('a concurrent read cannot consume a cached ENV template while Redis config is still resolving', async () => {
  ;(storedConfig as jest.Mock).mockResolvedValue(undefined)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(done => { entered = done })
  const blocked = new Promise<void>(done => { release = done })
  ;(setBusinessAccountIdMapping as jest.Mock).mockImplementationOnce(async () => { entered(); await blocked })
  const first = getConfigRedis(phone)
  await started
  try {
    expect(configs.has(phone)).toBe(false)
    const concurrent = await getConfigRedis(phone)
    expect(() => assertSessionConfigRegistered(concurrent)).toThrow('session_storage_registration_required')
  } finally { release() }
  const resolved = await first
  expect(() => assertSessionConfigRegistered(resolved)).toThrow('session_storage_registration_required')
})

test('lifecycle cleanup may read an unregistered config after partial logout, but connection still refuses it', async () => {
  ;(storedConfig as jest.Mock).mockResolvedValue(undefined)
  const config = await readSessionLifecycleConfig(phone, getConfigRedis)
  expect(() => assertSessionConfigRegistered(config)).toThrow('session_storage_registration_required')
  await expect(getClientProvider({ phone, getConfig: getConfigRedis, listener: {} as any, onNewLogin: jest.fn() }))
    .rejects.toMatchObject({ title: 'session_storage_registration_required' })
  expect(ClientZapo).not.toHaveBeenCalled()
})
