import { companionNodeShape, companionQrShape, observeCompanionQuery, safeProviderReason } from '../../src/services/mobile_primary/companion_trace'

test.each([32, 33])('QR shape counts %i-byte public keys without leaking fields', (size) => {
  const publicKey = Buffer.alloc(size, 7).toString('base64')
  const secret = Buffer.alloc(32, 8).toString('base64')
  const output = companionQrShape(`SECRET,reference,${publicKey},${publicKey},${secret},PRIVATE_PLATFORM`)
  expect(output).toEqual({ parts: 6, referenceBytes: 16, noiseKeyBytes: size, identityKeyBytes: size, advSecretBytes: 32, platformPresent: true })
  for (const value of ['SECRET', publicKey, secret, 'PRIVATE_PLATFORM']) expect(JSON.stringify(output)).not.toContain(value)
})

test('QR shape tolerates missing fields', () => {
  expect(companionQrShape('')).toEqual({ parts: 1, referenceBytes: 0, noiseKeyBytes: 0, identityKeyBytes: 0, advSecretBytes: 0, platformPresent: false })
})

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
