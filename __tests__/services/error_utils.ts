import { isTransientExternalIoError, isTransientInfraError } from '../../src/services/error_utils'

describe('isTransientInfraError', () => {
  it('returns true for transient DNS failures', () => {
    expect(isTransientInfraError({ code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN unoapi-redis' })).toBe(true)
  })

  it('returns true for refused connections', () => {
    expect(isTransientInfraError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:6379' })).toBe(true)
  })

  it('returns false for generic ENOTFOUND outside infra dependencies', () => {
    expect(isTransientInfraError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND example.invalid' })).toBe(false)
  })
})

describe('isTransientExternalIoError', () => {
  it('recognizes an HTTPS response aborted by the remote peer without an error code', () => {
    const error = new Error('aborted')
    error.stack = 'Error: aborted\n    at TLSSocket.socketCloseListener (node:_http_client:726:19)'
    expect(isTransientExternalIoError(error)).toBe(true)
  })

  it('recognizes common transient socket codes', () => {
    expect(isTransientExternalIoError({ code: 'ECONNRESET', message: 'socket reset' })).toBe(true)
    expect(isTransientExternalIoError({ code: 'EPIPE', message: 'broken pipe' })).toBe(true)
  })

  it('does not hide unrelated aborted application errors', () => {
    const error = new Error('aborted')
    error.stack = 'Error: aborted\n    at processOrder (/app/src/orders.ts:10:5)'
    expect(isTransientExternalIoError(error)).toBe(false)
  })
})
