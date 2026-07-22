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

const fetchMock = fetch as unknown as jest.Mock
const amqpPublishMock = amqpPublish as jest.MockedFunction<typeof amqpPublish>

describe('service media store s3', () => {
  const phone = '5566996269251'
  const dataStore = mock<DataStore>()
  const getTestDataStore: getDataStore = async () => dataStore

  beforeEach(() => {
    jest.clearAllMocks()
    mockS3Send.mockReset()
    dataStore.getLidForPn.mockResolvedValue(undefined)
    dataStore.getPnForLid.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => Buffer.from('profile-picture'),
    })
  })

  test('schedules regular S3 media cleanup', async () => {
    const mediaStore = mediaStoreS3(phone, defaultConfig, getTestDataStore)

    await mediaStore.saveMediaBuffer(`${phone}/message.jpg`, Buffer.from('media'), 'image/jpeg')

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
      url: 'https://cdn.example.com/profile.jpg?X-Amz-Signature=abc&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD',
      metadata: {
        etag: '"avatar-etag"',
        last_modified: '2026-06-15T19:24:29.000Z',
        content_length: '41053',
        content_type: 'image/jpeg',
      },
    })
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
})
