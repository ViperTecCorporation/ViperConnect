import { booleanEnv } from '../../src/defaults'

describe('defaults boolean parser', () => {
  const key = 'UNOAPI_TEST_BOOLEAN_ENV'

  afterEach(() => delete process.env[key])

  test('uses fallback only when the environment value is absent', () => {
    delete process.env[key]
    expect(booleanEnv(key, true)).toBe(true)
    expect(booleanEnv(key, false)).toBe(false)
  })

  test('does not invert explicit true and false values', () => {
    process.env[key] = 'true'
    expect(booleanEnv(key, false)).toBe(true)
    process.env[key] = 'false'
    expect(booleanEnv(key, true)).toBe(false)
  })
})
