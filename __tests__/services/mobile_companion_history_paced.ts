import { CompanionHistoryAckGate } from '../../src/services/mobile_primary/companion_history_ack_gate'
import { keysBeforeHistory } from '../../src/services/mobile_primary/companion_keys_before_history'
import { installHistoryBootstrap } from '../../src/services/mobile_primary/companion_history_bootstrap'

test('keys finish before any gated packet; only exact hist_sync advances, SDK does not reshare', async () => {
  const order: string[] = [], gate = new CompanionHistoryAckGate()
  const mobile = { shareAppStateSyncKeys: jest.fn(async (_target: string) => { order.push('keys') }),
    sendHistorySyncBootstrap: async (_target: string) => {},
    listCompanions: async () => [{ deviceJid: 'target', keyIndex: 1 }] }
  const early = keysBeforeHistory(mobile)
  const restore = installHistoryBootstrap(mobile, async target => {
    await early.share(target)
    for (let i = 0; i < 5; i++) await gate.send(String(i), target, async () => { order.push(`packet${i}`) })
    return 'submitted'
  })
  const flow = mobile.sendHistorySyncBootstrap('target')
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    await tick()
    expect(order).toEqual(['keys', 'packet0'])
    gate.observe({ tag: 'ack', attrs: { from: 'target', id: '0' } })
    gate.observe({ tag: 'receipt', attrs: { from: 'target', id: '0', type: 'peer_msg' } })
    await tick(); expect(order).toEqual(['keys', 'packet0'])
    for (let i = 0; i < 5; i++) {
      gate.observe({ tag: 'receipt', attrs: { from: 'target', id: String(i), type: 'hist_sync' } })
      await tick()
      expect(order).toHaveLength(1 + Math.min(i + 2, 5))
    }
    await flow
    await mobile.shareAppStateSyncKeys('target')
    expect(order).toEqual(['keys', 'packet0', 'packet1', 'packet2', 'packet3', 'packet4'])
  } finally { gate.dispose(); await flow.catch(() => undefined); restore(); early.dispose() }
})
