import logger from '../../src/services/logger'
import { companionDiagnosticLogger } from '../../src/services/mobile_primary/companion_diagnostic_logger'
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn() } }))
const base = () => {
  const result: any = { level: 'error', trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  result.child = jest.fn(() => result)
  return result
}
beforeEach(() => jest.clearAllMocks())
test('disabled returns the original logger', () => {
  const original = base()
  expect(companionDiagnosticLogger(original, false, 'secret-session')).toBe(original)
})
test('allowlist survives child loggers and exposes no names, errors, keys or raw identifiers', () => {
  const original = base()
  const observed = companionDiagnosticLogger(original, true, 'secret-session').child({ token: 'secret-token' })
  for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
    observed[level]('companion provisioned', { deviceJid: 'secret-device', name: 'secret-name', message: 'secret-error', key: 'secret-key', attempts: 2 })
    expect(original[level]).toHaveBeenCalledTimes(1)
  }
  expect(logger.info).toHaveBeenCalledTimes(5)
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'PROVISIONED', attempts: 2 }), 'MOBILE_COMPANION_SDK_DIAGNOSTIC')
  expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('secret-')
  observed.warn('failed to seed primary setting_pushName app-state', { message: 'secret-error' })
  expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'PUSH_NAME_FAILED' }), 'MOBILE_COMPANION_SDK_DIAGNOSTIC')
  observed.info('unrelated', { token: 'secret-token' })
  expect(logger.info).toHaveBeenCalledTimes(6)
})
