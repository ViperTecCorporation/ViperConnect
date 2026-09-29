import { proto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { collectCompanionHistory, historyPackets } from '../../src/services/mobile_primary/companion_history_payload'
const now = 1800000000000, jid = '999123456789@s.whatsapp.net'
function record(message: any, extra = {}) { return { id: 'original-id', threadJid: jid, fromMe: false, timestampMs: now - 1000, messageBytes: proto.Message.encode(message).finish(), ...extra } }
function store(records: any[], threads: any[] = [{ jid }]): any { return { threads: { list: jest.fn().mockResolvedValue(threads) }, messages: { listByThread: jest.fn().mockResolvedValue(records) } } }
const media = { directPath: '/v/t62/test', url: 'https://mmg.whatsapp.net/test', mediaKey: Buffer.alloc(32, 1), fileSha256: Buffer.alloc(32, 2), fileEncSha256: Buffer.alloc(32, 3), mimetype: 'application/octet-stream', fileLength: 1234 }
test.each(['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage'])('preserves %s references without downloading media', async field => {
  const result = await collectCompanionHistory(store([record({ [field]: media })]), now)
  expect(result.count).toBe(1)
  const packets = await historyPackets(result.conversations)
  const notification = packets[0].message.historySyncNotification!
  const history = proto.HistorySync.decode(inflateSync(notification.initialHistBootstrapInlinePayload!))
  const message = history.conversations[0].messages[0].message!
  expect(message.key?.id).toBe('original-id')
  expect(message.message?.[field].directPath).toBe(media.directPath)
  expect(Buffer.from(message.message?.[field].mediaKey)).toEqual(media.mediaKey)
  expect(notification.progress).toBe(100)
})
test.each([
  { viewOnceMessage: { message: { imageMessage: media } } },
  { ephemeralMessage: { message: { conversation: 'temporary' } } },
  { imageMessage: { ...media, viewOnce: true } },
  { viewOnceMessageV2: { message: { imageMessage: media } } },
  { stickerMessage: { ...media, contextInfo: { expiration: 60 } } },
  { audioMessage: { ...media, contextInfo: { expiration: 3600 } } },
  { documentMessage: { ...media, mediaKey: Buffer.alloc(1) } },
  { extendedTextMessage: { text: 'expired', contextInfo: { expiration: 60 } } },
  { protocolMessage: { type: 0 } },
])('does not export ephemeral, view-once, protocol or incomplete media %#', async message => {
  expect((await collectCompanionHistory(store([record(message)]), now)).count).toBe(0)
})

test('baseline strips image context but preserves scan metadata without mutating the archive', async () => {
  const contextInfo = { mentionedJid: ['123@lid'], stanzaId: 'quoted-message' }
  const image = { ...media, contextInfo, firstScanLength: 12, firstScanSidecar: Buffer.from([1, 2]), scansSidecar: Buffer.from([3, 4]), midQualityFileSha256: Buffer.alloc(32, 4) }
  const result = await collectCompanionHistory(store([record({ imageMessage: image })]), now)
  const packets = await historyPackets(result.conversations)
  const history = proto.HistorySync.decode(inflateSync(packets[0].message.historySyncNotification!.initialHistBootstrapInlinePayload!))
  const exported = history.conversations[0].messages[0].message!.message!.imageMessage!
  expect(exported.contextInfo).toBeNull()
  expect(image.contextInfo).toEqual(contextInfo)
  expect(exported.firstScanLength).toBe(12)
  expect(Buffer.from(exported.scansSidecar!)).toEqual(image.scansSidecar)
  expect(Buffer.from(exported.midQualityFileSha256!)).toEqual(image.midQualityFileSha256)
})
test('deduplicates by conversation/id/direction, excludes old and future records', async () => {
  const r = record({ conversation: 'hello' })
  const result = await collectCompanionHistory(store([r, r, { ...r, id: 'old', timestampMs: now - 8 * 86400000 }, { ...r, id: 'future', timestampMs: now + 1000 }]), now)
  expect(result.count).toBe(1)
  expect(result.conversations[0].messages![0].message!.messageTimestamp).toBe((now - 1000) / 1000)
})
test('omits ephemeral threads, malformed records and mismatched scopes', async () => {
  expect((await collectCompanionHistory(store([record({ conversation: 'hello' })], [{ jid, ephemeralExpiration: 60 }]), now)).count).toBe(0)
  expect((await collectCompanionHistory(store([record({}, { messageBytes: Buffer.from([255]) }), record({ conversation: 'hi' }, { threadJid: 'other' })]), now)).count).toBe(0)
})
test('splits packets preserving original keys and monotonically increasing chunk order', async () => {
  const result = await collectCompanionHistory(store(Array.from({ length: 45 }, (_, i) => record({ conversation: 'hello' }, { id: String(i) }))), now)
  const packets = await historyPackets(result.conversations)
  expect(packets.map(p => p.count)).toEqual([20, 20, 5])
  expect(packets.map(p => p.message.historySyncNotification!.chunkOrder)).toEqual([0, 1, 2])
  expect(packets[2].message.historySyncNotification!.progress).toBe(100)
  const conversations = packets.map(p => proto.HistorySync.decode(inflateSync(p.message.historySyncNotification!.initialHistBootstrapInlinePayload!)).conversations[0])
  expect(conversations.map(c => c.endOfHistoryTransfer)).toEqual([false, false, true])
  expect(conversations.every(c => Number(c.conversationTimestamp) === (now - 1000) / 1000 && Number(c.lastMsgTimestamp) === (now - 1000) / 1000)).toBe(true)
})

test('uses the latest exported message timestamp and orders messages newest first', async () => {
  const result = await collectCompanionHistory(store([
    record({ conversation: 'old' }, { id: 'old', timestampMs: now - 3000 }),
    record({ conversation: 'new' }, { id: 'new', timestampMs: now - 1000 }),
    record({ conversation: 'middle' }, { id: 'middle', timestampMs: now - 2000 }),
  ]), now)
  expect(result.conversations[0].messages!.map(m => m.message!.key!.id)).toEqual(['new', 'middle', 'old'])
  expect(result.conversations[0].conversationTimestamp).toBe((now - 1000) / 1000)
})
test('does not replay original content with a known edit or revoke in the stored window', async () => {
  const original = record({ conversation: 'original' })
  const revoke = record({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: original.id } } }, { id: 'revoke' })
  expect((await collectCompanionHistory(store([original, revoke]), now)).count).toBe(0)
})
