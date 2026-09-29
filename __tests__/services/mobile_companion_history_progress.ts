import { proto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { historyPackets } from '../../src/services/mobile_primary/companion_history_payload'
import { progressiveHistory } from '../../src/services/mobile_primary/companion_history_progress'

async function* pages(count: number) {
  for (let i = 0; i < count; i++) yield* await historyPackets([{ id: `${i}@lid`, endOfHistoryTransfer: true,
    messages: [{ message: { key: { id: String(i) }, messageTimestamp: 123,
      message: { imageMessage: { directPath: '/media', mediaKey: Buffer.alloc(32) } } } }] }])
}

test.each([[5, [20, 40, 60, 80, 100]], [3, [33, 66, 100]], [1, [100]], [0, []]])('progress uses actual %i pages in both envelopes', async (count, expected) => {
  const actual: number[] = []
  for await (const packet of progressiveHistory(pages(count as number))) {
    const n = packet.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(n.initialHistBootstrapInlinePayload!))
    expect(h.progress).toBe(n.progress)
    expect(h.chunkOrder).toBe(actual.length)
    expect(h.conversations[0].endOfHistoryTransfer).toBe(true)
    expect(Number(h.conversations[0].messages[0].message?.messageTimestamp)).toBe(123)
    expect(h.conversations[0].messages[0].message?.message?.imageMessage?.directPath).toBe('/media')
    actual.push(n.progress!)
  }
  expect(actual).toEqual(expected)
})

test('capacity fails before yielding, never silently truncates or sends partial progress', async () => {
  const stream = progressiveHistory(pages(5), 1)
  await expect(stream.next()).rejects.toThrow('progress_capacity')
})

test('collection failure before denominator is known sends nothing', async () => {
  async function* failing() { yield* pages(1); throw new Error('store failed') }
  await expect(progressiveHistory(failing()).next()).rejects.toThrow('store failed')
})
