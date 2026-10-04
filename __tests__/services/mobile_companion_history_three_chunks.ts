import { proto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { historyPackets } from '../../src/services/mobile_primary/companion_history_payload'
import { threeChunkHistory } from '../../src/services/mobile_primary/companion_history_three_chunks'

test.each([0, 1, 15])('all %i texts first, then isolated video, sticker and images, preserving statuses', async texts => {
  async function* archive() {
    const types = ['imageMessage', 'stickerMessage', 'videoMessage', 'imageMessage']
    for (let i = 0; i < texts + types.length; i++) yield* await historyPackets([{ id: '1@lid', messages: [{ message: {
      key: { id: `ordered${i}`, fromMe: true }, status: proto.WebMessageInfo.Status.READ, messageTimestamp: 100 + i,
      message: i < texts ? { conversation: 'text' } : { [types[i - texts]]: { directPath: '/media' } },
    } }] }], [{ lidJid: '1@lid', pnJid: '551@s.whatsapp.net' }])
  }
  const decoded: proto.HistorySync[] = []
  for await (const p of threeChunkHistory(archive(), 192000, 'text-video-sticker-image')) {
    const e = p.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(e.initialHistBootstrapInlinePayload!))
    expect(e.chunkOrder).toBe(decoded.length); expect(h.chunkOrder).toBe(e.chunkOrder)
    expect(e.progress).toBe(h.progress)
    decoded.push(h)
  }
  expect(decoded.map(h => Object.keys(h.conversations[0].messages[0].message!.message!)[0])).toEqual([
    ...(texts ? ['conversation'] : []), 'videoMessage', 'stickerMessage', 'imageMessage', 'imageMessage',
  ])
  expect(decoded.map(h => h.conversations[0].messages.length)).toEqual([...(texts ? [texts] : []), 1, 1, 1, 1])
  const all = decoded.flatMap(h => h.conversations[0].messages)
  expect(new Set(all.map(m => m.message!.key!.id)).size).toBe(texts + 4)
  expect(all.every(m => m.message!.status === proto.WebMessageInfo.Status.READ)).toBe(true)
  expect(decoded.map(h => h.progress)).toEqual(decoded.map((_, i) => Math.floor((i + 1) * 100 / decoded.length)))
  expect(decoded.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual(decoded.map((_, i) => i === decoded.length - 1))
})

test.each([0, 1, 4])('isolates each media and closes with a real text when available (%i texts)', async texts => {
  async function* archive() {
    const kinds = ['imageMessage', 'imageMessage', 'videoMessage', 'stickerMessage']
    for (let i = 0; i < texts + 4; i++) yield* await historyPackets([{ id: '1@lid', messages: [{ message: {
      key: { id: `entry${i}`, fromMe: true }, status: proto.WebMessageInfo.Status.DELIVERY_ACK, messageTimestamp: 100 + i,
      message: i < texts ? { conversation: 'text' } : { [kinds[i - texts]]: { directPath: '/media' } },
    } }] }], [])
  }
  const decoded: proto.HistorySync[] = []
  for await (const p of threeChunkHistory(archive(), 192000, 'each-media-text-end')) {
    const e = p.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(e.initialHistBootstrapInlinePayload!))
    expect(e.chunkOrder).toBe(decoded.length); expect(h.chunkOrder).toBe(e.chunkOrder)
    expect(h.progress).toBe(e.progress)
    decoded.push(h)
  }
  const all = decoded.flatMap(h => h.conversations[0].messages)
  expect(all).toHaveLength(texts + 4)
  expect(new Set(all.map(m => m.message!.key!.id)).size).toBe(texts + 4)
  expect(all.every(m => m.message!.status === proto.WebMessageInfo.Status.DELIVERY_ACK)).toBe(true)
  for (const h of decoded) {
    if (h.conversations[0].messages.some(m => !m.message!.message!.conversation)) expect(h.conversations[0].messages).toHaveLength(1)
  }
  const last = decoded[decoded.length - 1]
  expect(last.progress).toBe(100)
  expect(last.conversations[0].endOfHistoryTransfer).toBe(true)
  if (texts) expect(last.conversations[0].messages[0].message!.message!.conversation).toBe('text')
  expect(decoded.map(h => h.progress)).toEqual(decoded.map((_, i) => Math.floor((i + 1) * 100 / decoded.length)))
})

test.each([['imageMessage', 'videoMessage'], ['videoMessage'], ['imageMessage'], []])('media-split isolates video after other media: %j', async (...kinds: string[]) => {
  async function* archive() {
    for (let i = 0; i < 12 + kinds.length; i++) yield* await historyPackets([{ id: '1@lid',
      messages: [{ message: { key: { id: `split${i}` }, messageTimestamp: 100 + i,
        message: i < 12 ? { conversation: 'text' } : { [kinds[i - 12]]: { directPath: '/media', mediaKey: Buffer.alloc(32) } },
      } }] }], [{ pnJid: '551@s.whatsapp.net', lidJid: '1@lid' }])
  }
  const decoded: proto.HistorySync[] = []
  for await (const p of threeChunkHistory(archive(), 192000, 'media-split')) {
    const e = p.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(e.initialHistBootstrapInlinePayload!))
    expect(e.chunkOrder).toBe(decoded.length); expect(h.chunkOrder).toBe(e.chunkOrder)
    expect(e.progress).toBe(h.progress)
    expect(p.count).toBe(h.conversations[0].messages.length)
    decoded.push(h)
  }
  expect(decoded.map(h => h.conversations[0].messages.length)).toEqual([6, 6, ...kinds.map(() => 1)])
  expect(decoded.map(h => h.progress)).toEqual(decoded.map((_, i) => Math.floor((i + 1) * 100 / decoded.length)))
  for (let i = 0; i < kinds.length; i++) expect(decoded[i + 2].conversations[0].messages[0].message!.message![kinds[i]]).toBeDefined()
  const ids = decoded.flatMap(h => h.conversations[0].messages.map(m => m.message!.key!.id))
  expect(new Set(ids).size).toBe(12 + kinds.length)
  expect(decoded.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual(decoded.map((_, i) => i === decoded.length - 1))
  expect(decoded.every(h => h.phoneNumberToLidMappings.length === 1)).toBe(true)
})

test.each([0, 1, 2, 12])('media-last preserves %i texts and all media, with completion only after the final fragment', async texts => {
  const kinds = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']
  async function* archive() {
    for (let i = 0; i < texts + kinds.length; i++) yield* await historyPackets([{ id: '1@lid',
      messages: [{ message: { key: { id: `item${i}` }, messageTimestamp: 100 + i,
        message: i < texts ? { conversation: 'text' } : { [kinds[i - texts]]: { mediaKey: Buffer.alloc(32), directPath: '/media' } },
      } }] }], [{ pnJid: '551@s.whatsapp.net', lidJid: '1@lid' }])
  }
  const decoded: proto.HistorySync[] = []
  for await (const p of threeChunkHistory(archive(), 192000, 'media-last')) {
    const e = p.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(e.initialHistBootstrapInlinePayload!))
    expect(h.chunkOrder).toBe(decoded.length)
    expect(e.chunkOrder).toBe(h.chunkOrder); expect(e.progress).toBe(h.progress)
    expect(h.conversations[0].messages.length).toBe(p.count)
    decoded.push(h)
  }
  expect(decoded.length).toBeLessThanOrEqual(3)
  const all = decoded.flatMap(h => h.conversations[0].messages)
  expect(new Set(all.map(m => m.message!.key!.id)).size).toBe(texts + kinds.length)
  expect(all).toHaveLength(texts + kinds.length)
  for (const h of decoded.slice(0, -1)) for (const m of h.conversations[0].messages) expect(m.message!.message!.conversation).toBe('text')
  expect(decoded[decoded.length - 1].conversations[0].messages).toHaveLength(kinds.length)
  expect(decoded.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual(decoded.map((_, i) => i === decoded.length - 1))
  expect(decoded.map(h => h.progress)).toEqual(decoded.map((_, i) => Math.floor((i + 1) * 100 / decoded.length)))
  expect(decoded.every(h => h.phoneNumberToLidMappings.length === 1)).toBe(true)
})

test('media-last keeps empty archive empty and validates media size before yielding text', async () => {
  expect((await threeChunkHistory(pages(0), 192000, 'media-last').next()).done).toBe(true)
  await expect(threeChunkHistory(pages(5, true), 1, 'media-last').next()).rejects.toThrow('three_chunks_too_large')
})

async function* pages(n: number, sameChat = false) {
  for (let i = 0; i < n; i++) yield* await historyPackets([{ id: `${sameChat ? 1 : i}@lid`, endOfHistoryTransfer: i === n - 1,
    messages: [{ message: { key: { id: `m${i}` }, messageTimestamp: 100 + i,
      message: i === n - 1 ? { videoMessage: { directPath: '/video', mediaKey: Buffer.alloc(32) } } : { conversation: 'text' },
    } }] }], [{ pnJid: `55${i}@s.whatsapp.net`, lidJid: `${i}@lid` }])
}

test.each([0, 1, 2, 3, 5, 11])('preserves all %i input messages in at most three chunks with matching percent and order', async n => {
  const result = []
  for await (const p of threeChunkHistory(pages(n))) result.push(p)
  expect(result).toHaveLength(n ? 1 : 0)
  const ids: string[] = []
  result.forEach((p, i) => {
    const envelope = p.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(envelope.initialHistBootstrapInlinePayload!))
    expect(envelope.progress).toBe(Math.floor((i + 1) * 100 / result.length))
    expect(h.progress).toBe(envelope.progress); expect(h.chunkOrder).toBe(i)
    for (const c of h.conversations) for (const m of c.messages || []) ids.push(m.message!.key!.id!)
  })
  expect(ids).toEqual(Array.from({ length: n }, (_, i) => `m${n - i - 1}`))
  expect(result.reduce((sum, p) => sum + p.count, 0)).toBe(n)
  if (n) {
    const h = proto.HistorySync.decode(inflateSync(result[result.length - 1].message.historySyncNotification!.initialHistBootstrapInlinePayload!))
    expect(h.conversations[0]?.messages?.[0]?.message?.message?.videoMessage?.directPath).toBe('/video')
  }
})

test('coalesces fragments of one conversation without losing messages or premature final marker', async () => {
  const result = []
  for await (const p of threeChunkHistory(pages(5, true))) result.push(proto.HistorySync.decode(inflateSync(p.message.historySyncNotification!.initialHistBootstrapInlinePayload!)))
  expect(result.map(h => h.conversations.length)).toEqual([1, 1, 1])
  expect(result.map(h => h.conversations[0].messages?.length)).toEqual([1, 2, 2])
  expect(result.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual([false, false, true])
  expect(result.map(h => Number(h.conversations[0].conversationTimestamp))).toEqual([104, 104, 104])
  expect(result.flatMap(h => h.conversations[0].messages!.map(m => m.message!.key!.id))).toEqual(['m4', 'm3', 'm2', 'm1', 'm0'])
  expect(result.map(h => h.progress)).toEqual([33, 66, 100])
})

test('oversize combined payload fails before any chunk can be sent', async () => {
  await expect(threeChunkHistory(pages(5), 1).next()).rejects.toThrow('three_chunks_too_large')
})

test('selection failure never sends partial archive', async () => {
  async function* broken() { yield* pages(1); throw new Error('read failed') }
  await expect(threeChunkHistory(broken()).next()).rejects.toThrow('read failed')
})

test('position experiment swaps first two batches without dropping media and recalculates completion', async () => {
  const normal: proto.HistorySync[] = [], swapped: proto.HistorySync[] = []
  for await (const p of threeChunkHistory(pages(5, true))) normal.push(proto.HistorySync.decode(inflateSync(p.message.historySyncNotification!.initialHistBootstrapInlinePayload!)))
  for await (const p of threeChunkHistory(pages(5, true), 192000, true)) {
    const envelope = p.message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(envelope.initialHistBootstrapInlinePayload!))
    expect(envelope.progress).toBe(h.progress)
    expect(envelope.chunkOrder).toBe(h.chunkOrder)
    swapped.push(h)
  }
  const ids = (h: proto.HistorySync) => h.conversations.flatMap(c => c.messages.map(m => m.message!.key!.id))
  expect(swapped.map(ids)).toEqual([ids(normal[1]), ids(normal[0]), ids(normal[2])])
  expect(swapped.map(h => h.chunkOrder)).toEqual([0, 1, 2])
  expect(swapped.map(h => h.progress)).toEqual([33, 66, 100])
  expect(swapped.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual([false, false, true])
  expect(swapped[1].conversations[0].messages[0].message!.message!.videoMessage).toBeDefined()
  expect(swapped.map(h => h.phoneNumberToLidMappings)).toEqual(normal.map(h => h.phoneNumberToLidMappings))
})

test('swapped two-chunk history completes in the new last fragment; single chunk unchanged', async () => {
  const decoded = []
  for await (const p of threeChunkHistory(pages(2, true), 192000, true)) decoded.push(proto.HistorySync.decode(inflateSync(p.message.historySyncNotification!.initialHistBootstrapInlinePayload!)))
  expect(decoded.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual([false, true])
  expect(decoded.map(h => h.progress)).toEqual([50, 100])
  const one = await threeChunkHistory(pages(1), 192000, true).next()
  expect(one.value!.count).toBe(1)
  expect(one.value!.message.historySyncNotification!.progress).toBe(100)
})

test('five chats appear in first chunk; all 14 unique messages continue newest to oldest without repetition', async () => {
  const sizes = [4, 1, 2, 5, 2]
  async function* archive() {
    for (let chat = 0; chat < sizes.length; chat++) {
      // Oldest first, split across input pages: output must not inherit that order.
      for (let i = 0; i < sizes[chat]; i++) yield* await historyPackets([{ id: `${chat}@lid`,
        name: `chat${chat}`, endOfHistoryTransfer: i === sizes[chat] - 1,
        messages: [{ message: { key: { id: `${chat}-${i}`, remoteJid: `${chat}@lid` },
          messageTimestamp: 100 + i * 10 + chat, message: { conversation: 'text' } } }] }],
      [{ pnJid: `55${chat}@s.whatsapp.net`, lidJid: `${chat}@lid` }])
    }
  }
  const decoded: proto.HistorySync[] = [], counts: number[] = []
  for await (const p of threeChunkHistory(archive())) {
    counts.push(p.count)
    decoded.push(proto.HistorySync.decode(inflateSync(p.message.historySyncNotification!.initialHistBootstrapInlinePayload!)))
  }
  expect(counts).toEqual([5, 5, 4])
  expect(decoded.map(h => h.progress)).toEqual([33, 66, 100])
  expect(decoded[0].conversations).toHaveLength(5)
  for (const c of decoded[0].conversations) {
    const chat = Number(c.id!.split('@')[0])
    expect(c.messages).toHaveLength(1)
    expect(c.messages![0].message!.key!.id).toBe(`${chat}-${sizes[chat] - 1}`)
    expect(c.endOfHistoryTransfer).toBe(sizes[chat] === 1)
  }
  const all = decoded.flatMap(h => h.conversations.flatMap(c => c.messages || []))
  expect(all).toHaveLength(14)
  expect(new Set(all.map(m => m.message!.key!.id)).size).toBe(14)
  const dates = decoded.map(h => h.conversations.flatMap(c => (c.messages || []).map(m => Number(m.message!.messageTimestamp))))
  expect(Math.min(...dates[1])).toBeGreaterThanOrEqual(Math.max(...dates[2]))
  for (const h of decoded) {
    expect(h.phoneNumberToLidMappings).toHaveLength(5)
    for (const c of h.conversations) {
      const times = (c.messages || []).map(m => Number(m.message!.messageTimestamp))
      expect(times).toEqual([...times].sort((a, b) => b - a))
    }
  }
  for (let chat = 0; chat < sizes.length; chat++) {
    const fragments = decoded.flatMap(h => h.conversations.filter(c => c.id === `${chat}@lid`))
    expect(fragments.map(c => c.endOfHistoryTransfer)).toEqual(fragments.map((_, i) => i === fragments.length - 1))
  }
})
