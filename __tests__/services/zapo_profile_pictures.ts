import { mockDeep } from 'jest-mock-extended'
import type { WaClient, WaPictureEvent, WaStoreSession } from 'zapo-js'
import type { Store } from '../../src/services/store'
import { ZapoProfilePictures } from '../../src/services/zapo/zapo_profile_pictures'

type TestMessage = {
  key: { remoteJid: string; participant?: string; fromMe?: boolean }
  groupMetadata?: { profilePicture?: string }
  profilePicture?: string
  profilePictureMetadata?: Record<string, string>
}

describe('ZapoProfilePictures', () => {
  const phone = '5566999999999'
  const lid = '111222333@lid'
  const phoneJid = '5566111222333@s.whatsapp.net'
  let client: ReturnType<typeof mockDeep<WaClient>>
  let session: ReturnType<typeof mockDeep<WaStoreSession>>
  let store: ReturnType<typeof mockDeep<Store>>

  beforeEach(() => {
    client = mockDeep<WaClient>()
    session = mockDeep<WaStoreSession>()
    store = mockDeep<Store>()
    session.contacts.getByJid.mockResolvedValue({
      jid: lid,
      lid,
      phoneNumber: phoneJid.split('@')[0],
      lastUpdatedMs: 1,
    })
    session.contacts.getByPhoneNumber.mockResolvedValue({
      jid: lid,
      lid,
      phoneNumber: phoneJid.split('@')[0],
      lastUpdatedMs: 1,
    })
  })

  const createService = (overrides: Partial<ConstructorParameters<typeof ZapoProfilePictures>[0]> = {}) => (
    new ZapoProfilePictures({
      phone,
      client,
      session,
      store,
      enabled: true,
      forceRefresh: true,
      refreshIntervalSeconds: 86_400,
      webhookIntervalSeconds: 0,
      ...overrides,
    })
  )

  test('does nothing when profile pictures are disabled', async () => {
    const service = createService({ enabled: false })
    const message = { key: { remoteJid: lid } }

    await expect(service.enrich(message)).resolves.toBe(message)
    expect(client.profile.getProfilePicture).not.toHaveBeenCalled()
  })

  test('downloads a LID profile picture and persists its PN alias', async () => {
    store.mediaStore.getProfilePictureInfo
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ url: 'https://uno.test/profile.jpg', metadata: { etag: 'avatar-1' } })
    client.profile.getProfilePicture.mockResolvedValue({
      id: 'picture-1',
      url: 'https://zapo.test/profile.jpg',
      type: 'image',
    })
    const service = createService()
    const message: TestMessage = { key: { remoteJid: lid, fromMe: false } }

    await service.enrich(message)

    expect(client.profile.getProfilePicture).toHaveBeenCalledWith(lid, 'image', undefined)
    expect(store.dataStore.setJidMapping).toHaveBeenCalledWith(phone, phoneJid, lid)
    expect(store.mediaStore.saveProfilePicture).toHaveBeenCalledWith({
      id: phoneJid,
      lid,
      imgUrl: 'https://zapo.test/profile.jpg',
    })
    expect(message.profilePicture).toBe('https://uno.test/profile.jpg')
    expect(message.profilePictureMetadata).toEqual({ etag: 'avatar-1' })
  })

  test('enriches group and participant pictures independently', async () => {
    const groupJid = '120363000000@g.us'
    const saved = new Set<string>()
    store.mediaStore.getProfilePictureInfo.mockImplementation(async (_baseUrl, jid) => (
      saved.has(jid) ? { url: `https://uno.test/${encodeURIComponent(jid)}.jpg` } : undefined
    ))
    store.mediaStore.saveProfilePicture.mockImplementation(async (contact) => {
      saved.add(`${contact.id}`)
    })
    client.profile.getProfilePicture.mockImplementation(async (jid) => ({
      id: `picture-${jid}`,
      url: `https://zapo.test/${encodeURIComponent(jid)}.jpg`,
      type: 'image',
    }))
    const service = createService()
    const message: TestMessage = { key: { remoteJid: groupJid, participant: lid, fromMe: false } }

    await service.enrich(message)

    expect(client.profile.getProfilePicture).toHaveBeenCalledWith(groupJid, 'image', undefined)
    expect(client.profile.getProfilePicture).toHaveBeenCalledWith(lid, 'image', undefined)
    expect(message.groupMetadata?.profilePicture).toContain(encodeURIComponent(groupJid))
    expect(message.profilePicture).toContain(encodeURIComponent(phoneJid))
  })

  test('uses the local picture during the refresh interval', async () => {
    store.mediaStore.getProfilePictureInfo
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ url: 'https://uno.test/profile.jpg' })
    client.profile.getProfilePicture.mockResolvedValue({ id: 'picture-1', url: 'https://zapo.test/profile.jpg' })
    const service = createService()

    await service.enrich({ key: { remoteJid: lid } })
    await service.enrich({ key: { remoteJid: lid } })

    expect(client.profile.getProfilePicture).toHaveBeenCalledTimes(1)
  })

  test('passes the cached picture id when checking for a later change', async () => {
    store.mediaStore.getProfilePictureInfo
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ url: 'https://uno.test/profile.jpg' })
    client.profile.getProfilePicture
      .mockResolvedValueOnce({ id: 'picture-1', url: 'https://zapo.test/profile.jpg' })
      .mockResolvedValueOnce({})
    const service = createService({ refreshIntervalSeconds: 0 })

    await service.enrich({ key: { remoteJid: lid } })
    await service.enrich({ key: { remoteJid: lid } })

    expect(client.profile.getProfilePicture).toHaveBeenNthCalledWith(2, lid, 'image', 'picture-1')
    expect(store.mediaStore.saveProfilePicture).toHaveBeenCalledTimes(1)
  })

  test('falls back to preview when no original or local picture is available', async () => {
    store.mediaStore.getProfilePictureInfo
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ url: 'https://uno.test/preview.jpg' })
    client.profile.getProfilePicture
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ id: 'preview-1', url: 'https://zapo.test/preview.jpg', type: 'preview' })
    const service = createService()

    const message: TestMessage = { key: { remoteJid: lid } }
    await service.enrich(message)

    expect(client.profile.getProfilePicture).toHaveBeenNthCalledWith(2, lid, 'preview')
    expect(message.profilePicture).toBe('https://uno.test/preview.jpg')
  })

  test('removes persisted aliases when Zapo reports picture deletion', async () => {
    const service = createService()

    await service.handleEvent({ action: 'delete', targetJid: lid } as unknown as WaPictureEvent)

    expect(store.dataStore.removeImageUrl).toHaveBeenCalledWith(phoneJid)
    expect(client.profile.getProfilePicture).not.toHaveBeenCalled()
  })

  test('refreshes immediately when Zapo reports a new picture', async () => {
    store.mediaStore.getProfilePictureInfo
      .mockResolvedValueOnce({ url: 'https://uno.test/old.jpg' })
      .mockResolvedValue({ url: 'https://uno.test/new.jpg' })
    client.profile.getProfilePicture.mockResolvedValue({ id: 'picture-2', url: 'https://zapo.test/new.jpg' })
    const service = createService({ forceRefresh: false })

    await service.handleEvent({ action: 'set', targetJid: lid, pictureId: 2 } as unknown as WaPictureEvent)

    expect(client.profile.getProfilePicture).toHaveBeenCalledWith(lid, 'image', undefined)
    expect(store.mediaStore.saveProfilePicture).toHaveBeenCalled()
  })

  test('keeps the local picture when the provider lookup fails', async () => {
    store.mediaStore.getProfilePictureInfo.mockResolvedValue({ url: 'https://uno.test/cached.jpg' })
    client.profile.getProfilePicture.mockRejectedValue(new Error('privacy denied'))
    const service = createService({ refreshIntervalSeconds: 0 })
    const message: TestMessage = { key: { remoteJid: lid } }

    await service.enrich(message)

    expect(message.profilePicture).toBe('https://uno.test/cached.jpg')
    expect(store.mediaStore.saveProfilePicture).not.toHaveBeenCalled()
  })

  test('does not block the message when the contact store lookup fails', async () => {
    session.contacts.getByJid.mockRejectedValue(new Error('sqlite unavailable'))
    const service = createService()
    const message = { key: { remoteJid: lid } }

    await expect(service.enrich(message)).resolves.toBe(message)
    expect(client.profile.getProfilePicture).not.toHaveBeenCalled()
  })

  test('uses storage implementations that only expose the URL lookup', async () => {
    store.mediaStore.getProfilePictureInfo = undefined
    store.mediaStore.getProfilePictureUrl.mockResolvedValue('https://uno.test/legacy-cache.jpg')
    const service = createService({ forceRefresh: false })
    const message: TestMessage = { key: { remoteJid: lid } }

    await service.enrich(message)

    expect(message.profilePicture).toBe('https://uno.test/legacy-cache.jpg')
    expect(client.profile.getProfilePicture).not.toHaveBeenCalled()
  })

  test('populates the webhook once per interval and releases it after a picture event', async () => {
    store.mediaStore.getProfilePictureInfo.mockResolvedValue({ url: 'https://uno.test/profile.jpg' })
    client.profile.getProfilePicture.mockResolvedValue({ id: 'picture-2', url: 'https://zapo.test/profile.jpg' })
    const service = createService({
      forceRefresh: false,
      webhookIntervalSeconds: 10_800,
    })
    const first: TestMessage = { key: { remoteJid: lid } }
    const second: TestMessage = { key: { remoteJid: lid } }
    const afterChange: TestMessage = { key: { remoteJid: lid } }

    await service.enrich(first)
    await service.enrich(second)
    await service.handleEvent({ action: 'set', targetJid: lid, pictureId: 2 } as unknown as WaPictureEvent)
    await service.enrich(afterChange)

    expect(first.profilePicture).toBe('https://uno.test/profile.jpg')
    expect(second.profilePicture).toBeUndefined()
    expect(afterChange.profilePicture).toBe('https://uno.test/profile.jpg')
  })
})
