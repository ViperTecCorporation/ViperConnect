import { proto, downloadMediaMessage } from 'zapo-js'
import { Readable } from 'node:stream'
import { SessionMessageMedia } from '../../src/services/messages/session_message_media'
import { SessionMessages } from '../../src/services/messages/session_messages'

jest.mock('zapo-js', () => ({ ...jest.requireActual('zapo-js'), downloadMediaMessage: jest.fn() }))
const setup = (message: any = { imageMessage: { mimetype: 'image/png' } }) => {
  const record = { id: 'ABC', threadJid: '123@lid', fromMe: false, timestampMs: Date.now(), messageBytes: proto.Message.encode(message).finish() }
  const redis = { get: jest.fn().mockResolvedValue(null) }
  const index = { records: jest.fn().mockResolvedValue([record]), redis, key: (_phone: string, part: string) => part }
  const mediaStore = { hasMedia: jest.fn().mockResolvedValue(false), removeMedia: jest.fn().mockResolvedValue(undefined), getFilePath: jest.fn((_phone, id, _mime, _name) => `5511999999999/${id}.png`), saveMediaStream: jest.fn().mockResolvedValue(true) }
  const dataStore = { loadMediaPayload: jest.fn().mockResolvedValue(null) }
  const service = { index: jest.fn().mockResolvedValue(index), loadConfig: jest.fn().mockResolvedValue({ getStore: jest.fn().mockResolvedValue({ mediaStore, dataStore }) }) } as unknown as SessionMessages
  jest.mocked(downloadMediaMessage).mockResolvedValue(Readable.from(Buffer.from('fixture')))
  return { media: new SessionMessageMedia(service), service, index, mediaStore, dataStore, redis }
}
describe('lazy authorized session media', () => {
  beforeEach(() => jest.clearAllMocks())
  test.each(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'])('blocks %s without storage/CDN lookup', async wrapper => {
    const { media, mediaStore } = setup({ [wrapper]: { message: { imageMessage: { mimetype: 'image/png' } } } })
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('message_media_not_available')
    expect(mediaStore.hasMedia).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
  })
  test('blocks revoked and expired/missing messages', async () => {
    const { media, redis, index } = setup()
    redis.get.mockResolvedValueOnce(JSON.stringify({ type: 'revoked' }))
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('message_media_not_available')
    index.records.mockResolvedValue([])
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('message_not_found')
  })
  test('reuses stored UnoAPI mapped bytes without a CDN request', async () => {
    const { media, redis, dataStore, mediaStore } = setup()
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('uno-mapped')
    dataStore.loadMediaPayload.mockResolvedValue({ mime_type: 'image/png', filename: 'x.png' } as any)
    mediaStore.hasMedia.mockResolvedValue(true)
    const result = await media.load('5511999999999', 'ABC')
    expect(result.file).toBe('5511999999999/uno-mapped.png'); expect(downloadMediaMessage).not.toHaveBeenCalled()
  })
  test('deduplicates concurrent lazy download with byte/time limits and closes stream', async () => {
    const { media, mediaStore } = setup()
    const stream = Readable.from(Buffer.from('fixture')); const destroy = jest.spyOn(stream, 'destroy')
    jest.mocked(downloadMediaMessage).mockResolvedValue(stream)
    await Promise.all([media.load('5511999999999', 'ABC'), media.load('5511999999999', 'ABC')])
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1)
    expect(downloadMediaMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 268435456, timeoutMs: 60000 }))
    expect(mediaStore.saveMediaStream).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalled()
  })
  test('rejects bad IDs and non-media', async () => {
    const { media } = setup({ conversation: 'text' })
    await expect(media.load('5511999999999', '../secret')).rejects.toThrow('invalid_message_id')
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('message_has_no_media')
  })
  test('removes an incomplete lazy download before a retry', async () => {
    const { media, mediaStore } = setup()
    mediaStore.saveMediaStream.mockRejectedValueOnce(new Error('interrupted'))
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('interrupted')
    expect(mediaStore.removeMedia).toHaveBeenCalledWith('5511999999999/ABC.png')
    await expect(media.load('5511999999999', 'ABC')).resolves.toHaveProperty('file')
  })
})
