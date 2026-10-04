import { keysBeforeHistory } from '../../src/services/mobile_primary/companion_keys_before_history'
import { installHistoryBootstrap } from '../../src/services/mobile_primary/companion_history_bootstrap'

test('native experiment prepares Signal, shares keys, sends original bootstrap and returns to SDK without duplicate keys', async () => {
  const order: string[] = []
  const original = jest.fn(async () => { order.push('native-bootstrap') })
  const keys = jest.fn(async () => { order.push('keys') })
  const mobile = { shareAppStateSyncKeys: keys, sendHistorySyncBootstrap: original,
    listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  const early = keysBeforeHistory(mobile)
  const restore = installHistoryBootstrap(mobile, async target => {
    order.push('signal')
    await early.share(target)
    return 'native-bootstrap'
  })
  await mobile.sendHistorySyncBootstrap('target')
  await mobile.shareAppStateSyncKeys('target')
  order.push('sdk-provisioned')
  expect(order).toEqual(['signal', 'keys', 'native-bootstrap', 'sdk-provisioned'])
  await mobile.sendHistorySyncBootstrap('target')
  expect(original).toHaveBeenCalledTimes(1)
  expect(keys).toHaveBeenCalledTimes(1)
  restore(); early.dispose()
})

test('shares keys before history and suppresses the subsequent SDK share once', async () => {
  const order: string[] = []
  const original = jest.fn(async () => { order.push('keys') })
  const mobile = { shareAppStateSyncKeys: original, sendHistorySyncBootstrap: jest.fn(), listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  const early = keysBeforeHistory(mobile)
  installHistoryBootstrap(mobile, async target => { await early.share(target); order.push('history'); return 'submitted' })
  await mobile.sendHistorySyncBootstrap('target')
  await mobile.shareAppStateSyncKeys('target')
  expect(order).toEqual(['keys', 'history'])
  expect(original).toHaveBeenCalledTimes(1)
  await mobile.shareAppStateSyncKeys('target')
  expect(original).toHaveBeenCalledTimes(2)
  early.dispose(); expect(mobile.shareAppStateSyncKeys).toBe(original)
})

test('a key-share failure stops history and is not retried by repeated bootstrap', async () => {
  const error = new Error('uncertain')
  const original = jest.fn().mockRejectedValue(error), history = jest.fn()
  const mobile = { shareAppStateSyncKeys: original, sendHistorySyncBootstrap: jest.fn(), listCompanions: jest.fn().mockResolvedValue([{ deviceJid: 'target', keyIndex: 1 }]) }
  const early = keysBeforeHistory(mobile)
  installHistoryBootstrap(mobile, async target => { await early.share(target); history(); return 'submitted' })
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toBe(error)
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toBe(error)
  expect(history).not.toHaveBeenCalled(); expect(original).toHaveBeenCalledTimes(1)
  early.dispose()
})

test('concurrent preparation shares a single promise, without touching other devices', async () => {
  const original = jest.fn().mockResolvedValue(undefined)
  const mobile = { shareAppStateSyncKeys: original }, early = keysBeforeHistory(mobile)
  await Promise.all([early.share('one'), early.share('one')])
  await mobile.shareAppStateSyncKeys('two')
  expect(original.mock.calls).toEqual([['one'], ['two']])
  early.dispose()
})
