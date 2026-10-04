import { proto, WaMediaCrypto } from 'zapo-js'
import { inflateSync } from 'node:zlib'
import { historyPackets } from '../../src/services/mobile_primary/companion_history_payload'
import { continuationNotification } from '../../src/services/mobile_primary/companion_history_continuation'
import { uploadCompanionHistory } from '../../src/services/mobile_primary/companion_history_upload'
import { dirname, join } from 'node:path'

test('RECENT CDN notification preserves messages and is decryptable with history keys; no inline payload', async () => {
  const input = [{ id: '123@lid', messages: [{ message: { key: { id: 'm1', remoteJid: '123@lid' }, messageTimestamp: 1234,
    message: { imageMessage: { directPath: '/image', mediaKey: Buffer.alloc(32, 2) } } } }] }]
  const [packet] = await historyPackets(input)
  let bytes!: Uint8Array
  const key = await WaMediaCrypto.generateMediaKey()
  const upload = jest.fn(async (source: Uint8Array) => {
    bytes = source
    const encrypted = await WaMediaCrypto.encryptBytes('history', key, source, { sidecar: false })
    const decrypted = await WaMediaCrypto.decryptBytes('history', key, encrypted.ciphertextHmac, encrypted.fileSha256, encrypted.fileEncSha256)
    expect(Buffer.from(decrypted.plaintext)).toEqual(Buffer.from(source))
    return { directPath: '/history', mediaKey: key, fileLength: source.length, fileSha256: encrypted.fileSha256, fileEncSha256: encrypted.fileEncSha256 }
  })
  const result = await continuationNotification(packet.message, upload)
  const n = result.historySyncNotification!
  expect(n.syncType).toBe(proto.Message.HistorySyncType.RECENT)
  expect(n.initialHistBootstrapInlinePayload).toBeUndefined()
  expect(n.oldestMsgInChunkTimestampSec).toBe(1234)
  expect(n.progress).toBe(100)
  const decoded = proto.HistorySync.decode(inflateSync(bytes))
  expect(decoded.syncType).toBe(proto.HistorySync.HistorySyncType.RECENT)
  expect(decoded.conversations[0].messages[0].message?.message?.imageMessage?.directPath).toBe('/image')
})
test('upload failures propagate without producing a partial notification', async () => {
  const [packet] = await historyPackets([{ id: '123@lid', messages: [{ message: { message: { conversation: 'x' } } }] }])
  await expect(continuationNotification(packet.message, async () => { throw new Error('upload failed') })).rejects.toThrow('upload failed')
  await expect(continuationNotification(packet.message, async () => ({ directPath: '', mediaKey: Buffer.alloc(1), fileSha256: Buffer.alloc(1), fileEncSha256: Buffer.alloc(1), fileLength: 0 }))).rejects.toThrow('upload_invalid')
})
test('advanced adapter uses installed SDK upload with history crypto and md-msg-hist route, preserving configured transport', async () => {
  const root = dirname(require.resolve('zapo-js'))
  const sdk = require(join(root, 'client/messaging/messages.js'))
  const { MEDIA_UPLOAD_PATHS } = require(join(root, 'media/constants.js'))
  expect(typeof sdk.uploadMedia).toBe('function')
  expect(MEDIA_UPLOAD_PATHS['md-msg-hist']).toBe('/mms/md-msg-hist')
  const upload = jest.spyOn(sdk, 'uploadMedia').mockResolvedValue({ directPath: '/test' })
  try {
    const options = { mediaTransfer: {}, queryWithContext: jest.fn() }, bytes = Buffer.from('compressed history')
    await uploadCompanionHistory({ deps: { mediaMessageBuildOptions: options } } as any, bytes)
    expect(upload).toHaveBeenCalledWith(options, expect.objectContaining({ source: bytes, cryptoType: 'history', uploadPath: '/mms/md-msg-hist', sidecar: false }))
  } finally { upload.mockRestore() }
})
