import { validateLiveIdMappings } from '../../src/services/session_storage/id_validation'
test('validates both live ID directions with expiry boundaries rather than counting historical rows', () => {
  const database = { get: jest.fn((_sql: string, _parameters: unknown[]) => ({ n: 0 })) }
  expect(validateLiveIdMappings(database, '999123456789', 1000)).toBe(true)
  expect(database.get).toHaveBeenCalledTimes(2)
  expect(database.get.mock.calls[0][0]).toContain('f.expires_at>?')
  const forward = 'unoapi-id:999123456789:'
  expect(database.get.mock.calls[0][1]).toEqual(['unoapi-id_rev:999123456789:', forward.length, forward, 1000, 1000, forward.length + 1])
  database.get.mockReset().mockReturnValueOnce({ n: 0 }).mockReturnValueOnce({ n: 1 })
  expect(validateLiveIdMappings(database, '999123456789')).toBe(false)
})
