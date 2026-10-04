import { MobileConnectionService } from '../../src/services/mobile_primary/connection_service'
import { convertWhalibmobCredentials } from '../../src/services/mobile_primary/whalibmob_credentials'
jest.mock('../../src/services/mobile_primary/whalibmob_credentials', () => ({ convertWhalibmobCredentials: jest.fn() }))

const credentials: any = { meJid: '999123456789@s.whatsapp.net', deviceInfo: { os: 'ios', business: false }, noiseKeyPair: { pubKey: Buffer.alloc(32, 1) }, registrationInfo: { identityKeyPair: { pubKey: Buffer.alloc(32, 2) } } }
function fixture() {
  const lease = { acquire: jest.fn(async () => true), renew: jest.fn(async () => true), release: jest.fn(async () => true) }
  const auth = { load: jest.fn(async (): Promise<any> => null), save: jest.fn(), clear: jest.fn() }
  const deps = { enabled: () => true, server: 'mobile_lab', draft: jest.fn(async () => ({ id: 'draft', phone: '999123456789', name: 'Lab' } as any)), registration: jest.fn(async () => ({ status: 'registered', canonicalPhone: '999123456789', store: {}, advSecret: Buffer.alloc(32).toString('base64') })), config: jest.fn(async (): Promise<any> => undefined), saveConfig: jest.fn(), auth: jest.fn(async () => auth), status: jest.fn(async () => 'online'), dispatch: jest.fn(), lease: () => lease }
  ;(convertWhalibmobCredentials as jest.Mock).mockResolvedValue(credentials)
  return { service: new MobileConnectionService(deps), deps, auth, lease }
}
describe('mobile primary import and worker dispatch', () => {
  test('panel resumes without overwriting credentials or restoring removed webhooks', async () => {
    const s = fixture()
    s.deps.config.mockResolvedValue({ mobilePrimaryDraftId: 'draft', mobilePrimaryImported: true, autoConnect: false, provider: 'zapo', server: 'mobile_lab', webhooks: [{ id: 'remaining' }] })
    s.auth.load.mockResolvedValue(credentials)
    await s.service.connect('draft', { confirm: true })
    expect(s.deps.saveConfig).toHaveBeenCalledWith('999123456789', { mobilePrimaryImported: true, autoConnect: true })
    expect(s.auth.save).not.toHaveBeenCalled()
    expect(s.deps.dispatch).toHaveBeenCalledTimes(1)
  })
  test('imports once under lease and publishes no keys', async () => {
    const s = fixture()
    expect(await s.service.connect('draft', { confirm: true })).toMatchObject({ status: 'connection_requested' })
    expect(s.auth.save).toHaveBeenCalledWith(credentials)
    expect(s.deps.dispatch).toHaveBeenCalledWith('999123456789')
    expect(s.lease.release).toHaveBeenCalledTimes(1)
    expect(s.auth.clear).not.toHaveBeenCalled()
    expect(s.deps.saveConfig).toHaveBeenCalledWith('999123456789', expect.objectContaining({ autoConnect: false, mobilePrimaryDraftId: 'draft' }))
  })
  test('preserves evolved auth on reconnect and reports current state', async () => {
    const s = fixture(); s.deps.config.mockResolvedValue({ mobilePrimaryDraftId: 'draft', provider: 'zapo', server: 'mobile_lab', mobilePrimaryImported: true, autoConnect: true })
    s.auth.load.mockResolvedValue({ ...credentials, meLid: '123@lid', signedPreKey: { rotated: true } })
    await s.service.connect('draft', { confirm: true })
    expect(s.auth.save).not.toHaveBeenCalled(); expect(s.deps.saveConfig).not.toHaveBeenCalled()
    expect(await s.service.status('draft')).toMatchObject({ imported: true, status: 'online' })
  })
  test('does not resurrect removed auth', async () => {
    const s = fixture(); s.deps.config.mockResolvedValue({ mobilePrimaryDraftId: 'draft', provider: 'zapo', server: 'mobile_lab', mobilePrimaryImported: true })
    await expect(s.service.connect('draft', { confirm: true })).rejects.toMatchObject({ code: 'mobile_auth_removed_registration_required' })
    expect(s.auth.save).not.toHaveBeenCalled(); expect(s.deps.dispatch).not.toHaveBeenCalled()
  })
  test('already-online import is idempotent without disconnecting the worker', async () => {
    const s = fixture(); s.lease.acquire.mockResolvedValue(false)
    s.deps.config.mockResolvedValue({ mobilePrimaryDraftId: 'draft', mobilePrimaryImported: true, provider: 'zapo', server: 'mobile_lab' })
    expect(await s.service.connect('draft', { confirm: true })).toMatchObject({ status: 'online' })
    expect(s.auth.save).not.toHaveBeenCalled(); expect(s.deps.dispatch).not.toHaveBeenCalled()
  })
  test('rejects another session and another auth identity', async () => {
    const s = fixture(); s.deps.config.mockResolvedValue({ provider: 'zapo' })
    await expect(s.service.connect('draft', { confirm: true })).rejects.toMatchObject({ code: 'mobile_session_conflict' })
    s.deps.config.mockResolvedValue(undefined); s.auth.load.mockResolvedValue({ ...credentials, meJid: 'other@s.whatsapp.net' })
    await expect(s.service.connect('draft', { confirm: true })).rejects.toMatchObject({ code: 'mobile_auth_conflict' })
    expect(s.auth.save).not.toHaveBeenCalled()
  })
  test('requires registration, consent, lab gate and ownership', async () => {
    const s = fixture()
    await expect(s.service.connect('draft', {})).rejects.toMatchObject({ status: 400 })
    s.deps.enabled = () => false
    await expect(s.service.status('draft')).rejects.toMatchObject({ status: 404 })
    s.deps.enabled = () => true; s.deps.registration.mockResolvedValue({ status: 'blocked' } as any)
    await expect(s.service.connect('draft', { confirm: true })).rejects.toMatchObject({ status: 409 })
    s.deps.registration.mockResolvedValue({ status: 'registered', canonicalPhone: '999123456789', store: {}, advSecret: '' })
    s.lease.acquire.mockResolvedValue(false)
    await expect(s.service.connect('draft', { confirm: true })).rejects.toMatchObject({ code: 'mobile_session_in_use' })
    expect(s.auth.save).not.toHaveBeenCalled(); expect(s.deps.dispatch).not.toHaveBeenCalled()
  })
  test('ownership lost or failed dispatch cannot falsely report connected', async () => {
    const s = fixture(); s.lease.renew.mockResolvedValue(false)
    await expect(s.service.connect('draft', { confirm: true })).rejects.toMatchObject({ status: 409 })
    expect(s.auth.save).not.toHaveBeenCalled()
    s.lease.renew.mockResolvedValue(true); s.deps.dispatch.mockRejectedValue(new Error('queue unavailable'))
    await expect(s.service.connect('draft', { confirm: true })).rejects.toThrow('queue unavailable')
    expect(s.lease.release).toHaveBeenCalledTimes(2)
  })
})
