import { EventEmitter } from 'node:events'
import { proto } from 'zapo-js'
import { installBusinessDiagnosticFactory, observeBusinessPayload, safeBusinessNodeSummary, safeBusinessPayloadSummary } from '../../src/services/zapo/zapo_business_diagnostics'

describe('Business diagnostics', () => {
  const phone = '5566996222471'
  const input = (sessionId = phone, deviceBrowser = 'IPAD') => ({ base: { options: { sessionId, deviceBrowser } } })
  const create = () => ({
    nodeTransport: new EventEmitter(),
    authClient: {
      options: { devicePlatform: '1' },
      buildCommsConfig: jest.fn().mockResolvedValue({ noise: { registrationPayloadConfig: {} } }),
      pairingFlow: {
        opts: {},
        completePairSuccess: jest.fn().mockResolvedValue('paired'),
        buildPairSuccessResponseIdentity: jest.fn().mockResolvedValue({ signedIdentity: 'secret' }),
      },
    },
  })

  test('node and payload projections exclude arbitrary attributes, identifiers, keys and content', () => {
    const node = safeBusinessNodeSummary({ tag: 'iq', attrs: { id: 'secret', xmlns: 'secret', to: 'secret', code: '401' }, content: [{ tag: 'secret', attrs: { password: 'secret' }, content: 'secret' }] })
    const payload = safeBusinessPayloadSummary({ username: 123, userAgent: { platform: 10, device: 'secret', appVersion: { primary: 2, secondary: 3, tertiary: 4 } }, devicePairingData: { eIdent: 'secret', deviceProps: proto.DeviceProps.encode({ platformType: 16, os: 'secret' }).finish() } })
    expect(JSON.stringify({ node, payload })).not.toContain('secret')
    expect(payload.platform).toBe('SMB_ANDROID')
    expect(payload.deviceProps).toBe('ANDROID_PHONE')
    expect(node.code).toBe(401)
  })

  test('other phones and personal sessions are returned without observers or method wrappers', () => {
    const deps = create()
    const factory = { buildWaClientDependencies: jest.fn(() => deps) }
    const report = jest.fn()
    const original = deps.authClient.buildCommsConfig
    const restore = installBusinessDiagnosticFactory(factory, phone, Date.now() + 60_000, report)
    expect(factory.buildWaClientDependencies(input('5566996269251', 'android tablet'))).toBe(deps)
    expect(factory.buildWaClientDependencies(input(phone, 'android tablet'))).toBe(deps)
    expect(deps.authClient.buildCommsConfig).toBe(original)
    expect(deps.nodeTransport.listenerCount('node_in')).toBe(0)
    expect(report).not.toHaveBeenCalled()
    restore()
  })

  test('target observers preserve results, errors and config and never expose pair bytes', async () => {
    const deps = create()
    const originalIdentity = deps.authClient.pairingFlow.buildPairSuccessResponseIdentity
    const factory = { buildWaClientDependencies: jest.fn(() => deps) }
    const report = jest.fn()
    const restore = installBusinessDiagnosticFactory(factory, phone, Date.now() + 60_000, report)
    factory.buildWaClientDependencies(input())
    const config = await deps.authClient.buildCommsConfig()
    observeBusinessPayload(config.noise.registrationPayloadConfig, { userAgent: { platform: 10 }, webInfo: {} }, 'registration')
    deps.nodeTransport.emit('node_in', { tag: 'failure', attrs: { code: '401', secret: 'secret' } })
    const flow = deps.authClient.pairingFlow
    await expect(flow.completePairSuccess({}, { content: [{ tag: 'platform', attrs: { name: 'smba' } }] })).resolves.toBe('paired')
    const error = new Error('secret')
    originalIdentity.mockRejectedValueOnce(error)
    await expect(flow.buildPairSuccessResponseIdentity()).rejects.toBe(error)
    expect(report.mock.calls.map(([record]) => record.stage)).toEqual(expect.arrayContaining(['registration', 'pair_success_received', 'pair_success_completed', 'node_in']))
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret')
    restore()
  })

  test('expiration and budget stop output; logger failure cannot block the provider', () => {
    jest.useFakeTimers()
    try {
      const deps = create()
      const factory = { buildWaClientDependencies: jest.fn(() => deps) }
      const report = jest.fn(() => { throw new Error('logger failed') })
      const restore = installBusinessDiagnosticFactory(factory, phone, Date.now() + 60_000, report)
      expect(() => factory.buildWaClientDependencies(input())).not.toThrow()
      for (let i = 0; i < 205; i++) deps.nodeTransport.emit('node_out', {})
      expect(report).toHaveBeenCalledTimes(200)
      jest.advanceTimersByTime(61_000)
      deps.nodeTransport.emit('node_in', {})
      expect(report).toHaveBeenCalledTimes(200)
      restore()
    } finally { jest.useRealTimers() }
  })
})
