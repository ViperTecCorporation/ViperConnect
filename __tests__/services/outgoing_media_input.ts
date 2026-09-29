jest.mock('../../src/defaults', () => ({
  ...jest.requireActual('../../src/defaults'),
  UNOAPI_MEDIA_BASE64_MAX_BYTES: 512,
}))

import { prepareOutgoingMediaInput, outgoingMediaLogSummary, UNOAPI_MEDIA_PUBLIC_URL, UNOAPI_MEDIA_SOURCE, UNOAPI_MEDIA_STORAGE_KEY, UNOAPI_MESSAGE_ID } from '../../src/services/messages/outgoing_media_input'
import { defaultConfig } from '../../src/services/config'

describe('outgoing Base64 media input', () => {
  const mediaStore = {
    getFilePath: jest.fn().mockReturnValue('5566/message.jpeg'),
    saveMediaBuffer: jest.fn().mockResolvedValue(true),
    getFileUrl: jest.fn().mockResolvedValue('/data/medias/5566/message.jpeg'),
    getDownloadUrl: jest.fn().mockResolvedValue('https://uno.test/v15.0/download/5566/message.jpeg'),
    type: 'file',
  }
  const getConfig = jest.fn(async () => ({
    ...defaultConfig,
    getStore: async () => ({ mediaStore }),
  }))

  beforeEach(() => jest.clearAllMocks())

  test('keeps existing link payloads byte-for-byte untouched', async () => {
    const payload = { type: 'image', image: { link: 'https://example.test/a.jpg', caption: 'Oi' } }
    await expect(prepareOutgoingMediaInput('5566', payload, getConfig as any)).resolves.toEqual({ payload })
    expect(getConfig).not.toHaveBeenCalled()
  })

  test('keeps existing media-id payloads byte-for-byte untouched', async () => {
    const payload = { type: 'document', document: { id: 'existing-media-id', filename: 'arquivo.pdf' } }
    await expect(prepareOutgoingMediaInput('5566', payload, getConfig as any)).resolves.toEqual({ payload })
    expect(getConfig).not.toHaveBeenCalled()
  })

  test('decodes raw Base64, stages it and replaces only the media source', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const prepared = await prepareOutgoingMediaInput('5566', {
      messaging_product: 'whatsapp',
      to: '5577',
      type: 'image',
      image: { base64: bytes.toString('base64'), mime_type: 'image/jpeg', filename: 'foto.jpg', caption: 'Oi', view_once: true },
    }, getConfig as any)

    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith('5566/message.jpeg', bytes, 'image/jpeg')
    expect(prepared.messageId).toEqual(expect.any(String))
    expect(prepared.payload[UNOAPI_MESSAGE_ID]).toBe(prepared.messageId)
    expect(prepared.payload.image).toEqual(expect.objectContaining({
      link: '/data/medias/5566/message.jpeg',
      mime_type: 'image/jpeg',
      filename: 'foto.jpg',
      caption: 'Oi',
      view_once: true,
      [UNOAPI_MEDIA_STORAGE_KEY]: '5566/message.jpeg',
      [UNOAPI_MEDIA_SOURCE]: 'base64',
      [UNOAPI_MEDIA_PUBLIC_URL]: 'https://uno.test/v15.0/download/5566/message.jpeg',
    }))
    expect(prepared.payload.image).not.toHaveProperty('base64')
  })

  test('accepts a Data URI and infers its MIME type', async () => {
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
    const prepared = await prepareOutgoingMediaInput('5566', {
      type: 'document',
      document: { base64: `data:application/pdf;base64,${bytes.toString('base64')}`, filename: 'a.pdf' },
    }, getConfig as any)
    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith('5566/message.jpeg', bytes, 'application/pdf')
    expect(prepared.payload.document.mime_type).toBe('application/pdf')
  })

  test('preserves the signer-produced S3 URL as the compatibility URL', async () => {
    const s3MediaStore = {
      ...mediaStore,
      type: 's3',
      getFileUrl: jest.fn().mockResolvedValue('https://storage.test/object?X-Amz-Signature=signed'),
    }
    const getS3Config = jest.fn(async () => ({
      ...defaultConfig,
      getStore: async () => ({ mediaStore: s3MediaStore }),
    }))
    const prepared = await prepareOutgoingMediaInput('5566', {
      type: 'image',
      image: { base64: Buffer.from([1, 2, 3]).toString('base64'), mime_type: 'image/jpeg' },
    }, getS3Config as any)

    expect(prepared.payload.image.link).toBe('https://storage.test/object?X-Amz-Signature=signed')
    expect(prepared.payload.image[UNOAPI_MEDIA_PUBLIC_URL]).toBe('https://storage.test/object?X-Amz-Signature=signed')
    expect(s3MediaStore.getDownloadUrl).not.toHaveBeenCalled()
  })

  test.each([
    ['audio', 'audio/ogg', Buffer.from('OggS\x00\x02', 'binary')],
    ['video', 'video/mp4', Buffer.from('000000186674797069736F6D', 'hex')],
    ['sticker', 'image/webp', Buffer.from('524946460400000057454250', 'hex')],
  ])('supports Base64 for %s without changing the common payload envelope', async (type, mimeType, bytes) => {
    const prepared = await prepareOutgoingMediaInput('5566', {
      messaging_product: 'whatsapp',
      to: '5577',
      type,
      [type]: { base64: bytes.toString('base64'), mime_type: mimeType },
    }, getConfig as any)
    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith('5566/message.jpeg', bytes, mimeType)
    expect(prepared.payload).toEqual(expect.objectContaining({
      messaging_product: 'whatsapp',
      to: '5577',
      type,
    }))
    expect(prepared.payload[type]).toEqual(expect.objectContaining({ mime_type: mimeType, link: expect.any(String) }))
    expect(prepared.payload[type]).not.toHaveProperty('base64')
  })

  test.each([
    [{ type: 'image', image: { base64: '***', mime_type: 'image/jpeg' } }, 'invalid_media_base64'],
    [{ type: 'image', image: { base64: 'AQID', mime_type: 'application/pdf' } }, 'invalid_image_mime_type'],
    [{ type: 'image', image: { base64: 'data:image/png;base64,AQID', mime_type: 'image/jpeg' } }, 'mime_type_mismatch'],
    [{ type: 'image', image: { base64: 'AQID', mime_type: 'image/jpeg', link: 'https://example.test/a.jpg' } }, 'only_one'],
    [{ type: 'document', document: { base64: Buffer.alloc(513).toString('base64'), mime_type: 'application/pdf' } }, 'too_large'],
  ])('rejects invalid or ambiguous Base64 input', async (payload, error) => {
    await expect(prepareOutgoingMediaInput('5566', payload, getConfig as any)).rejects.toThrow(error)
  })

  test('summarizes Base64 without returning its content', () => {
    const summary = outgoingMediaLogSummary({ to: '5577', type: 'image', image: { base64: 'SECRET' } })
    expect(summary).toEqual(expect.objectContaining({ media_source: 'base64', base64_characters: 6 }))
    expect(JSON.stringify(summary)).not.toContain('SECRET')
  })
})
