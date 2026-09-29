import { proto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { streamCompanionHistory } from '../../src/services/mobile_primary/companion_history_stream'
import { threeChunkHistory } from '../../src/services/mobile_primary/companion_history_three_chunks'

test('exports texts then only the selected normal image, preserving context and original references', async () => {
  const phone = '999123456789', jid = '123@lid', timestampMs = Date.now() - 10000
  const contextInfo = { mentionedJid: ['456@lid'], stanzaId: 'original-context' }
  const media = { url: 'https://mmg.whatsapp.net/test', directPath: '/test', mediaKey: Buffer.alloc(32, 1), fileSha256: Buffer.alloc(32, 2), fileEncSha256: Buffer.alloc(32, 3), contextInfo }
  const contents = [{ conversation: 'text' }, { imageMessage: media }, { imageMessage: media }, { videoMessage: media }, { stickerMessage: media }, { imageMessage: { ...media, viewOnce: true } }]
  const records = contents.map((message, i) => ({ id: String(i), threadJid: jid, fromMe: false, timestampMs, messageBytes: proto.Message.encode(message).finish() }))
  const before = JSON.stringify(records)
  const store: any = { threads: { getByJid: async () => ({ jid }) }, messages: { getById: async (id: string) => records[Number(id)] } }
  const redis = { scan: async () => ({ cursor: 0, keys: [`p:msg:idx:${phone}:${jid}`] }), zRange: async (_key: string, start: number, end: number) => records.slice(start, end + 1).map(r => r.id) }
  const run = async (imageId: string, threadJid = jid) => {
    const result: proto.HistorySync[] = []
    const pages = streamCompanionHistory(store, redis, 'p:', phone, false, undefined, { imageId, threadJid })
    for await (const p of threeChunkHistory(pages, 192000, 'text-video-sticker-image')) {
      const n = p.message.historySyncNotification!
      const h = proto.HistorySync.decode(inflateSync(n.initialHistBootstrapInlinePayload!))
      expect(h.progress).toBe(n.progress)
      expect(h.chunkOrder).toBe(n.chunkOrder)
      result.push(h)
    }
    return result
  }
  const packets = await run('1')
  expect(packets.map(p => p.progress)).toEqual([50, 100])
  const messages = packets.flatMap(p => p.conversations.flatMap(c => c.messages.map(m => m.message!)))
  expect(messages.map(m => m.key!.id)).toEqual(['0', '1'])
  const image = messages[1].message!.imageMessage!
  expect(image.contextInfo?.stanzaId).toBe(contextInfo.stanzaId)
  expect(image.contextInfo?.mentionedJid).toEqual(contextInfo.mentionedJid)
  expect(image.url).toBe(media.url)
  expect(image.directPath).toBe(media.directPath)
  expect(Buffer.from(image.mediaKey!)).toEqual(media.mediaKey)
  expect(Number(messages[1].messageTimestamp)).toBe(Math.floor(timestampMs / 1000))
  for (const [id, thread] of [['5', jid], ['missing', jid], ['1', 'other@lid']]) {
    const filtered = await run(id, thread)
    expect(filtered.flatMap(p => p.conversations.flatMap(c => c.messages))).toHaveLength(1)
  }
  expect(JSON.stringify(records)).toBe(before)
})
