import { proto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { streamCompanionHistory } from '../../src/services/mobile_primary/companion_history_stream'

test('text-video allowlist excludes every other content type without editing stored records', async () => {
  const phone = '999123456789', jid = '123@lid'
  const media = { directPath: '/test', mediaKey: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32) }
  const content = [
    { conversation: 'plain' }, { extendedTextMessage: { text: 'extended' } },
    { videoMessage: media }, { imageMessage: media }, { stickerMessage: media },
    { audioMessage: media }, { documentMessage: media },
    { locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } },
    { contactMessage: { displayName: 'Contact', vcard: 'test' } },
    { videoMessage: { ...media, viewOnce: true } },
    { videoMessage: { ...media, contextInfo: { expiration: 60 } } },
  ]
  const records = content.map((message, id) => ({ id: String(id), threadJid: jid, timestampMs: Date.now() - 10000, messageBytes: proto.Message.encode(message).finish() }))
  const before = JSON.stringify(records)
  const store: any = { threads: { getByJid: async () => ({ jid }) }, messages: { getById: async (id: string) => records[Number(id)] } }
  const redis = { scan: async () => ({ cursor: 0, keys: [`p:msg:idx:${phone}:${jid}`] }), zRange: async (_key: string, start: number, end: number) => records.slice(start, end + 1).map(r => r.id) }
  const ids: string[] = []
  for await (const p of streamCompanionHistory(store, redis, 'p:', phone, 'text-video')) {
    const h = proto.HistorySync.decode(inflateSync(p.message.historySyncNotification!.initialHistBootstrapInlinePayload!))
    ids.push(...h.conversations.flatMap(c => c.messages.map(m => m.message!.key!.id!)))
  }
  expect(ids.sort()).toEqual(['0', '1', '2'])
  expect(JSON.stringify(records)).toBe(before)
})

test.each([false, true, 'text-video'] as const)('text-only experiment=%s preserves five chats, metadata and stored media', async textOnly => {
  const phone = '999123456789', prefix = `p:msg:idx:${phone}:`, timestampMs = Date.now() - 10000
  const media = { directPath: '/test', mediaKey: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32) }
  const records: Record<string, any> = {}, keys: string[] = [], ids: Record<string, string[]> = {}
  for (let i = 0; i < 5; i++) {
    const jid = `${123 + i}@lid`, key = prefix + jid
    keys.push(key); ids[key] = [`text${i}`]
    records[`text${i}`] = { id: `text${i}`, threadJid: jid, timestampMs, messageBytes: proto.Message.encode({ conversation: 'text' }).finish() }
    if (i >= 3) {
      ids[key].push(`media${i}`)
      records[`media${i}`] = { id: `media${i}`, threadJid: jid, timestampMs: timestampMs + 1000,
        messageBytes: proto.Message.encode({ [i === 3 ? 'videoMessage' : 'imageMessage']: media }).finish() }
    }
  }
  const before = JSON.stringify(records)
  const store: any = { threads: { getByJid: async () => null }, messages: { getById: async (id: string) => records[id] } }
  // Redis can return a different order and duplicates on each traversal.
  const redis = { scan: async () => ({ cursor: 0, keys: [...keys].reverse().concat(keys[0]) }), zRange: async (key: string, start: number, end: number) => ids[key].slice(start, end + 1) }
  const packets = []
  for await (const p of streamCompanionHistory(store, redis, 'p:', phone, textOnly)) packets.push(p)
  expect(packets).toHaveLength(5)
  expect(packets.map(p => p.count)).toEqual(textOnly === 'text-video' ? [1, 1, 1, 2, 1] : textOnly ? [1, 1, 1, 1, 1] : [1, 1, 1, 2, 2])
  for (let i = 0; i < packets.length; i++) {
    const n = packets[i].message.historySyncNotification!
    const h = proto.HistorySync.decode(inflateSync(n.initialHistBootstrapInlinePayload!))
    expect(n.chunkOrder).toBe(i)
    expect(n.progress).toBe(i === 4 ? 100 : undefined)
    expect(h.conversations[0].endOfHistoryTransfer).toBe(true)
    expect(Number(h.conversations[0].conversationTimestamp)).toBe(Math.floor((timestampMs + (i >= 3 ? 1000 : 0)) / 1000))
    if (textOnly) expect(h.conversations[0].messages.every(m => m.message?.message?.conversation === 'text'
      || (textOnly === 'text-video' && !!m.message?.message?.videoMessage))).toBe(true)
  }
  expect(JSON.stringify(records)).toBe(before)
})
test('streams more than 200 old messages with continuous ordering, no age cutoff or eager bodies', async () => {
  const ids = Array.from({ length: 241 }, (_, i) => String(i)), jid = '123@lid'
  const getById = jest.fn(async id => ({ id, threadJid: jid, fromMe: false, timestampMs: Date.now() - 90 * 86400000, messageBytes: proto.Message.encode({ conversation: 'old text' }).finish() }))
  const store: any = { threads: { getByJid: async () => null }, messages: { getById } }
  const redis = { scan: jest.fn().mockResolvedValue({ cursor: 0, keys: ['p:msg:idx:999123456789:' + jid] }), zRange: jest.fn(async (_key, start, end) => ids.slice(start, end + 1)) }
  const packets = []
  for await (const p of streamCompanionHistory(store, redis, 'p:', '999123456789')) packets.push(p)
  expect(packets.reduce((n, p) => n + p.count, 0)).toBe(241)
  for (let i = 0; i < packets.length; i++) {
    const n = packets[i].message.historySyncNotification!
    expect(n.chunkOrder).toBe(i)
    expect(n.progress).toBe(i === packets.length - 1 ? 100 : undefined)
    const h = proto.HistorySync.decode(inflateSync(n.initialHistBootstrapInlinePayload!))
    expect(h.chunkOrder).toBe(i)
    expect(h.syncType).toBe(proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP)
    expect(n.syncType).toBe(proto.Message.HistorySyncType.INITIAL_BOOTSTRAP)
    expect(h.conversations[0].endOfHistoryTransfer).toBe(i === packets.length - 1)
    expect(Object.prototype.hasOwnProperty.call(h.conversations[0], 'endOfHistoryTransferType')).toBe(false)
  }
  expect(redis.zRange.mock.calls.every(([, start, end]) => end - start === 19)).toBe(true)
})

test('completes each conversation separately, including with a trailing filtered page', async () => {
  const prefix = 'p:msg:idx:999123456789:'
  const keys = [prefix + '123@lid', prefix + '456@lid']
  const records: Record<string, any> = {}
  const first = Array.from({ length: 21 }, (_, i) => `a${i}`)
  for (const [index, id] of first.entries()) records[id] = { id, threadJid: '123@lid', timestampMs: Date.now() - 1000,
    messageBytes: proto.Message.encode(index === 20 ? { protocolMessage: { type: 0 } } : { conversation: 'text' }).finish() }
  records.b = { id: 'b', threadJid: '456@lid', timestampMs: Date.now() - 1000, messageBytes: proto.Message.encode({ conversation: 'second' }).finish() }
  const store: any = { threads: { getByJid: async () => null }, messages: { getById: async (id: string) => records[id] } }
  const redis = { scan: async () => ({ cursor: 0, keys }), zRange: async (key: string, start: number, end: number) => (key === keys[0] ? first : ['b']).slice(start, end + 1) }
  const decoded: any[] = []
  for await (const packet of streamCompanionHistory(store, redis, 'p:', '999123456789')) decoded.push(proto.HistorySync.decode(inflateSync(packet.message.historySyncNotification!.initialHistBootstrapInlinePayload!)))
  expect(decoded.map(h => h.conversations[0].id)).toEqual(['123@lid', '456@lid'])
  expect(decoded.map(h => h.conversations[0].endOfHistoryTransfer)).toEqual([true, true])
  expect(decoded.every(h => !Object.prototype.hasOwnProperty.call(h.conversations[0], 'endOfHistoryTransferType'))).toBe(true)
  expect(decoded[0].progress).not.toBe(100)
  expect(decoded[1].progress).toBe(100)
})

test('missing records do not prevent exporting later pages, without the experimental enum', async () => {
  const jid = '123@lid', key = 'p:msg:idx:999123456789:' + jid
  const ids = Array.from({ length: 22 }, (_, i) => String(i))
  const store: any = { threads: { getByJid: async () => null }, messages: { getById: async (id: string) => id === '0' ? null : {
    id, threadJid: jid, timestampMs: Date.now() - 1000, messageBytes: proto.Message.encode({ conversation: 'text' }).finish(),
  } } }
  const redis = { scan: async () => ({ cursor: 0, keys: [key] }), zRange: async (_key: string, start: number, end: number) => ids.slice(start, end + 1) }
  const decoded: any[] = []
  for await (const packet of streamCompanionHistory(store, redis, 'p:', '999123456789')) decoded.push(proto.HistorySync.decode(inflateSync(packet.message.historySyncNotification!.initialHistBootstrapInlinePayload!)))
  expect(decoded.flatMap(h => h.conversations[0].messages)).toHaveLength(21)
  expect(Object.prototype.hasOwnProperty.call(decoded[0].conversations[0], 'endOfHistoryTransferType')).toBe(false)
  expect(decoded[1].conversations[0].endOfHistoryTransfer).toBe(true)
  expect(Object.prototype.hasOwnProperty.call(decoded[1].conversations[0], 'endOfHistoryTransferType')).toBe(false)
})
