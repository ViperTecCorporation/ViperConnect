import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/services/config'
import { executePrimaryAuth, AUTHORIZE_PRIMARY_AUTH_SAVE_LUA } from '../../src/services/session_storage/primary_auth_rpc'
import { primaryStorageSelection } from '../../src/services/mobile_primary/primary_bootstrap'
import { storageWireDecode, storageWireEncode } from '../../src/services/session_storage/routing'

const phone = '999123456789', owner = 'primary_owner', draftId = '12345678-1234-4234-8234-123456789abc'
const savedEnv = { ...process.env }
const credentials = () => ({ meJid: `${phone}@s.whatsapp.net`, deviceInfo: { os: 'ios', business: true },
  noiseKeyPair: { pubKey: Buffer.alloc(32, 1), privKey: Buffer.alloc(32, 2) },
  registrationInfo: { registrationId: 1234, identityKeyPair: { pubKey: Buffer.alloc(32, 3), privKey: Buffer.alloc(32, 4) } },
  signedPreKey: { keyId: 7, signature: Buffer.alloc(64, 5), keyPair: { pubKey: Buffer.alloc(32, 6), privKey: Buffer.alloc(32, 7) } }, advSecretKey: Buffer.alloc(32, 8) } as any)

function fixture(backend: 'redis' | 'sqlite' = 'sqlite') {
  const storageId = randomUUID(), provisionId = randomUUID(), fence = { key: `unoapi-lease:zapo-session:${phone}`, token: randomUUID() }
  const config: any = { provider: 'zapo', server: owner, autoConnect: false, mobilePrimaryImported: false, mobilePrimaryDraftId: draftId,
    ...(backend === 'sqlite' ? { sessionStorage: { backend, storageId, owner, generation: 1, state: 'active' } } : {}),
    sessionStorageProvisioned: { id: provisionId, backend, owner, generation: backend === 'sqlite' ? 1 : 0, ...(backend === 'sqlite' ? { storageId } : {}) } }
  const mutation = { draftId, fence, selection: primaryStorageSelection(config, draftId) }
  let current: any = null
  const values = new Map<string, string>([[`unoapi-config:${phone}`, JSON.stringify(config)], [fence.key, fence.token]])
  const store = { load: jest.fn(async () => current), save: jest.fn(async value => { current = value }), clear: jest.fn() }
  const redis: any = { get: jest.fn(async (key: string) => values.get(key) || null),
    eval: jest.fn(async (script: string, input: any) => {
      expect(script).toBe(AUTHORIZE_PRIMARY_AUTH_SAVE_LUA)
      return values.get(input.keys[0]) === input.arguments[0] && values.get(input.keys[1]) === input.arguments[1] && !values.has(input.keys[2]) ? 1 : 0
    }) }
  const hasClient = jest.fn(() => false), auth = jest.fn(() => store)
  return { config: config as Config, mutation, values, store, redis, hasClient, auth, current: () => current,
    setCurrent: (value: any) => { current = value },
    run: (operation = 'primary.auth.save', args: any[] = [credentials(), mutation]) => executePrimaryAuth(phone, config, operation, args, { redis, hasClient, auth }) }
}

beforeEach(() => { process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_STORAGE_WORKER_ID = owner; delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY })
afterEach(() => { process.env = { ...savedEnv } })

test.each(['redis', 'sqlite'] as const)('private owner RPC writes new %s auth only under a current paused bootstrap/socket lease', async backend => {
  const f = fixture(backend), args = storageWireDecode(storageWireEncode([credentials(), f.mutation]))
  await expect(f.run('primary.auth.save', args)).resolves.toEqual({ saved: true })
  expect(f.store.save).toHaveBeenCalledTimes(1); expect(f.current().noiseKeyPair.pubKey).toEqual(Buffer.alloc(32, 1))
  expect(f.redis.eval).toHaveBeenCalledTimes(3)
  expect(JSON.parse(f.values.get(`unoapi-config:${phone}`)!).autoConnect).toBe(false)
  expect(f.store.clear).not.toHaveBeenCalled()
})

test('auth load is read-only and never causes an implicit import or lease acquisition', async () => {
  const f = fixture(); f.setCurrent(credentials())
  await expect(f.run('primary.auth.load', [])).resolves.toEqual(credentials())
  expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.store.save).not.toHaveBeenCalled()
})

test.each(['web', 'broker'])('non-owner %s process cannot open auth even with a valid-looking fence', async role => {
  const f = fixture(); process.env.UNOAPI_PROCESS_ROLE = role
  await expect(f.run()).rejects.toThrow('wrong_owner'); expect(f.auth).not.toHaveBeenCalled()
})

test('foreign worker, pending storage selection and fixture imports fail before native access', async () => {
  const foreign = fixture(); process.env.UNOAPI_STORAGE_WORKER_ID = 'other'
  await expect(foreign.run()).rejects.toThrow('wrong_owner'); expect(foreign.auth).not.toHaveBeenCalled()
  process.env.UNOAPI_STORAGE_WORKER_ID = owner
  const pending = fixture(); pending.values.set(`unoapi-config:${phone}`, JSON.stringify({ ...pending.config, sessionStorageProvisionPending: { id: randomUUID(), autoConnect: false } }))
  await expect(pending.run()).rejects.toThrow('provision_unconfirmed'); expect(pending.store.save).not.toHaveBeenCalled()
  const synthetic = fixture(); synthetic.config.sessionStorage!.fixture = true
  await expect(synthetic.run()).rejects.toThrow('fixture_external_effects_forbidden'); expect(synthetic.auth).not.toHaveBeenCalled()
})

test.each(['missing', 'stale', 'task'])('a %s socket ownership fence never imports native credentials', async kind => {
  const f = fixture()
  if (kind === 'missing') f.values.delete(f.mutation.fence.key)
  if (kind === 'stale') f.values.set(f.mutation.fence.key, randomUUID())
  if (kind === 'task') f.values.set(`unoapi-session-storage:task:lock:${phone}`, 'another-task')
  await expect(f.run()).rejects.toThrow('auth_lease_lost'); expect(f.auth).not.toHaveBeenCalled(); expect(f.store.save).not.toHaveBeenCalled()
})

test.each(['autoConnect', 'imported', 'deleting', 'client'])('a %s session refuses all auth writes', async kind => {
  const f = fixture(), current = { ...f.config }
  if (kind === 'autoConnect') current.autoConnect = true
  if (kind === 'imported') current.mobilePrimaryImported = true
  if (kind === 'deleting') current.mobilePrimaryDeleting = true
  if (kind === 'client') f.hasClient.mockReturnValue(true)
  f.values.set(`unoapi-config:${phone}`, JSON.stringify(current))
  await expect(f.run()).rejects.toThrow('requires_paused'); expect(f.store.save).not.toHaveBeenCalled()
})

test('lost save reply is retried idempotently without overwriting evolved signed prekeys', async () => {
  const f = fixture(); await f.run()
  const evolved = { ...f.current(), meLid: '123456789@lid', signedPreKey: { ...f.current().signedPreKey, keyId: 99, signature: Buffer.alloc(64, 9) } }
  f.setCurrent(evolved)
  await expect(f.run()).resolves.toEqual({ saved: false, alreadyPresent: true })
  expect(f.store.save).toHaveBeenCalledTimes(1); expect(f.current()).toBe(evolved)
})

test('already present different identity is never overwritten or cleared', async () => {
  const f = fixture(); f.setCurrent({ ...credentials(), advSecretKey: Buffer.alloc(32, 99) })
  await expect(f.run()).rejects.toThrow('auth_conflict'); expect(f.store.save).not.toHaveBeenCalled(); expect(f.store.clear).not.toHaveBeenCalled()
})

test('expired lease or concurrent generation edit while loading aborts before native save', async () => {
  for (const action of ['expired', 'generation']) {
    const f = fixture()
    f.store.load.mockImplementationOnce(async () => {
      if (action === 'expired') f.values.delete(f.mutation.fence.key)
      else f.values.set(`unoapi-config:${phone}`, JSON.stringify({ ...f.config, sessionStorage: { ...f.config.sessionStorage, generation: 2 } }))
      return null
    })
    await expect(f.run()).rejects.toThrow(action === 'expired' ? 'auth_lease_lost' : 'provision_unconfirmed')
    expect(f.store.save).not.toHaveBeenCalled()
  }
})

test('ambiguous native save with lost ownership stays unconfirmed and paused, never enabling a socket', async () => {
  const f = fixture()
  f.store.save.mockImplementationOnce(async () => { f.values.delete(f.mutation.fence.key) })
  await expect(f.run()).rejects.toThrow('auth_lease_lost')
  const current = JSON.parse(f.values.get(`unoapi-config:${phone}`)!)
  expect(current.autoConnect).toBe(false); expect(current.mobilePrimaryImported).toBe(false)
})

test('malformed credentials, foreign namespace and missing mutation fail explicitly', async () => {
  const f = fixture()
  for (const args of [[credentials()], [credentials(), null], [{ ...credentials(), meJid: '999987654321@s.whatsapp.net' }, f.mutation],
    [{ ...credentials(), advSecretKey: Buffer.alloc(1) }, f.mutation], [credentials(), { ...f.mutation, fence: { ...f.mutation.fence, key: `unoapi-lease:zapo-session:999987654321` } }]]) {
    await expect(f.run('primary.auth.save', args)).rejects.toThrow()
  }
  expect(f.store.save).not.toHaveBeenCalled()
})
