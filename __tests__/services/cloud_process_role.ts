import { resolveCloudProcessRole } from '../../src/services/providers/cloud_process_role'

describe('cloud process role', () => {
  test('keeps the legacy all-in-one role as default', () => {
    expect(resolveCloudProcessRole(undefined)).toBe('all')
  })

  test.each(['web', 'broker', 'worker'] as const)('accepts the isolated %s role', (role) => {
    expect(resolveCloudProcessRole(` ${role.toUpperCase()} `)).toBe(role)
  })

  test('rejects unknown roles before importing application processes', () => {
    expect(() => resolveCloudProcessRole('database')).toThrow('Invalid UNOAPI_PROCESS_ROLE')
  })
})
