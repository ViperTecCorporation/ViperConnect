import { historyErrorDiagnostic, HistoryPreparationError, prepareCompanionHistory } from '../../src/services/mobile_primary/companion_history_prepare'

test('retries only the exact prekey 406, with bounded backoff before publication', async () => {
  const prepare = jest.fn().mockRejectedValueOnce(new Error('key bundle iq failed (406: not-acceptable)')).mockResolvedValue(undefined)
  const wait = jest.fn().mockResolvedValue(undefined)
  await prepareCompanionHistory(prepare, wait)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(wait).toHaveBeenCalledWith(1500)
})

test('exhausts three prekey attempts; other errors are never retried internally', async () => {
  const prepare = jest.fn().mockRejectedValue(new Error('key bundle iq failed (406: not-acceptable)'))
  const wait = jest.fn().mockResolvedValue(undefined)
  await expect(prepareCompanionHistory(prepare, wait)).rejects.toBeInstanceOf(HistoryPreparationError)
  expect(prepare).toHaveBeenCalledTimes(3)
  expect(wait.mock.calls).toEqual([[1500], [3000]])
  for (const message of ['key bundle iq failed (401: not-authorized)', 'mobile_history_not_connected', 'timeout', 'secret 406']) {
    prepare.mockClear().mockRejectedValue(new Error(message)); wait.mockClear()
    await expect(prepareCompanionHistory(prepare, wait)).rejects.toBeInstanceOf(HistoryPreparationError)
    expect(prepare).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled()
  }
})

test('prekey diagnostics expose only an allowlisted reason and numeric code', () => {
  expect(historyErrorDiagnostic(new Error('key bundle iq failed (406: not-acceptable)'))).toMatchObject({ providerCode: 406, providerReason: 'not-acceptable' })
  expect(historyErrorDiagnostic(new Error('key bundle iq failed (403: secret-token)'))).toMatchObject({ providerCode: 403, providerReason: 'redacted' })
})

test('successful preparation resolves; failure is typed as safe to retry', async () => {
  const prepare = jest.fn().mockResolvedValue(undefined)
  await expect(prepareCompanionHistory(prepare)).resolves.toBeUndefined()
  expect(prepare).toHaveBeenCalledTimes(1)
  prepare.mockRejectedValue(new Error('sensitive provider text'))
  await expect(prepareCompanionHistory(prepare)).rejects.toBeInstanceOf(HistoryPreparationError)
})

test('diagnostics preserve code locations without provider contents or full paths', () => {
  const error = new Error('secret timeout with credentials')
  error.stack = 'Error: secret timeout with credentials\n at query (/app/node_modules/zapo-js/dist/signal/query.js:42:7)'
  const diagnostic = historyErrorDiagnostic(error)
  expect(diagnostic.reason).toBe('timeout')
  expect(diagnostic.locations).toEqual(['query.js:42:7'])
  expect(JSON.stringify(diagnostic)).not.toMatch(/secret|credentials|node_modules/)
  expect(historyErrorDiagnostic(null).reason).toBe('provider_error')
})
