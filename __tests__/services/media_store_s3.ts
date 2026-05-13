jest.mock('../../src/amqp', () => ({
  amqpPublish: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('node-fetch', () => jest.fn())

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
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
    dataStore.getLidForPn.mockResolvedValue(undefined)
    dataStore.getPnForLid.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue({
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
    } as any)

    expect(amqpPublishMock).not.toHaveBeenCalled()
  })
})
