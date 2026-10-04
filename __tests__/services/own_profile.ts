import sharp from 'sharp'
import { ZapoOwnProfile } from '../../src/services/zapo/zapo_own_profile'
import { validateProfileCommand } from '../../src/services/profile_input'
import logger from '../../src/services/logger'

const fixture = (business = false) => {
  const client: any = {
    getCredentials: () => ({ meJid: '5511999999999:3@s.whatsapp.net', pushName: 'João', advSecretKey: 'SECRET' }),
    getState: () => ({ connected: true }),
    profile: {
      getStatus: jest.fn().mockResolvedValue({ status: 'Olá' }), getProfilePicture: jest.fn().mockResolvedValue({ url: 'https://example.com/a.jpg', id: '1' }),
      getOwnUsername: jest.fn().mockResolvedValue({ username: 'joao', pin: 'SECRET', state: 'active' }),
      setPushName: jest.fn(), setStatus: jest.fn(), setUsername: jest.fn().mockResolvedValue(true), deleteUsername: jest.fn().mockResolvedValue(true),
      setProfilePicture: jest.fn().mockResolvedValue('photo-id'), deleteProfilePicture: jest.fn(),
    },
    business: {
      getBusinessProfile: jest.fn().mockResolvedValue(business ? [{ jid: '5511999999999@s.whatsapp.net', description: 'Empresa' }] : []),
      getVerifiedName: jest.fn().mockResolvedValue(business ? { name: 'Empresa', isSmb: true } : null),
      editBusinessProfile: jest.fn(), updateCoverPhoto: jest.fn().mockResolvedValue({ id: 'cover-id' }), deleteCoverPhoto: jest.fn(),
    },
  }
  return { client, service: new ZapoOwnProfile(client) }
}

test.each(['picture', 'cover'] as const)('invalid %s logs safe diagnostic and does not upload', async field => {
  const log = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
  try {
    const { client, service } = fixture(true)
    const value = Buffer.from('PRIVATE_IMAGE_CONTENT').toString('base64')
    await expect(service.execute({ action: 'set', field, value })).rejects.toThrow('profile_invalid_image')
    expect(log).toHaveBeenCalledWith({ event: 'PROFILE_IMAGE_PREPARATION_FAILED', field,
      inputBytes: 21, limitInputPixels: 20_000_000, reason: 'unsupported_image_format' }, expect.any(String))
    expect(JSON.stringify(log.mock.calls)).not.toContain(value)
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_IMAGE_CONTENT')
    expect(client.profile.setProfilePicture).not.toHaveBeenCalled()
    expect(client.business.updateCoverPhoto).not.toHaveBeenCalled()
  } finally { log.mockRestore() }
})

test.each([true, false])('read own business=%s without credentials/PIN; use account JID not device JID', async business => {
  const { client, service } = fixture(business)
  const result = await service.execute({ action: 'get' })
  expect(result).toMatchObject({ name: 'João', about: 'Olá', business_account: business, username: 'joao' })
  expect(JSON.stringify(result)).not.toContain('SECRET')
  expect(client.profile.getStatus).toHaveBeenCalledWith('5511999999999@s.whatsapp.net')
})
test('read failures remain explicit, not a successful empty profile', async () => {
  const { client, service } = fixture()
  client.business.getBusinessProfile.mockRejectedValue(new Error('private details'))
  client.profile.getStatus.mockRejectedValue(new Error('timeout'))
  const result = await service.execute({ action: 'get' })
  expect(result).toMatchObject({ business_account: null, about: null, warnings: expect.arrayContaining(['business', 'about']) })
  expect(JSON.stringify(result)).not.toContain('private details')
})
test.each([['name', 'setPushName'], ['about', 'setStatus']])('set %s forwards exact text including clearing', async (field, method) => {
  const { client, service } = fixture()
  for (const value of ['João ç', '']) await service.execute({ action: 'set', field: field as any, value })
  expect(client.profile[method]).toHaveBeenNthCalledWith(1, 'João ç')
  expect(client.profile[method]).toHaveBeenNthCalledWith(2, '')
})
test('username false is rejection for set and delete', async () => {
  const { client, service } = fixture()
  expect(await service.execute({ action: 'set', field: 'username', value: 'joao' })).toEqual({ success: true })
  client.profile.setUsername.mockResolvedValue(false); client.profile.deleteUsername.mockResolvedValue(false)
  await expect(service.execute({ action: 'set', field: 'username', value: 'joao' })).rejects.toThrow('profile_username_rejected')
  await expect(service.execute({ action: 'delete', field: 'username' })).rejects.toThrow('profile_username_rejected')
})
test('business delta preserves omitted fields, zero coordinates, empty websites and schedules', async () => {
  const { client, service } = fixture(true)
  const value = { address: 'Cláudia MT', latitude: 0, longitude: -54, websites: [], categories: [{ id: '123' }], businessHours: { timezone: 'America/Cuiaba', config: [] } }
  await service.execute({ action: 'set', field: 'business', value })
  expect(client.business.editBusinessProfile).toHaveBeenCalledWith(value)
  expect(client.business.editBusinessProfile.mock.calls[0][0]).not.toHaveProperty('description')
})
test('personal business mutation and disconnected account fail before writes', async () => {
  const { client, service } = fixture()
  await expect(service.execute({ action: 'set', field: 'business', value: { description: 'x' } })).rejects.toThrow('business_account_required')
  expect(client.business.editBusinessProfile).not.toHaveBeenCalled()
  client.getState = () => ({ connected: false })
  await expect(service.execute({ action: 'set', field: 'name', value: 'x' })).rejects.toThrow('not_connected')
  expect(client.profile.setPushName).not.toHaveBeenCalled()
})
test('avatar JPEG square; cover keeps aspect ratio; no target supplied', async () => {
  const { client, service } = fixture(true)
  const value = (await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64')
  expect(await service.execute({ action: 'set', field: 'picture', value })).toEqual({ success: true, id: 'photo-id' })
  const picture = client.profile.setProfilePicture.mock.calls[0]
  expect(picture).toHaveLength(1)
  expect(await sharp(picture[0]).metadata()).toMatchObject({ width: 640, height: 640, format: 'jpeg' })
  await service.execute({ action: 'set', field: 'cover', value })
  expect(await sharp(client.business.updateCoverPhoto.mock.calls[0][0]).metadata()).toMatchObject({ width: 20, height: 10, format: 'jpeg' })
  await service.execute({ action: 'delete', field: 'picture' }); await service.execute({ action: 'delete', field: 'cover', value: 'cover-id' })
  expect(client.profile.deleteProfilePicture).toHaveBeenCalledWith()
  expect(client.business.deleteCoverPhoto).toHaveBeenCalledWith('cover-id')
  await expect(service.execute({ action: 'set', field: 'picture', value: 'bm90LWltYWdl' })).rejects.toThrow('invalid_image')
})
test.each([
  { action: 'set', field: 'name', value: 5 }, { action: 'get', value: 'target' },
  { action: 'delete', field: 'business' }, { action: 'set', field: 'picture', value: 'https://localhost/private' },
  { action: 'set', field: 'about', value: 'a'.repeat(140) }, { action: 'set', field: 'username', value: '@bad!' },
  ...[{ latitude: 0 }, { latitude: 91, longitude: 0 }, { description: null }, { foo: 'x' }, {}, { websites: [{ url: 'javascript:alert(1)' }] },
    { categories: [{ id: 'foo' }] }, { businessHours: { config: [{ dayOfWeek: 'sun', mode: 'closed' }] } },
    { businessHours: { timezone: 'invalid', config: [] } }, { businessHours: { config: [{ dayOfWeek: 'mon', mode: 'specific_hours', openTime: 100, closeTime: 50 }] } },
  ].map(value => ({ action: 'set', field: 'business', value })),
])('reject malformed command %#', command => expect(() => validateProfileCommand(command as any)).toThrow('invalid_profile_'))
test('valid hours validate', () => expect(validateProfileCommand({ action: 'set', field: 'business', value: { businessHours: { config: [{ dayOfWeek: 'mon', mode: 'specific_hours', openTime: 0, closeTime: 1439 }] } } })).toBeDefined())

test('cover persistence receives the normalized JPEG and delegates exact SDK ID on removal', async () => {
  const { client } = fixture(true)
  const cover = { upload: jest.fn(async (_image, send) => ({ success: true, ...(await send()) })), remove: jest.fn(async (_id, send) => { await send(); return { success: true } }) }
  const service = new ZapoOwnProfile(client, cover as any)
  const value = (await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64')
  await service.execute({ action: 'set', field: 'cover', value })
  const image = cover.upload.mock.calls[0][0]
  expect(await sharp(image).metadata()).toMatchObject({ format: 'jpeg', width: 20, height: 10 })
  expect(client.business.updateCoverPhoto).toHaveBeenCalledWith(image)
  await service.execute({ action: 'delete', field: 'cover', value: 'saved-id' })
  expect(cover.remove).toHaveBeenCalledWith('saved-id', expect.any(Function))
  expect(client.business.deleteCoverPhoto).toHaveBeenCalledWith('saved-id')
})
