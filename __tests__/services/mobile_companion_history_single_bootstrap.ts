import { proto } from 'zapo-js'
import { dirname, join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { historyPackets } from '../../src/services/mobile_primary/companion_history_payload'
import { singleCompanionBootstrap } from '../../src/services/mobile_primary/companion_history_single_bootstrap'

async function* pages(items: any[]) { yield* items }
async function collect(source: AsyncIterable<any>) { const items = []; for await (const item of source) items.push(item); return items }
const msg = (id: string, timestamp: number, content: any = { conversation: 'test' }) => ({ message: {
  key: { id, remoteJid: '123@lid', fromMe: false }, messageTimestamp: timestamp, message: content,
} })

test('one bootstrap includes all five conversations and media, matching installed Zapo builder bytes', async () => {
  const conversations = Array.from({ length: 5 }, (_, i) => ({ id: `${123 + i}@lid`, name: `Chat ${i}`,
    messages: [msg(`m${i}`, 100 + i, i === 3 ? { videoMessage: { mimetype: 'video/mp4', mediaKey: Buffer.alloc(32, 1), directPath: '/video' } }
      : i === 4 ? { imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.alloc(32, 2), directPath: '/image' } } : undefined)],
    conversationTimestamp: 100 + i, lastMsgTimestamp: 100 + i, endOfHistoryTransfer: true,
  }))
  const mappings = conversations.map(c => ({ pnJid: c.id.replace('@lid', '@s.whatsapp.net'), lidJid: c.id }))
  const result = await collect(singleCompanionBootstrap(pages(await historyPackets(conversations, mappings))))
  expect(result).toHaveLength(1)
  expect(result[0].count).toBe(5)
  // Internal SDK builder is not exported publicly: used only as a version-pinned test oracle.
  const { buildHistorySyncBootstrapMessage } = require(join(dirname(require.resolve('zapo-js')), 'client/messaging/companion-host.js'))
  const expected = await buildHistorySyncBootstrapMessage({ conversations, phoneNumberToLidMappings: mappings })
  expect(Buffer.from(proto.Message.ProtocolMessage.encode(result[0].message).finish()))
    .toEqual(Buffer.from(proto.Message.ProtocolMessage.encode(expected.message).finish()))
})

test('merges pages of the same chat and restores newest-first ordering and timestamps', async () => {
  const input = await historyPackets([{ id: '123@lid', messages: Array.from({ length: 25 }, (_, i) => msg(String(i), i + 1)) }])
  const [result] = await collect(singleCompanionBootstrap(pages(input)))
  const h = proto.HistorySync.decode(inflateSync(result.message.historySyncNotification.initialHistBootstrapInlinePayload))
  expect(h.conversations).toHaveLength(1)
  expect(h.conversations[0].messages).toHaveLength(25)
  expect(Number(h.conversations[0].conversationTimestamp)).toBe(25)
  expect(h.conversations[0].endOfHistoryTransfer).toBe(true)
  expect(h.chunkOrder).toBe(0)
  expect(h.progress).toBe(100)
})

test('empty archive produces no packet', async () => {
  expect(await collect(singleCompanionBootstrap(pages([])))).toEqual([])
})

test('five conversations and fourteen messages remain in one chunk at 100 percent', async () => {
  const chats = [4, 2, 1, 5, 2].map((size, index) => ({
    id: `${123 + index}@lid`,
    messages: Array.from({ length: size }, (_, n) => {
      const item = msg(`${index}-${n}`, 100 + n)
      item.message.key.remoteJid = `${123 + index}@lid`
      return item
    }),
  }))
  const result = await collect(singleCompanionBootstrap(pages(await historyPackets(chats))))
  expect(result).toHaveLength(1)
  expect(result[0].count).toBe(14)
  const notification = result[0].message.historySyncNotification
  expect(notification.chunkOrder).toBe(0)
  expect(notification.progress).toBe(100)
  const decoded = proto.HistorySync.decode(inflateSync(notification.initialHistBootstrapInlinePayload))
  expect(decoded.chunkOrder).toBe(0)
  expect(decoded.progress).toBe(100)
  expect(decoded.conversations).toHaveLength(5)
  expect(new Set(decoded.conversations.flatMap(c => c.messages.map(m => m.message!.key!.id))).size).toBe(14)
})

test('archive over memory budget fails without yielding a partial bootstrap', async () => {
  const packet = { message: { historySyncNotification: { initialHistBootstrapInlinePayload: deflateSync(Buffer.alloc(4 * 1024 * 1024 + 1)) } }, count: 1 }
  await expect(singleCompanionBootstrap(pages([packet])).next()).rejects.toThrow('mobile_history_single_bootstrap_too_large')
})

test('oversize compressed payload fails rather than splitting or truncating', async () => {
  const raw = proto.HistorySync.encode({ conversations: [{ id: '123@lid', messages: [msg('1', 1, { imageMessage: { jpegThumbnail: randomBytes(200000) } })] }] }).finish()
  const packet = { message: { historySyncNotification: { initialHistBootstrapInlinePayload: deflateSync(raw) } }, count: 1 }
  await expect(singleCompanionBootstrap(pages([packet])).next()).rejects.toThrow('mobile_history_single_bootstrap_too_large')
})

test('missing conversation identity fails before sending anything', async () => {
  const packet = { message: { historySyncNotification: { initialHistBootstrapInlinePayload: deflateSync(proto.HistorySync.encode({ conversations: [{ messages: [msg('1', 1)] }] }).finish()) } }, count: 1 }
  await expect(singleCompanionBootstrap(pages([packet])).next()).rejects.toThrow('mobile_history_conversation_id_missing')
})
