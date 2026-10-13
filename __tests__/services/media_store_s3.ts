jest.mock('../../src/amqp', () => ({
  amqpPublish: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('node-fetch', () => jest.fn())

const mockS3Send = jest.fn()

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
}))

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://cdn.example.com/profile.jpg?X-Amz-Signature=abc'),
}))

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({
    done: jest.fn().mockResolvedValue({}),
    abort: jest.fn(),
  })),
}))

import fetch from 'node-fetch'
import { amqpPublish } from '../../src/amqp'
import { mediaStoreS3 } from '../../src/services/media_store_s3'
import { defaultConfig } from '../../src/services/config'
import { mock } from 'jest-mock-extended'
import { DataStore } from '../../src/services/data_store'
import { getDataStore } from '../../src/services/data_store'
import { Readable } from 'stream'
import type { Response } from 'express'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

const fetchMock = fetch as unknown as jest.Mock
const amqpPublishMock = amqpPublish as jest.MockedFunction<typeof amqpPublish>
const getSignedUrlMock = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>

describe('service media store s3', () => {
  const phone = '5566996269251'
  const dataStore = mock<DataStore>()
  const getTestDataStore: getDataStore = async () => dataStore

  beforeEach(() => {
    jest.clearAllMocks()
    mockS3Send.mockReset()
    dataStore.getLidForPn.mockResolvedValue(undefined)
    dataStore.getPnForLid.mockResolvedValue(undefined)
    dataStore.loadMediaPayload.mockReset()
    getSignedUrlMock.mockReset()
    getSignedUrlMock.mockResolvedValue('https://cdn.example.com/profile.jpg?X-Amz-Signature=abc')
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    })
  })

  test('schedules regular S3 media cleanup', async () => {
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    await mediaStore.saveMediaBuffer(`${phone}/message.jpg`, Buffer.from('media'), 'image/jpeg')

    expect(amqpPublishMock).toHaveBeenCalledTimes(1)
  })

  test('backup streams disable only the total upload timer; normal uploads retain it', async () => {
    const timer = jest.spyOn(global, 'setTimeout')
    try {
      const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)
      await mediaStore.saveMediaStream('synthetic-backup', Readable.from(['encrypted']), 'application/octet-stream', false, 0)
      expect(timer).not.toHaveBeenCalled()
      expect(amqpPublishMock).not.toHaveBeenCalled()
      await mediaStore.saveMediaStream('synthetic-media', Readable.from(['media']), 'image/jpeg', false, 1000)
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 1000)
    } finally { timer.mockRestore() }
  })

  test('uploads staged outbound videos as streams and schedules cleanup', async () => {
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)
    const stream = Readable.from(Buffer.from('streamed-video'))

    await mediaStore.saveMediaStream(`${phone}/source.video`, stream, 'video/quicktime')

    expect(Upload).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        Key: `${phone}/source.video`,
        Body: stream,
        ContentType: 'video/quicktime',
      }),
    }))
    expect(amqpPublishMock).toHaveBeenCalledTimes(1)
  })

  test('does not schedule S3 cleanup for profile pictures', async () => {
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    await mediaStore.saveProfilePicture({
      id: '120363039221813429@g.us',
      imgUrl: 'https://example.test/group.jpg',
    })

    expect(amqpPublishMock).not.toHaveBeenCalled()
  })

  test('returns profile picture URL with S3 object metadata', async () => {
    mockS3Send.mockResolvedValueOnce({
      ETag: '"avatar-etag"',
      LastModified: new Date('2026-06-15T19:24:29.000Z'),
      ContentLength: 41053,
      ContentType: 'image/jpeg',
    })
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    const info = await mediaStore.getProfilePictureInfo?.('', '556699999999@s.whatsapp.net')

    expect(info).toEqual({
      url: 'https://cdn.example.com/profile.jpg?X-Amz-Signature=abc',
      metadata: {
        etag: '"avatar-etag"',
        last_modified: '2026-06-15T19:24:29.000Z',
        content_length: '41053',
        content_type: 'image/jpeg',
      },
    })
  })

  test.each(['MinIO', 'Amazon S3', 'Cloudflare R2'])(
    'streams profile pictures internally through the %s-compatible SDK',
    async () => {
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      mockS3Send
        .mockResolvedValueOnce({
          ETag: '"avatar-etag"',
          LastModified: new Date('2026-08-14T12:00:00.000Z'),
          ContentLength: bytes.length,
          ContentType: 'image/jpeg',
        })
        .mockResolvedValueOnce({ Body: Readable.from(bytes) })
      const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

      const pictureId = '53515477086263@lid'
      const picture = await mediaStore.getProfilePictureObject?.(pictureId)
      const stream = await picture?.openStream()
      const chunks: Buffer[] = []
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk))

      expect(picture?.metadata).toEqual({
        etag: '"avatar-etag"',
        last_modified: '2026-08-14T12:00:00.000Z',
        content_length: `${bytes.length}`,
        content_type: 'image/jpeg',
      })
      expect(Buffer.concat(chunks)).toEqual(bytes)
      expect(getSignedUrlMock).not.toHaveBeenCalled()
      expect(HeadObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
        Key: `${phone}/profile-pictures/${pictureId}.jpg`,
      }))
    },
  )

  test('resolves a LID profile picture through its PN alias', async () => {
    dataStore.getPnForLid.mockResolvedValue('556699999999@s.whatsapp.net')
    dataStore.getLidForPn.mockResolvedValue('123456789012345@lid')
    mockS3Send
      .mockRejectedValueOnce(Object.assign(new Error('missing LID key'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }))
      .mockResolvedValueOnce({
        ETag: '"pn-etag"',
        LastModified: new Date('2026-08-14T12:00:00.000Z'),
        ContentLength: 4,
        ContentType: 'image/jpeg',
      })
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    expect(await mediaStore.getProfilePictureObject?.('123456789012345@lid')).toBeDefined()
    expect(mockS3Send).toHaveBeenCalledTimes(2)
  })

  test('does not persist a profile picture when the download fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => 'text/plain' },
    })
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    await expect(mediaStore.saveProfilePicture({
      id: '111@lid',
      imgUrl: 'https://example.test/denied.jpg',
    })).rejects.toThrow('HTTP 403')

    expect(amqpPublishMock).not.toHaveBeenCalled()
  })

  test('returns the UnoAPI proxy when the S3-compatible object exists', async () => {
    const mediaId = 'stored-media'
    dataStore.loadMediaPayload.mockResolvedValue({
      id: `${phone}/${mediaId}`,
      url: 'https://minio.example.test/media?X-Amz-Signature=stored',
      mime_type: 'video/mp4',
      filename: 'video.mp4',
      file_size: 123,
      sha256: 'video-sha256',
    })
    mockS3Send.mockResolvedValueOnce({})
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    const payload = await mediaStore.getMedia('https://uno.example.test', mediaId) as { url: string }

    expect(payload.url).toBe(`https://uno.example.test/v15.0/download/${phone}/${mediaId}.mp4`)
    expect(mockS3Send).toHaveBeenCalledTimes(1)
  })

  test('downloads the canonical S3 object when the requested filename uses a MIME alias extension', async () => {
    const mediaId = 'certificate-media'
    const bytes = Buffer.from('pkcs12-bytes')
    dataStore.loadMediaPayload.mockResolvedValue({
      id: `${phone}/${mediaId}`,
      url: 'https://r2.example.test/certificate.p12?X-Amz-Signature=stored',
      mime_type: 'application/x-pkcs12',
      filename: 'certificate.pfx',
    })
    mockS3Send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: Readable.from(bytes) })
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)
    const response = mock<Response>()

    await mediaStore.downloadMedia(response, `${phone}/${mediaId}.pfx`)

    expect(mockS3Send).toHaveBeenCalledTimes(2)
    expect(GetObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      Key: `${phone}/${mediaId}.p12`,
    }))
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-disposition',
      'attachment; filename="certificate.pfx"',
    )
    expect(response.contentType).toHaveBeenCalledWith('application/x-pkcs12')
  })

  test('falls back to the stored URL when the S3-compatible object is missing', async () => {
    const storedUrl = 'https://r2.example.test/media?X-Amz-Signature=stored'
    dataStore.loadMediaPayload.mockResolvedValue({
      id: `${phone}/missing-media`,
      url: storedUrl,
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      file_size: 321,
      sha256: 'document-sha256',
    })
    mockS3Send.mockRejectedValueOnce(Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    }))
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    const payload = await mediaStore.getMedia('https://uno.example.test', 'missing-media') as { url: string }

    expect(payload.url).toBe(storedUrl)
  })

  test('preserves signer-provided UNSIGNED-PAYLOAD without mutating the signed URL', async () => {
    const signedUrl = 'https://r2.example.test/object?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Signature=abc'
    getSignedUrlMock.mockResolvedValueOnce(signedUrl)
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    expect(await mediaStore.getFileUrl(`${phone}/image.jpg`, 300)).toBe(signedUrl)
  })

  test('does not append parameters after the SDK signs the URL', async () => {
    const signedUrl = 'https://s3.example.test/object?X-Amz-Signature=abc'
    getSignedUrlMock.mockResolvedValueOnce(signedUrl)
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    const result = await mediaStore.getFileUrl(`${phone}/document.pdf`, 300)
    expect(result).toBe(signedUrl)
    expect(result).not.toContain('X-Amz-Content-Sha256')
  })
})
