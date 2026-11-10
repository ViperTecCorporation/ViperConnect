jest.mock('../../src/services/redis', () => ({ getConfig: jest.fn(), setConfig: jest.fn(), getRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))

import { mockDeep } from 'jest-mock-extended'
import type { Response } from 'express'
import { RegistrationController } from '../../src/controllers/registration_controller'
import { defaultConfig, configs } from '../../src/services/config'
import type { Reload } from '../../src/services/reload'
import { getConfig, setConfig, getRedis } from '../../src/services/redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { CONFIRM_PROVISION_LUA } from '../../src/services/session_storage/provisioning'

let saved: any, phone: string, sequence = 0, evalCas: jest.Mock
beforeEach(() => {
  jest.clearAllMocks(); configs.clear(); saved = undefined; phone = `9990100001${String(++sequence).padStart(3, '0')}`
  jest.mocked(getConfig).mockImplementation(async () => saved)
  jest.mocked(setConfig).mockImplementation(async (_phone, patch) => { saved = { ...saved, ...patch }; return saved })
  evalCas = jest.fn(async (script, options) => {
    expect(script).toBe(CONFIRM_PROVISION_LUA)
    if (JSON.stringify(saved) !== options.arguments[0]) return 0
    saved = { ...saved, autoConnect: saved.sessionStorageProvisionPending.autoConnect, sessionStorageProvisionPending: null }
    return 1
  })
  jest.mocked(getRedis).mockResolvedValue({ get: async () => saved ? JSON.stringify(saved) : null, eval: evalCas } as never)
})
afterEach(() => { configs.clear() })
const request = (body: any = {}) => ({ params: { phone }, body: { provider: 'zapo', connectionType: 'qrcode', autoConnect: true, ...body }, headers: {}, query: {} } as any)
function controller() {
  const reload = mockDeep<Reload>(), res = mockDeep<Response>()
  reload.run.mockResolvedValue(undefined)
  res.status.mockReturnValue(res); res.json.mockReturnValue(res)
  const service = new RegistrationController(async () => ({ ...defaultConfig, provider: 'zapo', ...saved }), reload, {} as never)
  return { service, reload, res }
}
function record(backend: 'redis' | 'sqlite', owner = saved.server) {
  const id = saved.sessionStorageProvisionPending.id
  if (backend === 'sqlite') saved.sessionStorage = { backend, storageId: id, owner, generation: 1, state: 'offline' }
  saved.sessionStorageProvisioned = { id, backend, owner, generation: backend === 'sqlite' ? 1 : 0,
    ...(backend === 'sqlite' ? { storageId: id } : {}) }
}

test.each(['redis', 'sqlite'] as const)('new QR respects an explicit owner and enables only a durable %s receipt', async backend => {
  jest.mocked(sessionStorageRpc).mockImplementation(async (_phone, config, operation, args) => {
    expect(config.server).toBe('worker_2'); expect(config.autoConnect).toBe(false); expect(operation).toBe('provision')
    expect(args).toEqual([{ provisionId: saved.sessionStorageProvisionPending.id }]); record(backend)
    return { backend } as never
  })
  const { service, reload, res } = controller()
  await service.register(request({ server: 'worker_2' }), res)
  expect(res.status).toHaveBeenCalledWith(200); expect(saved.server).toBe('worker_2')
  expect(saved.autoConnect).toBe(true); expect(saved.sessionStorageProvisionPending).toBeNull(); expect(reload.run).toHaveBeenCalledTimes(1)
})

test.each(['redis', 'sqlite'] as const)('lost %s provision reply is resolved from the exact persisted attempt receipt', async backend => {
  jest.mocked(sessionStorageRpc).mockImplementation(async () => { record(backend); throw new Error('lost_reply') })
  const { service, reload, res } = controller(); await service.register(request(), res)
  expect(res.status).toHaveBeenCalledWith(200); expect(saved.autoConnect).toBe(true); expect(reload.run).toHaveBeenCalledTimes(1)
})

test.each(['no_receipt', 'wrong_attempt', 'missing_sqlite', 'wrong_owner', 'reply_mismatch'])('ambiguous %s never enables or reloads the new session', async condition => {
  jest.mocked(sessionStorageRpc).mockImplementation(async () => {
    if (condition !== 'no_receipt') record('sqlite')
    if (condition === 'wrong_attempt') saved.sessionStorageProvisioned.id = '12345678-1234-4234-8234-123456789abc'
    if (condition === 'missing_sqlite') delete saved.sessionStorage
    if (condition === 'wrong_owner') saved.server = 'other_worker'
    return { backend: condition === 'reply_mismatch' ? 'redis' : 'sqlite' } as never
  })
  const { service, reload, res } = controller(); await service.register(request(), res)
  expect(res.status).toHaveBeenCalledWith(503); expect(saved.autoConnect).toBe(false); expect(saved.sessionStorageProvisionPending).toBeTruthy()
  expect(reload.run).not.toHaveBeenCalled()
})

test('config changing between receipt read and final CAS remains suspended', async () => {
  jest.mocked(sessionStorageRpc).mockImplementation(async () => { record('sqlite'); return { backend: 'sqlite' } as never })
  evalCas.mockImplementationOnce(async () => { saved.label = 'concurrent edit'; return 0 })
  const { service, reload, res } = controller(); await service.register(request(), res)
  expect(res.status).toHaveBeenCalledWith(503); expect(saved.autoConnect).toBe(false); expect(saved.label).toBe('concurrent edit')
  expect(saved.sessionStorageProvisionPending).toBeTruthy(); expect(reload.run).not.toHaveBeenCalled()
})

test('register retry keeps the same pending ID until the owner confirms its backend', async () => {
  let firstId: string
  jest.mocked(sessionStorageRpc).mockImplementationOnce(async () => { firstId = saved.sessionStorageProvisionPending.id; throw new Error('owner_unavailable') })
    .mockImplementationOnce(async (_phone, _config, _op, args) => { expect(args).toEqual([{ provisionId: firstId }]); record('sqlite'); return { backend: 'sqlite' } as never })
  const { service, reload, res } = controller(); await service.register(request(), res)
  expect(res.status).toHaveBeenCalledWith(503); expect(saved.autoConnect).toBe(false)
  const retry = mockDeep<Response>(); retry.status.mockReturnValue(retry); retry.json.mockReturnValue(retry)
  await service.register(request(), retry)
  expect(retry.status).toHaveBeenCalledWith(200); expect(saved.sessionStorageProvisioned.id).toBe(firstId!); expect(reload.run).toHaveBeenCalledTimes(1)
})

test('paused new SQLite registration can enable immediately; only a genuine duplicate is debounced', async () => {
  jest.mocked(sessionStorageRpc).mockImplementation(async () => { record('sqlite'); return { backend: 'sqlite' } as never })
  const { service, reload, res } = controller(), started = Date.now()
  await service.register(request({ autoConnect: false }), res)
  expect(res.status).toHaveBeenCalledWith(200); expect(saved.autoConnect).toBe(false); expect(reload.run).toHaveBeenCalledTimes(1)
  const next = mockDeep<Response>(); next.status.mockReturnValue(next); next.json.mockReturnValue(next)
  await service.register(request({ autoConnect: true }), next)
  expect(Date.now() - started).toBeLessThan(15000)
  expect(next.status).toHaveBeenCalledWith(200)
  expect(next.json.mock.calls[0][0].registerSuppressed).not.toBe(true)
  expect(saved.autoConnect).toBe(true); expect(reload.run).toHaveBeenCalledTimes(2)
  const duplicate = mockDeep<Response>(); duplicate.status.mockReturnValue(duplicate); duplicate.json.mockReturnValue(duplicate)
  await service.register(request({ autoConnect: true }), duplicate)
  expect(duplicate.status).toHaveBeenCalledWith(202); expect(duplicate.json.mock.calls[0][0].registerSuppressed).toBe(true)
  expect(reload.run).toHaveBeenCalledTimes(2)
})
