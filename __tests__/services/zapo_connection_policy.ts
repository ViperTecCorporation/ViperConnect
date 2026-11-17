import { createStore, WaClient } from 'zapo-js'
import { normalizeZapoWebVersion, resolveZapoConnectionPolicy, VIPERCONNECT_ZAPO_CONNECTION_POLICY } from '../../src/services/zapo/zapo_connection_policy'

describe('ViperConnect-owned Zapo connection policy', () => {
  test.each([undefined, null, '', '  '])('empty override inherits: %j', value => {
    expect(normalizeZapoWebVersion(value)).toBe('')
    expect(resolveZapoConnectionPolicy(false, value, '')).toEqual(VIPERCONNECT_ZAPO_CONNECTION_POLICY)
  })

  test.each(['2.3000.1054816457', '2.3.4.5', '2.3.4.5.6', '4294967295.0.1'])('accepts a numeric Web version: %s', version => {
    expect(normalizeZapoWebVersion(' ' + version + ' ')).toBe(version)
  })

  test.each([true, 123, [], {}, 'auto', 'https://example.invalid', '2.3', '2.3.4.5.6.7', '2.-3.4', '2.3.x', '2.3.4294967296', '2.3.9007199254740993', '0'.repeat(55) + '.2.3'])(
    'rejects an invalid override without falling back: %j', value => {
      expect(() => normalizeZapoWebVersion(value)).toThrow('zapo_web_version_invalid')
      expect(() => resolveZapoConnectionPolicy(false, value, '2.3000.123')).toThrow('zapo_web_version_invalid')
    })

  test('session wins over worker ENV; empty session inherits ENV and empty ENV inherits code', () => {
    expect(resolveZapoConnectionPolicy(false, '2.3000.123', '2.3000.456')).toEqual({ version: '2.3000.123', recoverFromClientTooOld: true })
    expect(resolveZapoConnectionPolicy(false, '', '2.3000.456').version).toBe('2.3000.456')
    expect(resolveZapoConnectionPolicy(false, undefined, '').version).toBe(VIPERCONNECT_ZAPO_CONNECTION_POLICY.version)
  })

  test('invalid worker ENV fails explicitly, but is irrelevant for an explicit valid session', () => {
    expect(() => resolveZapoConnectionPolicy(false, '', 'invalid')).toThrow('zapo_web_version_invalid')
    expect(resolveZapoConnectionPolicy(false, '2.3000.123', 'invalid').version).toBe('2.3000.123')
  })

  test('mobile retains its native policy without Web/Android auto-version overrides', () => {
    expect(resolveZapoConnectionPolicy(true, 'invalid', [])).toEqual({ recoverFromClientTooOld: false })
  })

  test('starts with the verified Web version and enables SDK recovery', () => {
    expect(VIPERCONNECT_ZAPO_CONNECTION_POLICY).toEqual({ version: '2.3000.1054816457', recoverFromClientTooOld: true })
    expect(Object.isFrozen(VIPERCONNECT_ZAPO_CONNECTION_POLICY)).toBe(true)
  })

  test('the actual SDK fetches a version and reconnects on 405 despite an explicit version', async () => {
    const store = createStore()
    const logger = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => logger }
    const client = new WaClient({ store, sessionId: 'synthetic-no-credentials', ...VIPERCONNECT_ZAPO_CONNECTION_POLICY }, logger)
    const connect = jest.spyOn(client, 'connect').mockResolvedValue(undefined)
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, text: async () => '{"client_revision":1054999999}' } as Response)
    try {
      client.emit('connection', { status: 'close', reason: 'failure_client_too_old', code: 405, isLogout: false })
      for (let turn = 0; turn < 30; turn++) await Promise.resolve()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(connect).toHaveBeenCalledTimes(1)
      expect((client as any).deps.authClient.versionOverride).toBe('2.3000.1054999999')
      expect((client as any).options.version).toBe('2.3000.1054816457')
    } finally {
      fetch.mockRestore()
      connect.mockRestore()
      await store.destroy()
    }
  })
})
