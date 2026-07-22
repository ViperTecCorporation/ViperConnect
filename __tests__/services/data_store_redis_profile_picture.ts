jest.mock('../../src/services/data_store_file', () => ({
  getDataStoreFile: jest.fn(),
}))

jest.mock('../../src/services/redis', () => ({
  getProfilePicture: jest.fn(),
  setProfilePicture: jest.fn(),
  profilePictureKey: (phone: string, jid: string) => `profile-picture:${phone}:${jid}`,
  redisDelKey: jest.fn().mockResolvedValue(undefined),
  getPnForLid: jest.fn().mockResolvedValue('5566996328386@s.whatsapp.net'),
  getLidForPn: jest.fn().mockResolvedValue('190280070385782@lid'),
}))

import { mockDeep } from 'jest-mock-extended'
import type { Config } from '../../src/services/config'
import { defaultConfig } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import { dataStores } from '../../src/services/data_store'
import { getDataStoreFile } from '../../src/services/data_store_file'
import { getDataStoreRedis } from '../../src/services/data_store_redis'
import { getProfilePicture, redisDelKey } from '../../src/services/redis'

const getDataStoreFileMock = getDataStoreFile as jest.MockedFunction<typeof getDataStoreFile>
const getProfilePictureMock = getProfilePicture as jest.MockedFunction<typeof getProfilePicture>
const redisDelKeyMock = redisDelKey as jest.MockedFunction<typeof redisDelKey>

describe('Redis profile picture cache', () => {
  const phone = '5566999999999'
  const lid = '190280070385782@lid'
  const deviceLid = '190280070385782:35@lid'
  const phoneJid = '5566996328386@s.whatsapp.net'
  let baseStore: ReturnType<typeof mockDeep<DataStore>>
  let config: Config

  beforeEach(() => {
    jest.clearAllMocks()
    dataStores.clear()
    baseStore = mockDeep<DataStore>()
    baseStore.getPnForLid.mockResolvedValue(phoneJid)
    getDataStoreFileMock.mockResolvedValue(baseStore)
    config = {
      ...defaultConfig,
      getStore: jest.fn().mockResolvedValue({
        mediaStore: { getProfilePictureUrl: jest.fn().mockResolvedValue(undefined) },
      }),
    }
  })

  test('reads device-qualified LIDs through the canonical LID key', async () => {
    getProfilePictureMock.mockImplementation(async (_phone, cacheId) => (
      cacheId === lid ? 'https://uno.test/profile.jpg' : undefined
    ))
    const store = await getDataStoreRedis(phone, config)

    await expect(store.getImageUrl(deviceLid)).resolves.toBe('https://uno.test/profile.jpg')

    expect(getProfilePictureMock).toHaveBeenCalledWith(phone, lid)
  })

  test('removes canonical, legacy and PN alias keys together', async () => {
    const removeLocalImageUrl = baseStore.removeImageUrl as jest.Mock
    const store = await getDataStoreRedis(phone, config)

    await store.removeImageUrl?.(lid)

    expect(removeLocalImageUrl).toHaveBeenCalledWith(lid)
    expect(redisDelKeyMock).toHaveBeenCalledWith(`profile-picture:${phone}:${lid}`)
    expect(redisDelKeyMock).toHaveBeenCalledWith(`profile-picture:${phone}:+5566996328386`)
  })
})
