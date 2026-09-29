import { installHistoryBootstrap } from '../../src/services/mobile_primary/companion_history_bootstrap'
import { HistoryPreparationError } from '../../src/services/mobile_primary/companion_history_prepare'

test('allows SDK retry after preparation failure without repeating a successful export', async () => {
  const mobile = { sendHistorySyncBootstrap: jest.fn(), listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  const send = jest.fn().mockRejectedValueOnce(new HistoryPreparationError()).mockResolvedValue('submitted')
  installHistoryBootstrap(mobile, send)
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('preparation_failed')
  await Promise.all([mobile.sendHistorySyncBootstrap('target'), mobile.sendHistorySyncBootstrap('target')])
  await mobile.sendHistorySyncBootstrap('target')
  expect(send).toHaveBeenCalledTimes(2)
  expect(mobile.sendHistorySyncBootstrap).not.toBeUndefined()
})
test('substitutes initial empty bootstrap, serializes repeats and restores on disposal', async () => {
  const original = jest.fn().mockResolvedValue(undefined)
  const mobile = { sendHistorySyncBootstrap: original, listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  const send = jest.fn().mockResolvedValue('submitted')
  const dispose = installHistoryBootstrap(mobile, send)
  await Promise.all([mobile.sendHistorySyncBootstrap('target'), mobile.sendHistorySyncBootstrap('target')])
  expect(send).toHaveBeenCalledTimes(1); expect(original).not.toHaveBeenCalled()
  dispose(); expect(mobile.sendHistorySyncBootstrap).toBe(original)
})
test('empty archive retains the SDK initial gate exactly once', async () => {
  const original = jest.fn().mockResolvedValue(undefined)
  const mobile = { sendHistorySyncBootstrap: original, listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  installHistoryBootstrap(mobile, jest.fn().mockResolvedValue('empty'))
  await mobile.sendHistorySyncBootstrap('target'); await mobile.sendHistorySyncBootstrap('target')
  expect(original).toHaveBeenCalledTimes(1)
})
test('failed exports do not silently send empty history or repeat during SDK retries', async () => {
  const original = jest.fn(), send = jest.fn().mockRejectedValue(new Error('uncertain'))
  const mobile = { sendHistorySyncBootstrap: original, listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  installHistoryBootstrap(mobile, send)
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('uncertain')
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('uncertain')
  expect(send).toHaveBeenCalledTimes(1); expect(original).not.toHaveBeenCalled()
})
test('missing companion refuses; a new key index is a distinct link', async () => {
  const mobile = { sendHistorySyncBootstrap: jest.fn(), listCompanions: jest.fn().mockResolvedValue([]) }
  const send = jest.fn().mockResolvedValue('submitted'); installHistoryBootstrap(mobile, send)
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('missing')
  for (const keyIndex of [1, 2]) { mobile.listCompanions.mockResolvedValue([{ deviceJid: 'target', keyIndex }]); await mobile.sendHistorySyncBootstrap('target') }
  expect(send).toHaveBeenCalledTimes(2)
})
