import logger from '../../src/services/logger'
import { CompanionHistoryReceiptTrace } from '../../src/services/mobile_primary/companion_history_receipt_trace'
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn() } }))
beforeEach(() => jest.clearAllMocks())
test('correlates hist_sync, delivery and server ack without consuming them or logging raw data', () => {
  const trace = new CompanionHistoryReceiptTrace('draft')
  trace.track('private-id', 'private-target', 4)
  for (const [tag, type, expected] of [['receipt', 'hist_sync', 'hist_sync'], ['receipt', undefined, 'delivery'], ['ack', undefined, 'server_ack']]) {
    expect(trace.observe({ tag: tag!, attrs: { id: 'private-id', from: 'private-target', ...(type ? { type } : {}) } })).toBe(false)
    expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ packet: 4, receiptType: expected, exactTargetMatch: true }), 'MOBILE_COMPANION_HISTORY_RECEIPT_OBSERVED')
  }
  expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toMatch(/private-id|private-target/)
})
test('batch ids are deduplicated and unrelated receipts ignored', () => {
  const trace = new CompanionHistoryReceiptTrace('draft'); trace.track('id', 'target', 0)
  jest.clearAllMocks()
  trace.observe({ tag: 'receipt', attrs: { id: 'id', from: 'other' }, content: [{ tag: 'list', attrs: {}, content: [{ tag: 'item', attrs: { id: 'id' } }, { tag: 'item', attrs: { id: 'unknown' } }] }] })
  expect(logger.info).toHaveBeenCalledTimes(1)
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ exactTargetMatch: false }), expect.any(String))
})
test('expiry and disposal prevent stale correlations', () => {
  jest.useFakeTimers()
  try {
    const trace = new CompanionHistoryReceiptTrace('draft'); trace.track('old', 'target', 0)
    jest.advanceTimersByTime(900001); jest.clearAllMocks()
    trace.observe({ tag: 'receipt', attrs: { id: 'old' } }); expect(logger.info).not.toHaveBeenCalled()
    trace.track('new', 'target', 1); trace.clear(); jest.clearAllMocks()
    trace.observe({ tag: 'receipt', attrs: { id: 'new' } }); expect(logger.info).not.toHaveBeenCalled()
  } finally { jest.useRealTimers() }
})
test('diagnostic failure never consumes a receipt', () => {
  const trace = new CompanionHistoryReceiptTrace('draft'); trace.track('id', 'target', 0)
  ;(logger.info as jest.Mock).mockImplementationOnce(() => { throw new Error('logger') })
  expect(trace.observe({ tag: 'receipt', attrs: { id: 'id' } })).toBe(false)
})
