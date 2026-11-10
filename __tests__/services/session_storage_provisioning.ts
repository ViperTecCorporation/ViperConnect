jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
import { getRedis } from '../../src/services/redis'
import { createProvisionPending, assertProvisionPending, confirmedProvisionReceipt, recordProvisionReceipt,
  confirmSessionStorageProvision, RECORD_PROVISION_LUA, CONFIRM_PROVISION_LUA } from '../../src/services/session_storage/provisioning'

const phone = '9990100000782', owner = 'worker_1'
let config: any, raw: string, redis: any
beforeEach(() => {
  config = { provider: 'zapo', server: owner, autoConnect: false, sessionStorageProvisionPending: createProvisionPending(true) }
  raw = JSON.stringify(config)
  redis = { get: jest.fn(async () => raw), eval: jest.fn(async (script, options) => {
    if (raw !== options.arguments[0]) return 0
    const saved = JSON.parse(raw)
    if (script === RECORD_PROVISION_LUA) saved.sessionStorageProvisioned = JSON.parse(options.arguments[3])
    else if (script === CONFIRM_PROVISION_LUA) { saved.autoConnect = saved.sessionStorageProvisionPending.autoConnect; saved.sessionStorageProvisionPending = null }
    else throw new Error('unexpected_script')
    raw = JSON.stringify(saved); return 1
  }) }
  jest.mocked(getRedis).mockResolvedValue(redis)
})
const receipt = (backend: 'redis' | 'sqlite') => ({ id: config.sessionStorageProvisionPending.id, backend, owner, generation: backend === 'sqlite' ? 1 : 0,
  ...(backend === 'sqlite' ? { storageId: config.sessionStorageProvisionPending.id } : {}) })
const sqlite = () => ({ backend: 'sqlite', storageId: config.sessionStorageProvisionPending.id, owner, generation: 1, state: 'offline' })

test('new markers have safe independent identities and require boolean connection intent', () => {
  expect(config.sessionStorageProvisionPending.id).toMatch(/^[a-f\d-]{36}$/)
  expect(createProvisionPending(false).id).not.toBe(config.sessionStorageProvisionPending.id)
  expect(() => createProvisionPending('true' as any)).toThrow('auto_connect_invalid')
})

test.each(['wrong_attempt', 'wrong_owner', 'enabled', 'fixture', 'deleting', 'migrating'])('pending guard rejects %s without accepting another transition', kind => {
  if (kind === 'enabled') config.autoConnect = true
  if (kind === 'fixture') config.sessionStorage = { ...sqlite(), fixture: true }
  if (kind === 'deleting') config.mobilePrimaryDeleting = true
  if (kind === 'migrating') config.sessionStorage = { ...sqlite(), state: 'migrating' }
  expect(() => assertProvisionPending(config, kind === 'wrong_attempt' ? createProvisionPending(false).id : config.sessionStorageProvisionPending.id,
    kind === 'wrong_owner' ? 'another_owner' : owner)).toThrow('provision_changed')
})

test.each(['redis', 'sqlite'] as const)('recorded %s receipt does not activate until final exact-config CAS', async backend => {
  if (backend === 'sqlite') config.sessionStorage = sqlite()
  raw = JSON.stringify(config)
  const proof = receipt(backend)
  await expect(recordProvisionReceipt(phone, raw, proof)).resolves.toEqual(proof)
  expect(JSON.parse(raw).autoConnect).toBe(false)
  await expect(confirmSessionStorageProvision(phone, proof.id, owner, backend)).resolves.toEqual(proof)
  expect(JSON.parse(raw)).toMatchObject({ autoConnect: true, sessionStorageProvisionPending: null, sessionStorageProvisioned: proof })
  await expect(confirmSessionStorageProvision(phone, proof.id, owner)).resolves.toEqual(proof)
})

test.each(['backend', 'storage_id', 'generation', 'descriptor', 'attempt'])('receipt never confirms a mismatched %s', kind => {
  config.sessionStorage = sqlite(); config.sessionStorageProvisioned = receipt('sqlite')
  if (kind === 'backend') config.sessionStorageProvisioned.backend = 'redis'
  if (kind === 'storage_id') config.sessionStorageProvisioned.storageId = createProvisionPending(false).id
  if (kind === 'generation') config.sessionStorageProvisioned.generation++
  if (kind === 'descriptor') config.sessionStorage.generation = 0
  if (kind === 'attempt') config.sessionStorageProvisioned.id = createProvisionPending(false).id
  expect(() => confirmedProvisionReceipt(config, config.sessionStorageProvisionPending.id, owner)).toThrow('provision_unconfirmed')
})

test('a stale or missing raw configuration is not adopted after a lost completion reply', async () => {
  const proof = receipt('redis'); config.sessionStorageProvisioned = proof; raw = JSON.stringify(config)
  redis.eval.mockImplementationOnce(async () => { raw = JSON.stringify({ ...config, label: 'concurrent' }); return 0 })
  await expect(confirmSessionStorageProvision(phone, proof.id, owner)).rejects.toThrow('provision_changed')
  expect(JSON.parse(raw).autoConnect).toBe(false)
  redis.get.mockResolvedValueOnce(null)
  await expect(confirmSessionStorageProvision(phone, proof.id, owner)).rejects.toThrow('provision_unconfirmed')
})

test('Primary storage confirmation preserves its false intent before auth import', async () => {
  config.mobilePrimaryDraftId = 'draft'; config.sessionStorageProvisionPending.autoConnect = false
  const proof = receipt('redis'); config.sessionStorageProvisioned = proof; raw = JSON.stringify(config)
  await confirmSessionStorageProvision(phone, proof.id, owner)
  expect(JSON.parse(raw)).toMatchObject({ autoConnect: false, sessionStorageProvisionPending: null })
})
