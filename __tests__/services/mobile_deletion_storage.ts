import { clearMobileDeletionStorage } from '../../src/services/mobile_primary/deletion_runtime'

const setup = () => ({ unlinkSqlite: jest.fn(async () => {}), clearLegacy: jest.fn(async () => {}), deleteConfig: jest.fn(async () => {}), clearTransient: jest.fn(async () => {}), clearStatus: jest.fn(async () => {}) })

test('SQLite mobile deletion uses owner unlink only and retains config until the final CAS', async () => {
  const deps = setup(), config = { sessionStorage: { backend: 'sqlite' }, mobilePrimaryDraftId: 'draft' }
  await clearMobileDeletionStorage('999123456789', config, deps)
  expect(deps.unlinkSqlite).toHaveBeenCalledWith('999123456789', config)
  expect(deps.clearLegacy).not.toHaveBeenCalled(); expect(deps.deleteConfig).not.toHaveBeenCalled()
  expect(deps.clearTransient).toHaveBeenCalledTimes(1); expect(deps.clearStatus).toHaveBeenCalledTimes(1)
})

test('legacy deletion preserves its existing cleanup order and never dispatches a SQLite command', async () => {
  const deps = setup(), config = { useRedis: true }
  await clearMobileDeletionStorage('999123456789', config, deps)
  expect(deps.clearLegacy).toHaveBeenCalledWith('999123456789', config); expect(deps.unlinkSqlite).not.toHaveBeenCalled()
  expect(deps.clearLegacy.mock.invocationCallOrder[0]).toBeLessThan(deps.deleteConfig.mock.invocationCallOrder[0])
  expect(deps.deleteConfig.mock.invocationCallOrder[0]).toBeLessThan(deps.clearTransient.mock.invocationCallOrder[0])
})

test('owner cleanup failure preserves config, transient state and status for explicit recovery', async () => {
  const deps = setup(); deps.unlinkSqlite.mockRejectedValue(new Error('worker unavailable'))
  await expect(clearMobileDeletionStorage('999123456789', { sessionStorage: { backend: 'sqlite' } }, deps)).rejects.toThrow('worker unavailable')
  expect(deps.deleteConfig).not.toHaveBeenCalled(); expect(deps.clearTransient).not.toHaveBeenCalled(); expect(deps.clearStatus).not.toHaveBeenCalled()
})
