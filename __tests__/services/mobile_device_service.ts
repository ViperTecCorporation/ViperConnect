import { MobileDeviceService, MobileDeviceError, validateMobileDraft, mobileCapabilities, CREATE_MOBILE_DRAFT, REMOVE_MOBILE_DRAFT, MOBILE_DRAFTS_KEY } from '../../src/services/mobile_device_service'

const input = { phone: '5511999999999', name: 'Lab', platform: 'android', accountType: 'personal', labConsent: true }
describe('mobile draft validation', () => {
  test.each([{}, null, [], { ...input, phone: '+5511999999999' }, { ...input, phone: '0123456789' }, { ...input, phone: 5511999999999 },
    { ...input, name: ' ' }, { ...input, name: 'x'.repeat(81) }, { ...input, name: 'a\nb' }, { ...input, platform: 'windows' },
    { ...input, accountType: 'other' }, { ...input, labConsent: false }, { ...input, labConsent: 'true' }, { ...input, credentials: 'secret' },
    { ...input, state: 'connected' }, { ...input, ownerId: 'another-user' }, { ...input, proxyUrl: 'https://secret' },
  ])('rejects invalid or sensitive input %#', value => expect(() => validateMobileDraft(value)).toThrow(MobileDeviceError))
  test.each(['android', 'ios'])('accepts intended platform %s without claiming support', platform => {
    expect(validateMobileDraft({ ...input, platform, accountType: 'business', name: ' Lab ' })).toEqual({ phone: input.phone, name: 'Lab', platform, accountType: 'business' })
  })
  test('runtime capabilities remain unavailable', () => {
    expect(mobileCapabilities()).toMatchObject({ draftManagement: true, smsRegistration: false, credentialImport: false, primaryConnection: false, companionQr: false, companionCode: false, voip: false })
  })
})

describe('mobile drafts persistence', () => {
  const redis = { hGetAll: jest.fn(), eval: jest.fn() }
  const service = new MobileDeviceService(async () => redis)
  beforeEach(() => { jest.resetAllMocks(); redis.hGetAll.mockResolvedValue({}); redis.eval.mockResolvedValue(1) })
  test('creates metadata only, using an atomic bounded insert without expiry', async () => {
    const draft = await service.create(input, 'admin')
    expect(draft).toMatchObject({ phone: input.phone, createdBy: 'admin', state: 'draft', connectionMode: 'mobile_primary' })
    expect(draft.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(redis.eval).toHaveBeenCalledWith(CREATE_MOBILE_DRAFT, { keys: [MOBILE_DRAFTS_KEY], arguments: [input.phone, JSON.stringify(draft)] })
    expect(CREATE_MOBILE_DRAFT).toContain('HEXISTS')
    expect(CREATE_MOBILE_DRAFT).toContain('HLEN')
    expect(CREATE_MOBILE_DRAFT).not.toMatch(/EXPIRE|DEL/)
  })
  test.each([[0, 'mobile_phone_already_drafted'], [-1, 'mobile_draft_limit']])('maps atomic insert result %s', async (code, error) => {
    redis.eval.mockResolvedValue(code)
    await expect(service.create(input, 'admin')).rejects.toMatchObject({ status: 409, code: error })
  })
  test('invalid creation never touches Redis', async () => {
    await expect(service.create({ ...input, otp: '123456' }, 'admin')).rejects.toMatchObject({ status: 400 })
    expect(redis.eval).not.toHaveBeenCalled()
  })
  test('lists in phone order and reads an existing draft', async () => {
    const a = await service.create(input, 'admin')
    const b = await service.create({ ...input, phone: '44123456789' }, 'admin')
    redis.hGetAll.mockResolvedValue({ [a.phone]: JSON.stringify(a), [b.phone]: JSON.stringify(b) })
    expect(await service.list()).toEqual([b, a])
    expect(await service.get(a.id)).toEqual(a)
  })
  test.each(['invalid', '00000000-0000-0000-0000-000000000000'])('missing draft %s returns 404', async id => {
    await expect(service.get(id)).rejects.toMatchObject({ status: 404 })
  })
  test('deletion uses compare-and-delete and cannot erase a replacement', async () => {
    const draft = await service.create(input, 'admin')
    redis.hGetAll.mockResolvedValue({ [draft.phone]: JSON.stringify(draft) })
    await service.remove(draft.id)
    expect(redis.eval).toHaveBeenLastCalledWith(REMOVE_MOBILE_DRAFT, { keys: [MOBILE_DRAFTS_KEY, 'mobile-primary:{v1}:registration:' + draft.id], arguments: [draft.phone, JSON.stringify(draft)] })
    redis.eval.mockResolvedValue(0)
    await expect(service.remove(draft.id)).rejects.toMatchObject({ status: 409 })
  })
  test('non-draft state cannot use the draft removal operation', async () => {
    const draft = await service.create(input, 'admin')
    redis.hGetAll.mockResolvedValue({ [draft.phone]: JSON.stringify({ ...draft, state: 'registered' }) })
    redis.eval.mockClear()
    await expect(service.remove(draft.id)).rejects.toMatchObject({ status: 409 })
    expect(redis.eval).not.toHaveBeenCalled()
  })
})
