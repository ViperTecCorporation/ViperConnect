import { mockDeep } from 'jest-mock-extended'
import fetch from 'node-fetch'
import { dirname, join } from 'node:path'
import { proto, type WaClient, type WaStoreSession } from 'zapo-js'
import type { DataStore } from '../../src/services/data_store'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'
import { buildZapoEditContent, ZapoMessageEdit } from '../../src/services/zapo/zapo_message_edit'
import { toZapoMessageContent } from '../../src/services/zapo/zapo_message_mapper'

jest.mock('node-fetch', () => jest.fn())

const kinds = ['imageMessage', 'videoMessage', 'documentMessage'] as const
const media = (kind: typeof kinds[number]) => ({
  caption: 'teste mmm', mimetype: kind === 'imageMessage' ? 'image/jpeg' : kind === 'videoMessage' ? 'video/mp4' : 'application/pdf',
  url: 'https://example.test/original.enc', directPath: '/synthetic/original.enc',
  mediaKey: new Uint8Array(32).fill(1), fileSha256: new Uint8Array(32).fill(2), fileEncSha256: new Uint8Array(32).fill(3),
  fileLength: 1024, jpegThumbnail: new Uint8Array([7, 8]),
  ...(kind === 'documentMessage' ? { fileName: 'original.pdf', pageCount: 2 } : { width: 640, height: 480 }),
})

const setup = (group = false) => {
  const client = mockDeep<WaClient>(), cache = mockDeep<DataStore>(), store = mockDeep<WaStoreSession>()
  const target = group ? '120363000000001@g.us' : '123@lid'
  const key = { id: 'provider-original', remoteJid: target, fromMe: true, participant: '111@lid' }
  cache.loadProviderId.mockImplementation(async id => id === 'uno-original' ? key.id : undefined)
  cache.loadKey.mockResolvedValue(key)
  client.message.send.mockResolvedValue({ id: 'provider-edit' } as never)
  const service = new ZapoMessages(client, cache, { store })
  const payload = { to: target, type: 'message_edit', context: { message_id: 'uno-original' }, text: { body: 'teste mmm 2' } }
  return { client, cache, store, key, service, payload, target }
}

describe('Zapo media caption editing (synthetic, no transport)', () => {
  beforeEach(() => jest.clearAllMocks())
  test.each(kinds)('the actual installed Zapo builder accepts edited %s without an upload', async kind => {
    const sdkRoot = dirname(require.resolve('zapo-js/package.json'))
    const { buildMediaMessageContent } = require(join(sdkRoot, 'dist/client/messaging/messages.js'))
    const content = buildZapoEditContent({ [kind]: media(kind) }, 'teste mmm 2')
    // Empty dependencies are intentional: the real raw-proto branch must not upload/fetch.
    const built = await buildMediaMessageContent({}, content, { to: '123@lid' })
    expect(built.upload).toBeUndefined()
    expect(built.message[kind].caption).toBe('teste mmm 2')
    expect(Object.keys(built.message)).toEqual([kind])
  })
  test.each(kinds.flatMap(kind => [false, true].map(group => ({ kind, group }))))('delivers original $kind to SDK with only caption changed (group=$group)', async ({ kind, group }) => {
    const { client, cache, key, service, payload, target } = setup(group)
    const original = { [kind]: media(kind) }
    const originalBytes = proto.Message.encode(original).finish()
    cache.loadMessageExact.mockResolvedValue({ key, message: original })
    const result = await service.send(payload, { unoMessageId: 'uno-edit-event' })
    expect(client.message.send).toHaveBeenCalledTimes(1)
    const [jid, content, options] = client.message.send.mock.calls[0]
    expect(jid).toBe(target)
    expect(Object.keys(content)).toEqual([kind])
    expect(content).not.toHaveProperty('type')
    expect(Object.hasOwn(content, 'conversation')).toBe(false)
    expect(Object.hasOwn(content, 'extendedTextMessage')).toBe(false)
    const edited = (content as proto.IMessage)[kind]!
    expect(edited.caption).toBe('teste mmm 2')
    const restored = proto.Message.encode({ [kind]: { ...edited, caption: 'teste mmm' } }).finish()
    expect(restored).toEqual(originalBytes)
    expect(proto.Message.encode(original).finish()).toEqual(originalBytes)
    expect(options.editKey).toEqual({ id: 'provider-original', ...(group ? { participant: '111@lid' } : {}) })
    expect(result.ok.messages[0].id).toBe('uno-edit-event')
    expect(cache.setKey).toHaveBeenCalledWith('uno-edit-event', expect.objectContaining({ id: 'provider-edit', remoteJid: target }))
    expect(fetch).not.toHaveBeenCalled()
  })
  test.each(kinds)('decodes full original %s from official Zapo store without a cache hit', async kind => {
    const { client, store, cache, key, service, payload } = setup()
    store.messages.getById.mockResolvedValue({ id: key.id, threadJid: key.remoteJid, fromMe: true, timestampMs: 1790000000000,
      messageBytes: proto.Message.encode({ [kind]: media(kind) }).finish() })
    await service.send(payload)
    expect(client.message.send.mock.calls[0][1]).toHaveProperty(`${kind}.caption`, 'teste mmm 2')
    expect(store.messages.getById).toHaveBeenCalledWith('provider-original')
    expect(cache.loadMessage).not.toHaveBeenCalled()
  })
  test('falls back to the legacy cache when exact cache is absent', async () => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessage.mockResolvedValue({ key, message: { imageMessage: media('imageMessage') } })
    await service.send(payload)
    expect(cache.loadMessage).toHaveBeenCalledWith(key.remoteJid, key.id)
    expect(client.message.send.mock.calls[0][1]).toHaveProperty('imageMessage.caption', 'teste mmm 2')
  })
  test('unwraps a document caption wrapper while retaining document descriptors', () => {
    expect(buildZapoEditContent({ documentWithCaptionMessage: { message: { documentMessage: media('documentMessage') } } }, 'Nova'))
      .toHaveProperty('documentMessage.caption', 'Nova')
  })
  test('allows clearing a caption and repeated edits without mutating the original', async () => {
    const { client, cache, key, service, payload } = setup()
    const original = { imageMessage: media('imageMessage') }
    cache.loadMessageExact.mockResolvedValue({ key, message: original })
    await service.send({ ...payload, text: { body: '' } })
    await service.send(payload)
    expect(client.message.send.mock.calls[0][1]).toHaveProperty('imageMessage.caption', '')
    expect(client.message.send.mock.calls[1][1]).toHaveProperty('imageMessage.caption', 'teste mmm 2')
    expect(original.imageMessage.caption).toBe('teste mmm')
  })
  test.each([{ conversation: 'Original' }, { extendedTextMessage: { text: 'Original', contextInfo: { stanzaId: 'reply' } } }])('preserves ordinary text editing %p', async original => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessageExact.mockResolvedValue({ key, message: original })
    await service.send(payload)
    expect(client.message.send).toHaveBeenCalledWith(key.remoteJid, { type: 'text', text: 'teste mmm 2' }, { editKey: { id: key.id } })
  })
  test('rejects a missing original key', async () => {
    const { client, cache, service, payload } = setup()
    cache.loadKey.mockResolvedValue(undefined)
    await expect(service.send(payload)).rejects.toThrow('message_not_found')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('rejects missing original content rather than guessing text', async () => {
    const { client, service, payload } = setup()
    await expect(service.send(payload)).rejects.toThrow('message_edit_original_content_not_found')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('rejects messages from another sender', async () => {
    const { client, cache, key, service, payload } = setup(true)
    cache.loadKey.mockResolvedValue({ ...key, fromMe: false })
    await expect(service.send(payload)).rejects.toThrow('message_edit_original_not_from_me')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('rejects an explicit destination different from the original chat', async () => {
    const { client, service, payload } = setup()
    await expect(service.send({ ...payload, to: '999@lid' })).rejects.toThrow('message_edit_target_mismatch')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('can derive the destination from the original key when omitted', async () => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessageExact.mockResolvedValue({ key, message: { videoMessage: media('videoMessage') } })
    await service.send({ ...payload, to: undefined })
    expect(client.message.send.mock.calls[0][0]).toBe(key.remoteJid)
  })
  test.each(['mediaKey', 'fileSha256', 'fileEncSha256'] as const)('rejects incomplete original %s without SDK invocation', async field => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessageExact.mockResolvedValue({ key, message: { imageMessage: { ...media('imageMessage'), [field]: undefined } } })
    await expect(service.send(payload)).rejects.toThrow('message_edit_original_media_incomplete')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('rejects missing media location', () => {
    expect(() => buildZapoEditContent({ imageMessage: { ...media('imageMessage'), url: '', directPath: '' } }, 'Nova')).toThrow('message_edit_original_media_incomplete')
  })
  test.each([{ audioMessage: { mimetype: 'audio/ogg' } }, { stickerMessage: {} }, { imageMessage: { ...media('imageMessage'), viewOnce: true } },
    { viewOnceMessageV2: { message: { imageMessage: media('imageMessage') } } }])('rejects unsupported originals %p', async original => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessageExact.mockResolvedValue({ key, message: original })
    await expect(service.send(payload)).rejects.toThrow('422:')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('rejects a body that is not a string', async () => {
    const { client, service, payload } = setup()
    await expect(service.send({ ...payload, text: { body: 123 } })).rejects.toThrow('message_edit_text_body_required')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('does not convert a provider rejection into a text edit or independent send', async () => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessageExact.mockResolvedValue({ key, message: { imageMessage: media('imageMessage') } })
    client.message.send.mockRejectedValue(new Error('edit rejected'))
    await expect(service.send(payload)).rejects.toThrow('edit rejected')
    expect(client.message.send).toHaveBeenCalledTimes(1)
    expect(client.message.send.mock.calls[0][1]).toHaveProperty('imageMessage')
  })
  test('blocks unresolved edits in the mapper and the independent delivery recovery path', async () => {
    const { client, service, payload } = setup()
    await expect(toZapoMessageContent(client, payload)).rejects.toThrow('message_edit_original_content_required')
    await expect(service.recoverDelivery(payload)).rejects.toThrow('message_edit_delivery_recovery_unsupported')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test.each(['id', 'threadJid', 'fromMe'])('rejects a conflicting stored original %s', async field => {
    const { client, store, key, service, payload } = setup()
    store.messages.getById.mockResolvedValue({ id: key.id, threadJid: key.remoteJid, fromMe: true, timestampMs: 1,
      messageBytes: proto.Message.encode({ imageMessage: media('imageMessage') }).finish(), [field]: field === 'fromMe' ? false : 'other' } as never)
    await expect(service.send(payload)).rejects.toThrow('message_edit_original_')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('rejects corrupted original protobuf bytes', async () => {
    const { client, store, key, service, payload } = setup()
    store.messages.getById.mockResolvedValue({ id: key.id, threadJid: key.remoteJid, fromMe: true, timestampMs: 1, messageBytes: new Uint8Array([255]) })
    await expect(service.send(payload)).rejects.toThrow('message_edit_original_content_invalid')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test.each(['id', 'remoteJid', 'fromMe'])('rejects a conflicting cached original %s', async field => {
    const { client, cache, key, service, payload } = setup()
    cache.loadMessageExact.mockResolvedValue({ key: { ...key, [field]: field === 'fromMe' ? false : 'other' }, message: { imageMessage: media('imageMessage') } })
    await expect(service.send(payload)).rejects.toThrow('message_edit_original_')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  test('propagates a store outage without looking up an unrelated cache record', async () => {
    const { client, cache, store, key } = setup()
    store.messages.getById.mockRejectedValue(new Error('store offline'))
    await expect(new ZapoMessageEdit(cache, store).original(key)).rejects.toThrow('store offline')
    expect(client.message.send).not.toHaveBeenCalled()
    expect(cache.loadMessage).not.toHaveBeenCalled()
  })
})
