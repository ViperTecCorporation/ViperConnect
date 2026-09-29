import { companionNodeShape, observeCompanionQuery, safeProviderReason } from '../../src/services/mobile_primary/companion_trace'

test('structure never exposes QR, keys, attributes, or arbitrary error text', () => {
  const output = companionNodeShape({ tag: 'iq', attrs: { id: 'SECRET', SECRET: 'SECRET' }, content: [
    { tag: 'ref', attrs: {}, content: 'SECRET' },
    { tag: 'pub-key', content: Buffer.from('SECRET') },
    { tag: 'error', attrs: { code: '400', text: 'SECRET' } },
    { tag: 'SECRET', content: [] },
  ] })
  expect(JSON.stringify(output)).not.toContain('SECRET')
  expect(JSON.stringify(output)).toContain('400')
  expect(safeProviderReason('bad-request')).toBe('bad-request')
  expect(safeProviderReason('bad-request SECRET')).toBe('redacted')
  expect(companionNodeShape({}, 5)).toEqual({ truncated: true })
})
test('observer preserves request, response, this binding and restores method', async () => {
  const response = { tag: 'iq', attrs: { type: 'result' } }
  const mobile = { queryWithContext: jest.fn(function (this: any) { expect(this).toBe(mobile); return Promise.resolve(response) }) }
  const original = mobile.queryWithContext, log = jest.fn()
  const stop = observeCompanionQuery(mobile, log)
  const request = { tag: 'iq' }
  expect(await (mobile.queryWithContext as any)('companion-host.pair-device', request, 32000)).toBe(response)
  expect(original).toHaveBeenCalledWith('companion-host.pair-device', request, 32000)
  expect(log).toHaveBeenCalledTimes(2)
  await (mobile.queryWithContext as any)('unrelated', request)
  expect(log).toHaveBeenCalledTimes(2)
  stop(); expect(mobile.queryWithContext).toBe(original)
})
test('observer preserves original rejection and tolerates logger failure', async () => {
  const failure = new Error('SECRET')
  const mobile = { queryWithContext: jest.fn().mockRejectedValue(failure) }
  const stop = observeCompanionQuery(mobile, () => { throw new Error('logger') })
  await expect(mobile.queryWithContext('companion-host.pair-device', {})).rejects.toBe(failure)
  stop()
  const log = jest.fn(); observeCompanionQuery({}, log)()
  expect(log).toHaveBeenCalledWith('MOBILE_COMPANION_TRACE_UNAVAILABLE', {})
})
