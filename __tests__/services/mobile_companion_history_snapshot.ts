import { proto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { historyPackets } from '../../src/services/mobile_primary/companion_history_payload'
import { companionHistorySnapshot } from '../../src/services/mobile_primary/companion_history_snapshot'
import { historyAfterProvision } from '../../src/services/mobile_primary/companion_history_after_provision'

async function* archive() {
  for (const time of [10, 20, 5]) for (let i = 1; i <= 5; i++) {
    yield* await historyPackets([{ id: `${i}@lid`, messages: [{ message: {
      key: { id: `${i}-${time}`, remoteJid: `${i}@lid` }, messageTimestamp: time,
      message: i === 5 ? { imageMessage: { directPath: '/image', mediaKey: Buffer.alloc(32) } } : { conversation: 'test' },
    } }] }], [{ pnJid: `55${i}@s.whatsapp.net`, lidJid: `${i}@lid` }])
  }
}

test('single bootstrap inventories all five chats including media, newest message only, not archive completion', async () => {
  const result = (await companionHistorySnapshot(archive()))!
  const n = result.message.historySyncNotification
  const decoded = proto.HistorySync.decode(inflateSync(n.initialHistBootstrapInlinePayload))
  expect(result.conversations).toBe(5)
  expect(n.chunkOrder).toBe(0); expect(n.progress).toBe(100)
  expect(decoded.syncType).toBe(proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP)
  expect(decoded.phoneNumberToLidMappings).toHaveLength(5)
  for (const chat of decoded.conversations) {
    expect(chat.messages).toHaveLength(1)
    expect(Number(chat.messages[0].message?.messageTimestamp)).toBe(20)
    expect(chat.endOfHistoryTransfer).toBe(false)
  }
  expect(decoded.conversations[4].messages[0].message?.message?.imageMessage?.directPath).toBe('/image')
})

test('empty archive allows native empty bootstrap', async () => {
  async function* empty() { /* intentionally empty */ }
  expect(await companionHistorySnapshot(empty())).toBeUndefined()
})

test('snapshot precedes keys and enqueue, without duplicate empty bootstrap', async () => {
  const order: string[] = []
  const mobile = { sendHistorySyncBootstrap: async (_target: string) => { order.push('empty') },
    shareAppStateSyncKeys: async (_target: string) => { order.push('keys') },
    listCompanions: async () => [{ deviceJid: 'target', keyIndex: 1 }] }
  const dispose = historyAfterProvision(mobile, async () => { order.push('queue') }, jest.fn(), async () => {
    order.push('snapshot'); return true
  })
  await mobile.sendHistorySyncBootstrap('target')
  await mobile.shareAppStateSyncKeys('target')
  expect(order).toEqual(['snapshot', 'keys', 'queue'])
  dispose()
})

test('failed snapshot never shares completion with queue; empty snapshot delegates to native', async () => {
  const original = jest.fn(async (_target: string) => {})
  const enqueue = jest.fn(), snapshot = jest.fn().mockRejectedValueOnce(new Error('snapshot failed')).mockResolvedValue(false)
  const mobile = { sendHistorySyncBootstrap: original, shareAppStateSyncKeys: async (_target: string) => {},
    listCompanions: async () => [{ deviceJid: 'target', keyIndex: 1 }] }
  historyAfterProvision(mobile, enqueue, jest.fn(), snapshot)
  await expect(mobile.sendHistorySyncBootstrap('target')).rejects.toThrow('snapshot failed')
  await mobile.shareAppStateSyncKeys('target')
  expect(enqueue).not.toHaveBeenCalled(); expect(original).not.toHaveBeenCalled()
  await mobile.sendHistorySyncBootstrap('target'); await mobile.shareAppStateSyncKeys('target')
  expect(original).toHaveBeenCalledTimes(1); expect(enqueue).toHaveBeenCalledTimes(1)
})
