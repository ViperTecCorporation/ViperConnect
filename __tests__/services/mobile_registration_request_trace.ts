const { requestTrace, sanitizeRequestTrace } = require('../../lab/registration/request_trace.cjs')

describe('registration request trace allowlist', () => {
  test('summarizes the real form without phone, keys or token values', () => {
    const value = requestTrace('/code', 'cc=55&in=66996222471&method=voice&sim_mcc=724&sim_mnc=05&push_token=SECRET&token=SECRET&vname=SECRET&authkey=SECRET', { os: 'android', business: true }, '2.26.38.73', { authorizationHeader: 'SECRET' })
    expect(value).toMatchObject({ endpoint: '/code', cc: '55', nationalDigits: '11', method: 'voice', sim_mcc: '724', sim_mnc: '05', pushPresent: true, tokenPresent: true, vnamePresent: true, authorizationPresent: true })
    expect(JSON.stringify(value)).not.toMatch(/SECRET|66996222471|authkey/)
  })
  test('parent sanitization drops arbitrary IPC fields and invalid values', () => {
    expect(sanitizeRequestTrace({ endpoint: '/code', method: 'voice', token: 'SECRET', version: '<secret>', pushPresent: 'SECRET', cc: '55\nsecret' })).toEqual({ endpoint: '/code', method: 'voice' })
    expect(sanitizeRequestTrace({ endpoint: '/client_log', token: 'SECRET' })).toBeUndefined()
  })
})
