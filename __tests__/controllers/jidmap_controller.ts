jest.mock('../../src/defaults', () => ({ ...jest.requireActual('../../src/defaults'), get JIDMAP_LIST_ENABLED() { return mockEnabled } }))
jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', redisKeys: jest.fn(), redisGet: jest.fn(), getPnForLid: jest.fn(), getLidForPn: jest.fn() }))
import { JidMapController } from '../../src/controllers/jidmap_controller'
import { redisKeys, redisGet, getPnForLid } from '../../src/services/redis'
import { SendError } from '../../src/services/send_error'
import { SessionStorageError } from '../../src/services/session_storage/types'

let mockEnabled = true
const phone = '999123456789', controller = new JidMapController()
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any)
beforeEach(() => { mockEnabled = true; jest.resetAllMocks(); jest.mocked(redisKeys).mockResolvedValue([]) })

test.each(['pn_for_lid', 'lid_for_pn', 'pn', 'lid'])('a missing %s value is a cache miss, not an unavailable backend', async side => {
  const key = `unoapi-jidmap:${phone}:${side}:123@lid`
  jest.mocked(redisKeys).mockImplementation(async pattern => pattern === `unoapi-jidmap:${phone}:${side}:*` ? [key] : [])
  jest.mocked(redisGet).mockResolvedValue(null)
  const res = response(); await controller.list({ params: { phone }, query: {} } as any, res)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ mappings: { pn_for_lid: [], lid_for_pn: [] } }))
  expect(res.status).not.toHaveBeenCalledWith(expect.any(Number))
})

test.each(['pn_for_lid', 'lid_for_pn', 'pn', 'lid'])('a %s owner RPC failure cannot masquerade as a successful partial map', async side => {
  jest.mocked(redisKeys).mockImplementation(async pattern => pattern === `unoapi-jidmap:${phone}:${side}:*` ? [`unoapi-jidmap:${phone}:${side}:123@lid`] : [])
  jest.mocked(redisGet).mockRejectedValue(new SendError(409, 'session_storage_generation_changed'))
  const res = response(); await controller.list({ params: { phone }, query: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(res.json).toHaveBeenCalledWith({ error: 'session_storage_generation_changed' })
  expect(res.json.mock.calls.some(([value]: any[]) => !!value.mappings)).toBe(false)
})

test.each([new SessionStorageError(503, 'session_storage_file_missing'), new Error('private diagnostic')])('listing errors remain explicit and sanitized: %s', async error => {
  jest.mocked(redisKeys).mockRejectedValue(error)
  const res = response(); await controller.list({ params: { phone }, query: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(503)
  expect(res.json).toHaveBeenCalledWith({ error: error instanceof SessionStorageError ? error.code : 'jidmap_unavailable' })
})

test('lookup preserves a storage fence rather than returning a false missing mapping', async () => {
  jest.mocked(getPnForLid).mockRejectedValue(new SendError(409, 'session_storage_operation_in_progress'))
  const res = response(); await controller.lookup({ params: { phone, contact: '123@lid' } } as any, res)
  expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith({ error: 'session_storage_operation_in_progress' })
})

test('disabled listing never accesses storage', async () => {
  mockEnabled = false
  const res = response(); await controller.list({ params: { phone }, query: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(403); expect(redisKeys).not.toHaveBeenCalled()
})
