import { randomUUID } from 'node:crypto'
import { createClient } from '@redis/client'
import { SESSION_EVENT_LUA, sessionEvent } from '../../src/services/session_webhook_store'
import { STORAGE_CAS_LUA } from '../../src/services/session_storage/catalog'
import { RECORD_PROVISION_LUA, CONFIRM_PROVISION_LUA } from '../../src/services/session_storage/provisioning'
import { STORAGE_OFFLINE_STATUS_LUA } from '../../src/services/session_storage/offline_status'

// Explicit opt-in; all data keys are unique test-owned keys. Never FLUSHDB,
// inspect customer configuration, subscribe to WhatsApp or open a client socket.
const url = process.env.SESSION_STORAGE_PROVISION_TEST_REDIS_URL
const integration = url && process.env.SESSION_STORAGE_PROVISION_TEST_CONFIRM === 'dev-isolated-keys' ? describe : describe.skip
integration('new-session storage Lua on real DEV Redis with isolated keys', () => {
  const redis = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } })
  const prefix = `unoapi-test:storage-provision:${randomUUID()}`
  const keys = ['destinations', 'states', 'outbox', 'heartbeat', 'config', 'index'].map(name => `${prefix}:${name}`)
  let owned = false
  const phone = '9990100000784', owner = 'worker_1'
  const read = async () => JSON.parse((await redis.get(keys[4]))!)
  const save = (config: any, expected: string | null) => redis.eval(SESSION_EVENT_LUA, { keys,
    arguments: ['save_config', phone, JSON.stringify(sessionEvent(phone, 'unavailable')), '', `${Date.now()}`, JSON.stringify(config), '-1', 'cas', expected || ''] })
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['127.0.0.1', 'localhost', 'redis'].includes(parsed.hostname)) throw new Error('dev_redis_host_required')
    await redis.connect()
    if (await redis.exists(keys)) throw new Error('test_keys_already_exist')
    owned = true
  })
  afterAll(async () => { if (redis.isOpen) { if (owned) await redis.del(keys); await redis.quit() } })
  beforeEach(async () => { if (!owned) throw new Error('test_keys_not_owned'); await redis.del(keys) })

  test('stale generic save cannot erase a catalog commit or repeat atomic registration enrollment', async () => {
    await redis.hSet(keys[0], 'destination', JSON.stringify({ id: 'destination', server: owner, auto_include_new_sessions: true, session_ids: [] }))
    const original = { provider: 'zapo', server: owner, autoConnect: false, sessionStorageProvisionPending: { id: randomUUID(), autoConnect: true } }
    expect(await save(original, null)).toBe(1)
    const staleRaw = (await redis.get(keys[4]))!, id = original.sessionStorageProvisionPending.id
    const next = { ...original, sessionStorage: { backend: 'sqlite', storageId: id, owner, generation: 1, state: 'offline' } }
    await redis.set(keys[4], JSON.stringify(next))
    expect(await save({ ...original, label: 'stale' }, staleRaw)).toBe(0)
    expect((await read()).sessionStorage).toEqual(next.sessionStorage)
    expect((await redis.sMembers(keys[5]))).toEqual([phone])
    expect(JSON.parse((await redis.hGet(keys[0], 'destination'))!).session_ids).toEqual([phone])
    const fresh = (await redis.get(keys[4]))!
    expect(await save({ ...next, label: 'fresh' }, fresh)).toBe(1)
    expect((await read()).label).toBe('fresh')
  })

  test('SQLite descriptor and receipt commit together, then only the matching attempt can enable connection', async () => {
    const id = randomUUID(), config = { provider: 'zapo', server: owner, autoConnect: false, sessionStorageProvisionPending: { id, autoConnect: true } }
    await redis.set(keys[4], JSON.stringify(config))
    const descriptor = { backend: 'sqlite', storageId: id, owner, generation: 1, state: 'offline' }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['0', 'redis', JSON.stringify(descriptor), '', '', '', phone, id] })).toBe(1)
    expect(await read()).toMatchObject({ autoConnect: false, sessionStorage: descriptor, sessionStorageProvisioned: { id, backend: 'sqlite', storageId: id, owner, generation: 1 } })
    const raw = (await redis.get(keys[4]))!
    expect(await redis.eval(CONFIRM_PROVISION_LUA, { keys: [keys[4]], arguments: [raw, randomUUID(), owner, phone] })).toBe(0)
    expect((await read()).autoConnect).toBe(false)
    expect(await redis.eval(CONFIRM_PROVISION_LUA, { keys: [keys[4]], arguments: [raw, id, owner, phone] })).toBe(1)
    expect(await read()).toMatchObject({ autoConnect: true, sessionStorageProvisionPending: null, sessionStorage: descriptor })
  })

  test('intentional Redis receipt is durable but cannot confirm across a concurrent config edit', async () => {
    const id = randomUUID(), config = { provider: 'zapo', server: owner, autoConnect: false, sessionStorageProvisionPending: { id, autoConnect: false } }
    const raw = JSON.stringify(config), receipt = { id, backend: 'redis', owner, generation: 0 }
    await redis.set(keys[4], raw)
    expect(await redis.eval(RECORD_PROVISION_LUA, { keys: [keys[4]], arguments: [raw, id, owner, JSON.stringify(receipt), phone] })).toBe(1)
    const recorded = (await redis.get(keys[4]))!
    await redis.set(keys[4], JSON.stringify({ ...await read(), label: 'concurrent' }))
    expect(await redis.eval(CONFIRM_PROVISION_LUA, { keys: [keys[4]], arguments: [recorded, id, owner, phone] })).toBe(0)
    const fresh = (await redis.get(keys[4]))!
    expect(await redis.eval(CONFIRM_PROVISION_LUA, { keys: [keys[4]], arguments: [fresh, id, owner, phone] })).toBe(1)
    expect(await read()).toMatchObject({ autoConnect: false, label: 'concurrent', sessionStorageProvisionPending: null, sessionStorageProvisioned: receipt })
  })

  test.each([
    { label: 'missing', server: undefined }, { label: 'null', server: null },
    { label: 'false', server: false }, { label: 'empty', server: '' },
    { label: 'zero', server: 0 }, { label: 'explicit', server: 'server_1' },
  ].flatMap(route => [false, true].map(existing => ({ ...route, existing }))))('catalog normalizes $label routing atomically, existing descriptor=$existing', async ({ server, existing }) => {
    const storageId = randomUUID(), task = randomUUID(), generation = existing ? 6 : 0
    const old = existing ? { backend: 'redis', state: 'offline', owner: 'server_1', storageId, generation } : undefined
    const original = { provider: 'zapo', server, autoConnect: false, label: 'preserved', sessionStorage: old }
    await redis.set(keys[4], JSON.stringify(original))
    const next = { backend: 'redis', state: 'migrating', owner: 'server_1', storageId, generation: generation + 1 }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: [String(generation), 'redis', JSON.stringify(next), '', task, 'false', phone, ''] })).toBe(1)
    expect(await read()).toEqual({ ...JSON.parse(JSON.stringify(original)), server: 'server_1', sessionStorage: next, sessionStorageTaskId: task })
  })

  test('canonical server persists through offline confirmation, rollback and successful SQLite cutover', async () => {
    const storageId = randomUUID(), task = randomUUID(), token = randomUUID()
    await redis.set(keys[4], JSON.stringify({ provider: 'zapo', autoConnect: false, label: 'legacy',
      sessionStorage: { backend: 'redis', storageId, owner: 'server_1', generation: 6, state: 'offline' } }))
    const prepared = { backend: 'redis', storageId, owner: 'server_1', generation: 7, state: 'migrating' }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['6', 'redis', JSON.stringify(prepared), '', task, 'false', phone, ''] })).toBe(1)
    await redis.set(keys[0], 'online'); await redis.set(keys[1], token)
    expect(await redis.eval(STORAGE_OFFLINE_STATUS_LUA, { keys: [keys[4], keys[0], keys[1]], arguments: [token, 'server_1', storageId, '7', 'redis', 'migrating', task, phone, '0'] })).toBe(1)
    expect(await redis.get(keys[0])).toBe('offline')
    const offline = { ...prepared, generation: 8, state: 'offline' }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['7', 'redis', JSON.stringify(offline), task, '', 'false', phone, ''] })).toBe(1)
    expect(await read()).toMatchObject({ server: 'server_1', label: 'legacy', autoConnect: false, sessionStorage: offline })
    expect((await read()).sessionStorageTaskId).toBeUndefined()
    const retry = { ...prepared, generation: 9 }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['8', 'redis', JSON.stringify(retry), '', task, 'false', phone, ''] })).toBe(1)
    const committed = { ...retry, backend: 'sqlite', generation: 10, state: 'offline' }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['9', 'redis', JSON.stringify(committed), task, '', 'false', phone, ''] })).toBe(1)
    expect(await read()).toMatchObject({ server: 'server_1', autoConnect: false, sessionStorage: committed })
  })

  test.each(['generation', 'backend', 'task', 'server', 'descriptor-owner', 'legacy-owner'])('conflicting %s remains unchanged, without canonicalizing the raw config', async conflict => {
    const storageId = randomUUID(), task = randomUUID(), original: any = { provider: 'zapo', autoConnect: false, sessionStorageTaskId: task,
      sessionStorage: { backend: 'redis', storageId, owner: 'server_1', generation: 6, state: 'offline' } }
    if (conflict === 'generation') original.sessionStorage.generation = 8
    if (conflict === 'backend') original.sessionStorage.backend = 'sqlite'
    if (conflict === 'task') original.sessionStorageTaskId = randomUUID()
    if (conflict === 'server') original.server = 'server_2'
    if (conflict === 'descriptor-owner' || conflict === 'legacy-owner') original.sessionStorage.owner = 'server_2'
    const raw = JSON.stringify(original); await redis.set(keys[4], raw)
    const next = { ...original.sessionStorage, backend: 'redis', generation: 7, state: 'migrating', owner: conflict === 'legacy-owner' ? 'server_2' : 'server_1' }
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['6', 'redis', JSON.stringify(next), task, task, 'false', phone, ''] })).toBe(0)
    expect(await redis.get(keys[4])).toBe(raw)
  })

  test('an explicit matching nondefault worker stays unchanged, and a missing route cannot provision it', async () => {
    const id = randomUUID(), task = randomUUID(), next = { backend: 'sqlite', storageId: id, owner: 'server_2', generation: 1, state: 'offline' }
    const original: any = { provider: 'zapo', server: 'server_2', autoConnect: false, sessionStorageProvisionPending: { id, autoConnect: true } }
    await redis.set(keys[4], JSON.stringify(original))
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['0', 'redis', JSON.stringify(next), '', '', '', phone, id] })).toBe(1)
    expect(await read()).toMatchObject({ server: 'server_2', sessionStorage: next, sessionStorageProvisioned: { id, owner: 'server_2' } })
    delete original.server; const raw = JSON.stringify(original); await redis.set(keys[4], raw)
    expect(await redis.eval(STORAGE_CAS_LUA, { keys: [keys[4]], arguments: ['0', 'redis', JSON.stringify(next), '', task, 'false', phone, id] })).toBe(0)
    expect(await redis.get(keys[4])).toBe(raw)
    expect((await read()).sessionStorageProvisioned).toBeUndefined()
  })
})
