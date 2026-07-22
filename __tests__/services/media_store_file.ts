import { DataStore } from '../../src/services/data_store'
import { getDataStore } from '../../src/services/data_store'
import { mock } from 'jest-mock-extended'
import { getMediaStoreFile } from '../../src/services/media_store_file'
import { MediaStore, mediaStores } from '../../src/services/media_store'
import { defaultConfig } from '../../src/services/config'
import fetch from 'node-fetch'
jest.mock('node-fetch', () => jest.fn())
const phone = `${new Date().getTime()}`
const messageId = `wa.${new Date().getTime()}`
const url = `http://somehost`
const mimetype = 'text/plain'
const extension = 'txt' 

const message = {
  messaging_product: 'whatsapp',
  id: `${phone}/${messageId}`,
  mime_type: mimetype
}
const dataStore = mock<DataStore>()
const fetchMock = fetch as unknown as jest.Mock
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getTestDataStore: getDataStore = async (_phone: string, _config: unknown): Promise<DataStore> => {
  return dataStore
}

describe('media routes', () => {
  let mediaStore: MediaStore

  beforeEach(() => {
    mediaStores.clear()
    dataStore.loadMediaPayload.mockReturnValue(new Promise((resolve) => resolve(message)))
    dataStore.getLidForPn.mockReset()
    dataStore.getPnForLid.mockReset()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ arrayBuffer: async () => Buffer.from('profile-picture') })
    mediaStore = getMediaStoreFile(phone, defaultConfig, getTestDataStore)
  })

  test('getMedia', async () => {
    const response = {
      url: `${url}/v15.0/download/${phone}/${messageId}.${extension}`,
      ...message
    }
    expect(await mediaStore.getMedia(url, messageId)).toStrictEqual(response)
  })

  test('saveProfilePicture mirrors picture by phone and user id', async () => {
    const pn = '556699999999'
    const pnJid = `${pn}@s.whatsapp.net`
    const lid = '123456789012345@lid'
    dataStore.getLidForPn.mockResolvedValue(lid)
    dataStore.getPnForLid.mockResolvedValue(pnJid)

    await mediaStore.saveProfilePicture({ id: pnJid, lid, imgUrl: 'https://example.test/profile.jpg' } as any)

    const pnUrl = await mediaStore.getProfilePictureUrl(url, pnJid)
    const lidUrl = await mediaStore.getProfilePictureUrl(url, lid)

    expect(pnUrl).toContain('5566999999999.jpg')
    expect(lidUrl).toContain(`${lid}.jpg`)
  })

  test('persists an already downloaded provider buffer without Baileys decryption', async () => {
    mediaStore.saveMediaBuffer = jest.fn().mockResolvedValue(true)
    const waMessage: any = {
      key: { id: 'zapo-media-1', remoteJid: '123@lid', fromMe: false },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          fileName: 'foto.jpg',
          fileLength: 3,
        },
      },
    }

    await mediaStore.saveDownloadedMedia!(waMessage, Buffer.from('img'))

    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith(
      expect.stringContaining('zapo-media-1.jpeg'),
      Buffer.from('img'),
    )
    expect(dataStore.setMediaPayload).toHaveBeenCalledWith(
      'zapo-media-1',
      expect.objectContaining({ id: `${phone}/zapo-media-1` }),
    )
  })
})
