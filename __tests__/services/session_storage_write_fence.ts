import { configs } from '../../src/services/config'
import { getRedis } from '../../src/services/redis'
import { assertCurrentSqliteWriteSelection, assertFreshSqliteWriteSelection } from '../../src/services/session_storage/write_fence'
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
const phone = '999123456789'
let selected: any, oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => { oldEnvironment = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'fence_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID
  selected = { sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'fence_owner', generation: 1, state: 'active' } }; configs.set(phone, selected); jest.clearAllMocks() })
afterEach(() => { configs.delete(phone); process.env = oldEnvironment })
test('local SQL writes reject wrong owner/backend, transitions and any cached identity change', () => {
  expect(() => assertCurrentSqliteWriteSelection(phone, selected)).not.toThrow()
  expect(() => assertCurrentSqliteWriteSelection(phone, {} as any)).toThrow('sqlite_required')
  process.env.UNOAPI_PROCESS_ROLE = 'web'; expect(() => assertCurrentSqliteWriteSelection(phone, selected)).toThrow('wrong_owner')
  expect(() => assertCurrentSqliteWriteSelection(phone, selected, false)).not.toThrow(); process.env.UNOAPI_PROCESS_ROLE = 'worker'
  for (const patch of [{ state: 'migrating' }, { state: 'restoring' }, { generation: 2 }, { storageId: 'different' }, { owner: 'different' }, { backend: 'redis' }]) {
    configs.set(phone, { ...selected, sessionStorage: { ...selected.sessionStorage, ...patch } })
    expect(() => assertCurrentSqliteWriteSelection(phone, selected)).toThrow('session_storage_')
  }
})
test('nonfixture SQL preflight compares authoritative Redis config and rejects absence/corruption/control outages', async () => {
  const raw = { get: jest.fn().mockResolvedValue(JSON.stringify(selected)) }; (getRedis as jest.Mock).mockResolvedValue(raw)
  await expect(assertFreshSqliteWriteSelection(phone, selected)).resolves.toBeUndefined()
  for (const patch of [{ generation: 2 }, { state: 'restoring' }, { owner: 'different' }, { backend: 'redis' }]) {
    raw.get.mockResolvedValueOnce(JSON.stringify({ ...selected, sessionStorage: { ...selected.sessionStorage, ...patch } }))
    await expect(assertFreshSqliteWriteSelection(phone, selected)).rejects.toThrow('session_storage_')
  }
  raw.get.mockResolvedValueOnce(null); await expect(assertFreshSqliteWriteSelection(phone, selected)).rejects.toThrow('configuration_missing')
  for (const value of ['invalid', 'null', '[]']) { raw.get.mockResolvedValueOnce(value); await expect(assertFreshSqliteWriteSelection(phone, selected)).rejects.toThrow('configuration_invalid') }
  raw.get.mockRejectedValueOnce(Error('network details')); await expect(assertFreshSqliteWriteSelection(phone, selected)).rejects.toThrow('control_unavailable')
  expect(raw.get).toHaveBeenCalledWith(`unoapi-config:${phone}`)
})
test('fixtures remain fully synthetic and current config is rechecked after awaited control reads', async () => {
  await expect(assertFreshSqliteWriteSelection(phone, { ...selected, sessionStorage: { ...selected.sessionStorage, fixture: true } })).resolves.toBeUndefined()
  expect(getRedis).not.toHaveBeenCalled()
  ;(getRedis as jest.Mock).mockResolvedValue({ get: async () => { configs.set(phone, { ...selected, sessionStorage: { ...selected.sessionStorage, generation: 2 } }); return JSON.stringify(selected) } })
  await expect(assertFreshSqliteWriteSelection(phone, selected)).rejects.toThrow('generation_changed')
})
