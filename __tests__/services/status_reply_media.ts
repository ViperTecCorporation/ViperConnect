import { mock } from 'jest-mock-extended'
import { StatusReplyMedia } from '../../src/services/messages/status_reply_media'
import type { Store } from '../../src/services/store'
import type { DataStore } from '../../src/services/data_store'
import type { MediaStore } from '../../src/services/media_store'
import { adaptStatusReplyMediaForChatwoot } from '../../src/services/outgoing_cloud_api'

describe('status reply media', () => {
  const phone = '5566996269251'
  let store: Store
  let resolver: StatusReplyMedia
  let metadata: any
  const source = (type = 'videoMessage') => ({
    key: { id: 'reply', remoteJid: '123@lid', fromMe: false }, messageTimestamp: 1793849677,
    message: { extendedTextMessage: { text: '😂', contextInfo: {
      stanzaId: 'status', remoteJid: 'status@broadcast', participant: '556696269251@s.whatsapp.net',
      quotedMessage: { [type]: { mimetype: type === 'videoMessage' ? 'video/mp4' : 'image/jpeg', mediaKey: Buffer.alloc(32), directPath: '/encrypted' } },
    } } },
  })
  beforeEach(() => {
    store = { dataStore: mock<DataStore>(), mediaStore: mock<MediaStore>() } as Store
    resolver = new StatusReplyMedia()
    metadata = { resolve: jest.fn(async (_phone, value) => ({ ...value, __unoapiMediaBytes: Buffer.from('media') })) }
    ;(store.mediaStore.saveDownloadedMedia as jest.Mock).mockImplementation(async value => {
      ;(store.mediaStore.getMedia as jest.Mock).mockResolvedValue({ url: 'https://storage.test/status.mp4', mime_type: 'video/mp4', filename: 'status.mp4' })
      return value
    })
  })
  test.each(['imageMessage', 'videoMessage'])('decrypts %s through active provider and stores bytes before returning context', async type => {
    const result = await resolver.resolve(phone, source(type), store, metadata)
    expect(metadata.resolve).toHaveBeenCalledWith(phone, expect.objectContaining({ key: { id: 'status', remoteJid: 'status@broadcast', fromMe: true } }))
    expect(store.mediaStore.saveDownloadedMedia).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ [type]: expect.any(Object) }) }), Buffer.from('media'))
    expect(result).toMatchObject({ id: 'status', type, available: true, media: { url: 'https://storage.test/status.mp4' } })
    expect(JSON.stringify(result)).not.toContain('mediaKey')
  })
  test('reuses persisted media without downloading and resolves mapped status ID', async () => {
    ;(store.dataStore.loadProviderId as jest.Mock).mockResolvedValue('provider-status')
    ;(store.mediaStore.getMedia as jest.Mock).mockResolvedValue({ url: 'https://storage.test/signed' })
    expect(await resolver.resolve(phone, source(), store, metadata)).toMatchObject({ id: 'provider-status', available: true })
    expect(metadata.resolve).not.toHaveBeenCalled()
  })
  test('falls back to status archive when the quote is absent', async () => {
    const message = source()
    const quote = message.message.extendedTextMessage.contextInfo.quotedMessage
    delete message.message.extendedTextMessage.contextInfo.quotedMessage
    ;(store.dataStore.loadMessage as jest.Mock).mockResolvedValue({ key: { id: 'status' }, message: quote })
    expect(await resolver.resolve(phone, message, store, metadata)).toMatchObject({ available: true })
    expect(store.dataStore.loadMessage).toHaveBeenCalledWith('status@broadcast', 'status')
  })
  test.each(['foreign', 'ordinary', 'outgoing', 'viewOnce', 'missing'])('does not recover %s content', async kind => {
    const message: any = source()
    const context = message.message.extendedTextMessage.contextInfo
    if (kind === 'foreign') context.participant = '5511999999999@s.whatsapp.net'
    if (kind === 'ordinary') context.remoteJid = '123@lid'
    if (kind === 'outgoing') message.key.fromMe = true
    if (kind === 'viewOnce') context.quotedMessage.videoMessage.viewOnce = true
    if (kind === 'missing') delete context.quotedMessage
    const result = await resolver.resolve(phone, message, store, metadata)
    expect(result?.available).not.toBe(true)
    expect(metadata.resolve).not.toHaveBeenCalled()
  })
  test('download failure degrades to unavailable context, not a failed reply', async () => {
    metadata.resolve.mockRejectedValue(new Error('expired'))
    expect(await resolver.resolve(phone, source(), store, metadata)).toEqual({ id: 'status', available: false })
    expect(store.mediaStore.saveDownloadedMedia).not.toHaveBeenCalled()
  })
  test.each(['556696269251@s.whatsapp.net', '556696269251', '5566996269251'])('accepts own status participant LID mapped to %s in this session', async pn => {
    const message = source()
    message.message.extendedTextMessage.contextInfo.participant = '94047083475061:0@lid'
    const lookup = jest.fn().mockResolvedValue(pn)
    expect(await resolver.resolve(phone, message, store, metadata, lookup)).toMatchObject({ available: true })
    expect(lookup).toHaveBeenCalledWith('94047083475061@lid')
  })
  test.each([undefined, '5511999999999@s.whatsapp.net', '12345@lid'])('rejects missing, foreign or invalid LID mapping: %s', async pn => {
    const message = source()
    message.message.extendedTextMessage.contextInfo.participant = '94047083475061@lid'
    expect(await resolver.resolve(phone, message, store, metadata, async () => pn)).toBeUndefined()
    expect(metadata.resolve).not.toHaveBeenCalled()
  })
  test('LID lookup failure preserves the reply without trying to download media', async () => {
    const message = source()
    message.message.extendedTextMessage.contextInfo.participant = '94047083475061@lid'
    expect(await resolver.resolve(phone, message, store, metadata, async () => { throw Error('store unavailable') })).toEqual({ id: 'status', available: false })
    expect(metadata.resolve).not.toHaveBeenCalled()
  })
  test('concurrent replies share one download', async () => {
    await Promise.all([resolver.resolve(phone, source(), store, metadata), resolver.resolve(phone, source(), store, metadata)])
    expect(metadata.resolve).toHaveBeenCalledTimes(1)
  })
})

describe('status webhook quote contract', () => {
  const payload = (from = '5511999999999', status = 'status') => ({ entry: [{ changes: [{ value: { messages: [{
    id: 'reply', from, type: 'text', text: { body: '😂' }, provider_message_id: 'reply-provider',
    context: { id: 'original-status', provider_message_id: 'status-provider', status: { id: status, type: 'videoMessage', media: { url: 'https://storage.test/status', mime_type: 'video/mp4' } } },
  }] } }] }] })
  const messages = (value: any) => value.entry[0].changes[0].value.messages
  test('stable parent per session/status/contact, reply references parent without false provider ID', () => {
    const first: any[] = messages(adaptStatusReplyMediaForChatwoot(payload(), 'session'))
    const retry = messages(adaptStatusReplyMediaForChatwoot(payload(), 'session'))
    const other = messages(adaptStatusReplyMediaForChatwoot(payload('5511888888888'), 'session'))
    expect(first.map(message => message.type)).toEqual(['video', 'text'])
    expect(first[0].id).toBe(retry[0].id)
    expect(first[0].id).not.toBe(other[0].id)
    expect(first[0].context).toBeUndefined()
    expect(first[0].provider_message_id).toBeUndefined()
    expect(first[1].context.id).toBe(first[0].id)
    expect(first[1].context.message_id).toBe(first[0].id)
    expect(first[1].context.provider_message_id).toBeUndefined()
    expect(first[1].provider_message_id).toBe('reply-provider')
  })
  test('unavailable media keeps original reply untouched', () => {
    const body: any = payload()
    delete body.entry[0].changes[0].value.messages[0].context.status.media
    expect(messages(adaptStatusReplyMediaForChatwoot(body, 'session'))).toHaveLength(1)
    expect(messages(body)[0].context.id).toBe('original-status')
  })
})
