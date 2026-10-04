import { installHistoryBootstrap } from '../../src/services/mobile_primary/companion_history_bootstrap'
import { HistoryPreparationError } from '../../src/services/mobile_primary/companion_history_prepare'
import { captureCompanionHistoryChoice, withCompanionHistoryChoice } from '../../src/services/mobile_primary/companion_history_choice'

test('opt-out skips Redis export but retains mandatory native bootstrap once, including later retries', async () => {
  const original = jest.fn().mockResolvedValue(undefined), send = jest.fn(), prepare = jest.fn().mockResolvedValue(undefined)
  const mobile = { sendHistorySyncBootstrap: original, listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  installHistoryBootstrap(mobile, send, () => captureCompanionHistoryChoice(mobile), prepare)
  let pending!: Promise<void>
  await withCompanionHistoryChoice(mobile, false, async () => { pending = mobile.sendHistorySyncBootstrap('target') })
  await pending
  await mobile.sendHistorySyncBootstrap('target')
  expect(send).not.toHaveBeenCalled()
  expect(original).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(original.mock.invocationCallOrder[0])
})

test('opt-out retries failed preparation, then bootstraps and allows SDK keys without exporting', async () => {
  const order: string[] = []
  const original = jest.fn(async () => { order.push('bootstrap') })
  const keys = jest.fn(async () => { order.push('keys') }), send = jest.fn()
  const prepare = jest.fn().mockRejectedValueOnce(new HistoryPreparationError()).mockImplementation(async () => { order.push('prepare') })
  const mobile = { sendHistorySyncBootstrap: original, shareAppStateSyncKeys: keys,
    listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  installHistoryBootstrap(mobile, send, () => captureCompanionHistoryChoice(mobile), prepare)
  await withCompanionHistoryChoice(mobile, false, async () => {
    await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('preparation_failed')
  })
  expect(original).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled()
  await Promise.all([mobile.sendHistorySyncBootstrap('target'), mobile.sendHistorySyncBootstrap('target')])
  await mobile.shareAppStateSyncKeys()
  expect(order).toEqual(['prepare', 'bootstrap', 'keys'])
  expect(prepare).toHaveBeenCalledTimes(2); expect(original).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
})

test('opt-out retains uncertain publication failure instead of replaying bootstrap', async () => {
  const original = jest.fn().mockRejectedValue(new Error('uncertain publication'))
  const prepare = jest.fn().mockResolvedValue(undefined), send = jest.fn()
  const mobile = { sendHistorySyncBootstrap: original, listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  installHistoryBootstrap(mobile, send, () => () => false, prepare)
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('uncertain publication')
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('uncertain publication')
  expect(original).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
})

test('opt-out refuses native publication when runtime preparation denies ownership', async () => {
  const original = jest.fn(), send = jest.fn()
  const mobile = { sendHistorySyncBootstrap: original, listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  installHistoryBootstrap(mobile, send, () => () => false, async () => { throw new Error('mobile_history_not_connected') })
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('not_connected')
  expect(original).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})

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
