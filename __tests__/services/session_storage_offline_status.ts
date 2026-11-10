jest.mock('../../src/services/meta_alias', () => ({ resolveSessionPhoneByMetaId: async (phone: string) => phone }))
jest.mock('../../src/services/redis', () => ({ pruneAuthSignalCache: jest.fn(), setPrivacyBootstrapSync: jest.fn() }))
jest.mock('../../src/services/privacy_token_quota', () => ({ getMissingTcTokenQuotaStatus: async () => undefined }))
jest.mock('../../src/services/manager_access', () => ({ managerPrincipal: () => ({ role: 'admin', phones: [] }) }))
import { randomUUID } from 'node:crypto'
import { publishOwnedStorageOffline, reconcileStorageSessionOffline, STORAGE_OFFLINE_STATUS_LUA } from '../../src/services/session_storage/offline_status'
import { PhoneNumberController } from '../../src/controllers/phone_number_controller'
import { MobileConnectionService } from '../../src/services/mobile_primary/connection_service'

const phone = '999123456789', statusKey = `unoapi-status:${phone}`
function fixture() {
  const storage = { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'worker_1', generation: 2, state: 'offline' as const }
  const config: any = { provider: 'zapo', server: 'worker_1', autoConnect: false, sessionStorage: storage, mobilePrimaryDraftId: 'draft', mobilePrimaryImported: true }
  const ownership = { key: `unoapi-lease:zapo-session:${phone}`, token: randomUUID() }, values = new Map<string, string>([[`unoapi-config:${phone}`, JSON.stringify(config)], [statusKey, 'online'], [ownership.key, ownership.token], ['native-auth-preserved', 'unchanged']])
  const published: string[] = []
  const redis = { get: jest.fn(async (key: string) => values.get(key) || null), eval: jest.fn(async (script: string, input: any) => {
    expect(script).toBe(STORAGE_OFFLINE_STATUS_LUA)
    const [configuration, status, lease] = input.keys, [token, owner, id, generation, backend, state, task, session, stale] = input.arguments
    const saved = JSON.parse(values.get(configuration) || 'null'), s = saved?.sessionStorage
    if (values.get(lease) !== token || saved?.provider !== 'zapo' || saved.server !== owner || saved.autoConnect !== false || saved.sessionStorageUnlinked || saved.mobilePrimaryDeleting || !s
      || s.owner !== owner || s.storageId !== id || s.generation !== Number(generation) || s.backend !== backend || s.state !== state || task && saved.sessionStorageTaskId !== task) return 0
    if (stale === '1' && !['online', 'connecting', 'standby', 'restart_required'].includes(values.get(status)!)) return 0
    values.set(status, 'offline'); published.push(session); return 1
  }) }
  const lease = { acquire: jest.fn(async () => true), ownership: () => ownership, release: jest.fn(async () => true) }
  const hasClient = jest.fn(() => false), deps = { redis, hasClient, lease: () => lease }
  return { storage, config, ownership, values, published, redis, lease, hasClient, deps }
}

test('a paused clientless migration publishes canonical offline only under its task/generation/socket-lease fence', async () => {
  const f = fixture(), taskId = randomUUID(), paused = { ...f.storage, backend: 'redis' as const, state: 'migrating' as const }
  f.values.set(`unoapi-config:${phone}`, JSON.stringify({ ...f.config, sessionStorage: paused, sessionStorageTaskId: taskId }))
  expect(await publishOwnedStorageOffline(f.redis, phone, paused, f.ownership, { taskId })).toBe(true)
  expect(f.values.get(statusKey)).toBe('offline'); expect(f.published).toEqual([phone])
  expect(f.values.get('native-auth-preserved')).toBe('unchanged')
  expect(STORAGE_OFFLINE_STATUS_LUA).toContain("redis.call('PUBLISH','unoapi-status:update',ARGV[8])")
  expect(STORAGE_OFFLINE_STATUS_LUA).toContain("redis.call('GET',KEYS[3])~=ARGV[1]")
  expect(STORAGE_OFFLINE_STATUS_LUA).not.toMatch(/DEL|UNLINK|EXPIRE/)
})

test.each(['lease', 'generation', 'owner', 'storageId', 'taskId', 'autoConnect', 'state', 'unlink', 'deleting'])('a concurrent %s change cannot be overwritten by the offline projection', async change => {
  const f = fixture(), taskId = randomUUID(), saved = { ...f.config, sessionStorage: { ...f.storage }, sessionStorageTaskId: taskId }
  if (change === 'lease') f.values.set(f.ownership.key, randomUUID())
  else if (change === 'generation') saved.sessionStorage.generation++
  else if (change === 'owner') saved.sessionStorage.owner = 'worker_2'
  else if (change === 'storageId') saved.sessionStorage.storageId = randomUUID()
  else if (change === 'taskId') saved.sessionStorageTaskId = randomUUID()
  else if (change === 'autoConnect') saved.autoConnect = true
  else if (change === 'state') saved.sessionStorage.state = 'restoring' as any
  else if (change === 'unlink') saved.sessionStorageUnlinked = true
  else saved.mobilePrimaryDeleting = true
  f.values.set(`unoapi-config:${phone}`, JSON.stringify(saved))
  expect(await publishOwnedStorageOffline(f.redis, phone, f.storage, f.ownership, { taskId })).toBe(false)
  expect(f.values.get(statusKey)).toBe('online'); expect(f.published).toEqual([])
})

test('explicit stale reconciliation acquires/releases ownership and never reopens transport or changes configuration/auth', async () => {
  const f = fixture(), before = f.values.get(`unoapi-config:${phone}`)
  expect(await reconcileStorageSessionOffline(phone, f.config, f.deps)).toBe(true)
  expect(f.lease.acquire).toHaveBeenCalledTimes(1); expect(f.lease.release).toHaveBeenCalledTimes(1)
  expect(f.values.get(statusKey)).toBe('offline'); expect(f.values.get(`unoapi-config:${phone}`)).toBe(before)
  expect(f.values.get('native-auth-preserved')).toBe('unchanged')
  expect(await reconcileStorageSessionOffline(phone, f.config, f.deps)).toBe(false)
  expect(f.lease.acquire).toHaveBeenCalledTimes(1)
})

test('local clients, competing socket ownership, autoConnect and removed auth prevent false offline', async () => {
  const f = fixture()
  f.hasClient.mockReturnValue(true); expect(await reconcileStorageSessionOffline(phone, f.config, f.deps)).toBe(false)
  f.hasClient.mockReturnValue(false); f.lease.acquire.mockResolvedValue(false); expect(await reconcileStorageSessionOffline(phone, f.config, f.deps)).toBe(false)
  expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.lease.release).not.toHaveBeenCalled()
  f.lease.acquire.mockResolvedValue(true)
  for (const altered of [{ ...f.config, autoConnect: true }, { ...f.config, sessionStorageUnlinked: true }, { ...f.config, mobilePrimaryDeleting: true }, { ...f.config, sessionStorage: { ...f.storage, state: 'migrating' } }]) expect(await reconcileStorageSessionOffline(phone, altered, f.deps)).toBe(false)
  expect(f.values.get(statusKey)).toBe('online')
})

test('leases are released on atomic publication failure and a newly appearing local client', async () => {
  const f = fixture(); f.redis.eval.mockRejectedValueOnce(new Error('unavailable'))
  await expect(reconcileStorageSessionOffline(phone, f.config, f.deps)).rejects.toThrow('unavailable')
  expect(f.lease.release).toHaveBeenCalledTimes(1)
  f.hasClient.mockReturnValueOnce(false).mockReturnValueOnce(true)
  expect(await reconcileStorageSessionOffline(phone, f.config, f.deps)).toBe(false)
  expect(f.lease.release).toHaveBeenCalledTimes(2)
})

test('invalid ownership/scope is rejected before Redis changes', async () => {
  const f = fixture()
  await expect(publishOwnedStorageOffline(f.redis, '../foreign', f.storage, f.ownership)).rejects.toThrow('phone_invalid')
  await expect(publishOwnedStorageOffline(f.redis, phone, f.storage, { ...f.ownership, key: 'unrelated' })).rejects.toThrow('confirmation_invalid')
  await expect(publishOwnedStorageOffline(f.redis, phone, { ...f.storage, state: 'active' }, f.ownership)).rejects.toThrow('confirmation_invalid')
  expect(f.redis.eval).not.toHaveBeenCalled()
})

test('subsequent session GET, dashboard list and Mobile Primary state all read the repaired canonical status without reconnect', async () => {
  const f = fixture(), sessionStore: any = { getStatus: async () => f.values.get(statusKey), getPhones: async () => [phone] }
  const config = { ...f.config, getStore: async () => ({ sessionStore, dataStore: { loadTemplates: async () => [] } }) }
  const controller = new PhoneNumberController(async () => config, sessionStore)
  const req: any = { method: 'GET', headers: {}, params: { phone }, query: {}, body: {} }
  const response = () => { const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }; return r }
  const first = response(); await controller.get(req, first); expect(first.json.mock.calls[0][0].status).toBe('online')
  await reconcileStorageSessionOffline(phone, f.config, f.deps)
  const single = response(); await controller.get(req, single); expect(single.json.mock.calls[0][0].status).toBe('offline')
  const dashboard = response(); await controller.list(req, dashboard); expect(dashboard.json.mock.calls[0][0].data[0].status).toBe('offline')
  const dispatch = jest.fn(), auth = jest.fn()
  const primary = new MobileConnectionService({ enabled: () => true, server: 'worker_1', draft: async () => ({ phone } as any), registration: async () => ({ status: 'registered', canonicalPhone: phone }), config: async () => config,
    saveConfig: jest.fn(), auth, status: async () => f.values.get(statusKey), dispatch, lease: () => ({ acquire: async () => false, renew: async () => false, release: async () => false }) })
  expect((await primary.status('draft')).status).toBe('offline'); expect(dispatch).not.toHaveBeenCalled(); expect(auth).not.toHaveBeenCalled()
})
