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
  const config: any = { getStore: jest.fn().mockResolvedValue({ mediaStore, dataStore }) }
  const service = { index: jest.fn().mockResolvedValue(index), loadConfig: jest.fn().mockResolvedValue(config) } as unknown as SessionMessages
  jest.mocked(downloadMediaMessage).mockResolvedValue(Readable.from(Buffer.from('fixture')))
  return { media: new SessionMessageMedia(service), service, index, mediaStore, dataStore, redis, config }
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
    redis.get.mockImplementation(async key => key === 'state:ABC' ? JSON.stringify({ type: 'revoked' }) : null)
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('message_media_not_available')
    index.records.mockResolvedValue([])
    await expect(media.load('5511999999999', 'ABC')).rejects.toThrow('message_not_found')
  })
  test('reuses stored UnoAPI mapped bytes without a CDN request', async () => {
    const { media, redis, dataStore, mediaStore } = setup()
    redis.get.mockImplementation(async key => key === 'unoapi-id:5511999999999:ABC' ? 'uno-mapped' : key === 'unoapi-id_rev:5511999999999:uno-mapped' ? 'ABC' : null)
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

  const phone = '5511999999999'
  const aliases = (redis: any, extra: Record<string, string> = {}) => {
    const values = { [`unoapi-id:${phone}:ABC`]: 'UNO_PUBLIC', [`unoapi-id_rev:${phone}:UNO_PUBLIC`]: 'ABC', ...extra }
    redis.get.mockImplementation(async key => values[key] || null)
  }
  test.each(['ABC', 'UNO_PUBLIC'])('Redis resolves %s through reciprocal session-local mappings and reuses Uno cache', async id => {
    const { media, redis, index, dataStore, mediaStore } = setup()
    aliases(redis)
    const original = { id: 'ABC', threadJid: '123@lid', fromMe: true, timestampMs: Date.now(), messageBytes: proto.Message.encode({ imageMessage: { mimetype: 'image/png' } }).finish() }
    index.records.mockImplementation(async (_phone, ids) => ids[0] === 'ABC' ? [original] : [])
    dataStore.loadMediaPayload.mockImplementation(async value => value === 'UNO_PUBLIC' ? { mime_type: 'image/png', filename: 'original.png' } : null)
    mediaStore.hasMedia.mockResolvedValue(true)
    expect(await media.load(phone, id)).toMatchObject({ file: `${phone}/UNO_PUBLIC.png` })
    expect(index.records).toHaveBeenCalledWith(phone, ['ABC'])
    expect(downloadMediaMessage).not.toHaveBeenCalled()
    expect(redis.get.mock.calls.every(([key]) => key.startsWith(`unoapi-id:${phone}:`) || key.startsWith(`unoapi-id_rev:${phone}:`) || key.startsWith('state:'))).toBe(true)
  })

  test('Redis shares one canonical download across concurrent public Uno and native provider IDs', async () => {
    const { media, redis, mediaStore } = setup()
    aliases(redis)
    const [publicId, providerId] = await Promise.all([media.load(phone, 'UNO_PUBLIC'), media.load(phone, 'ABC')])
    expect(publicId).toEqual(providerId)
    expect(publicId.file).toBe(`${phone}/ABC.png`)
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1)
    expect(mediaStore.saveMediaStream).toHaveBeenCalledTimes(1)
  })

  test.each(['ABC', 'UNO_PUBLIC'])('Uno alias cannot bypass a revoked Redis overlay stored under %s', async overlay => {
    const { media, redis, mediaStore } = setup()
    aliases(redis, { [`state:${overlay}`]: JSON.stringify({ type: 'revoked' }) })
    await expect(media.load(phone, 'UNO_PUBLIC')).rejects.toThrow('message_media_not_available')
    expect(mediaStore.hasMedia).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
  })

  test.each(['expired', 'foreign', 'one-sided', 'unsafe'])('Redis mapping %s never triggers a scan, cache read or guessed provider ID', async reason => {
    const { media, redis, index, mediaStore } = setup()
    if (reason === 'expired') redis.get.mockResolvedValue(null)
    if (reason === 'foreign') redis.get.mockImplementation(async key => key === 'unoapi-id_rev:999123456789:UNO_PUBLIC' ? 'ABC' : null)
    if (reason === 'one-sided') aliases(redis, { [`unoapi-id:${phone}:ABC`]: 'DIFFERENT' })
    if (reason === 'unsafe') aliases(redis, { [`unoapi-id_rev:${phone}:UNO_PUBLIC`]: '../foreign' })
    if (reason === 'expired' || reason === 'foreign') index.records.mockResolvedValue([])
    await expect(media.load(phone, 'UNO_PUBLIC')).rejects.toThrow(reason === 'one-sided' || reason === 'unsafe' ? 'media_id_mapping_invalid' : 'message_not_found')
    expect(mediaStore.hasMedia).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
  })

  test('migration/backend change during ID resolution fails before opening a media store', async () => {
    const { media, redis, config, mediaStore } = setup()
    redis.get.mockImplementation(async () => {
      config.sessionStorage = { backend: 'redis', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'fixture', generation: 2, state: 'migrating' }
      return null
    })
    await expect(media.load(phone, 'ABC')).rejects.toThrow('session_storage_operation_in_progress')
    expect(mediaStore.hasMedia).not.toHaveBeenCalled(); expect(downloadMediaMessage).not.toHaveBeenCalled()
  })

  test('enabling fixture isolation while a download is in flight refuses both the old return and a shared result', async () => {
    const { media, config, mediaStore } = setup()
    let finish!: (value: boolean) => void
    mediaStore.saveMediaStream.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
    const first = media.load(phone, 'ABC')
    for (let i = 0; i < 100 && !finish; i++) await Promise.resolve()
    expect(finish).toBeDefined()
    config.sessionStorage = { backend: 'redis', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'fixture', generation: 2, state: 'offline', fixture: true }
    await expect(media.load(phone, 'ABC')).rejects.toThrow('external_effects_forbidden')
    finish(true)
    await expect(first).rejects.toThrow('external_effects_forbidden')
    expect(mediaStore.saveMediaStream).toHaveBeenCalledTimes(1)
  })
})
