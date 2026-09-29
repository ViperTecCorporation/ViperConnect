import { historyErrorDiagnostic, HistoryPreparationError, prepareCompanionHistory } from '../../src/services/mobile_primary/companion_history_prepare'

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
