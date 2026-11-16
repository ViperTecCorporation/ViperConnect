import type { Request, Response } from 'express'
import { mockDeep } from 'jest-mock-extended'
import { defaultConfig } from '../../src/services/config'
import { RegistrationController } from '../../src/controllers/registration_controller'
import type { Logout } from '../../src/services/logout'
import type { Reload } from '../../src/services/reload'
import { getConfig as getStoredConfig, setConfig } from '../../src/services/redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { confirmSessionStorageProvision } from '../../src/services/session_storage/provisioning'

jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn().mockResolvedValue({ backend: 'redis' }) }))
jest.mock('../../src/services/session_storage/provisioning', () => ({ ...jest.requireActual('../../src/services/session_storage/provisioning'), confirmSessionStorageProvision: jest.fn() }))

jest.mock('../../src/services/redis', () => ({
  getConfig: jest.fn(),
  setConfig: jest.fn(),
}))

const storedConfigMock = getStoredConfig as jest.MockedFunction<typeof getStoredConfig>
const setConfigMock = setConfig as jest.MockedFunction<typeof setConfig>

const response = () => {
  const res = mockDeep<Response>()
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

describe('RegistrationController connection type policy', () => {
  beforeEach(() => { jest.clearAllMocks(); setConfigMock.mockReset(); storedConfigMock.mockReset(); (sessionStorageRpc as jest.Mock).mockReset().mockResolvedValue({ backend: 'redis' }); jest.mocked(confirmSessionStorageProvision).mockReset().mockResolvedValue({ id: 'synthetic', owner: 'server_1', backend: 'redis', generation: 0 }) })

  test.each(['sqlite', 'redis'])('new QR selects the owner-confirmed %s backend before enabling automatic connection', async backend => {
    const phone = backend === 'sqlite' ? '5566000000194' : '5566000000195', steps: string[] = []
    let saved: any
    storedConfigMock.mockImplementation(async () => saved)
    setConfigMock.mockImplementation(async (_phone, value) => { steps.push(value.autoConnect ? 'enable' : 'pause'); saved = { ...saved, ...value } })
    ;(sessionStorageRpc as jest.Mock).mockImplementation(async (_phone, config, operation) => {
      expect(config.autoConnect).toBe(false); expect(operation).toBe('provision'); steps.push('provision')
      if (backend === 'sqlite') saved.sessionStorage = { backend, storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1, state: 'offline' }
      return { backend }
    })
    jest.mocked(confirmSessionStorageProvision).mockImplementation(async () => { steps.push('confirm'); saved.autoConnect = saved.sessionStorageProvisionPending.autoConnect; saved.sessionStorageProvisionPending = null; return saved.sessionStorageProvisioned })
    const reload = mockDeep<Reload>(); reload.run.mockImplementation(async () => { steps.push('reload') })
    const controller = new RegistrationController(async () => ({ ...defaultConfig, provider: 'zapo', ...saved }), reload, mockDeep<Logout>()), res = response()
    await controller.register({ params: { phone }, body: { connectionType: 'qrcode' }, headers: {}, query: {} } as any, res)
    expect(res.status).toHaveBeenCalledWith(200); expect(steps).toEqual(['pause', 'provision', 'confirm', 'reload'])
    expect(saved.autoConnect).toBe(true); expect(saved.sessionStorage?.backend).toBe(backend === 'sqlite' ? 'sqlite' : undefined)
  })

  test('uncertain provision remains suspended and register retry resumes the pending selection', async () => {
    const phone = '5566000000196'; let saved: any
    storedConfigMock.mockImplementation(async () => saved)
    setConfigMock.mockImplementation(async (_phone, value) => { saved = { ...saved, ...value } })
    ;(sessionStorageRpc as jest.Mock).mockRejectedValueOnce(new Error('lost RPC')).mockResolvedValueOnce({ backend: 'redis' })
    jest.mocked(confirmSessionStorageProvision).mockRejectedValueOnce(new Error('unconfirmed')).mockImplementationOnce(async () => { saved.autoConnect = saved.sessionStorageProvisionPending.autoConnect; saved.sessionStorageProvisionPending = null; return saved.sessionStorageProvisioned })
    const reload = mockDeep<Reload>(); reload.run.mockResolvedValue(undefined)
    const controller = new RegistrationController(async () => ({ ...defaultConfig, provider: 'zapo', ...saved }), reload, mockDeep<Logout>())
    const req: any = { params: { phone }, body: { connectionType: 'qrcode' }, headers: {}, query: {} }, failed = response()
    await controller.register(req, failed)
    expect(failed.status).toHaveBeenCalledWith(503); expect(saved.autoConnect).toBe(false); expect(reload.run).not.toHaveBeenCalled()
    const retried = response(); await controller.register(req, retried)
    expect(retried.status).toHaveBeenCalledWith(200); expect(saved.autoConnect).toBe(true); expect(saved.sessionStorageProvisionPending).toBeNull()
    expect(sessionStorageRpc).toHaveBeenCalledTimes(2)
  })

  test('lost provision reply reuses the confirmed persisted SQLite descriptor instead of switching to Redis', async () => {
    const phone = '5566000000197'; let saved: any
    storedConfigMock.mockImplementation(async () => saved)
    setConfigMock.mockImplementation(async (_phone, value) => { saved = { ...saved, ...value } })
    const storage = { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1, state: 'offline' }
    ;(sessionStorageRpc as jest.Mock).mockImplementationOnce(async () => { saved.sessionStorage = storage; throw new Error('lost response') })
    jest.mocked(confirmSessionStorageProvision).mockImplementationOnce(async () => { saved.autoConnect = saved.sessionStorageProvisionPending.autoConnect; saved.sessionStorageProvisionPending = null; return saved.sessionStorageProvisioned })
    const reload = mockDeep<Reload>(); reload.run.mockResolvedValue(undefined)
    const controller = new RegistrationController(async () => ({ ...defaultConfig, provider: 'zapo', ...saved }), reload, mockDeep<Logout>()), res = response()
    await controller.register({ params: { phone }, body: { connectionType: 'qrcode' }, headers: {}, query: {} } as any, res)
    expect(res.status).toHaveBeenCalledWith(200); expect(saved.sessionStorage).toBe(storage)
    expect(saved.autoConnect).toBe(true); expect(reload.run).toHaveBeenCalledTimes(1)
    expect(setConfigMock.mock.calls.every(([, value]) => value.sessionStorage === undefined)).toBe(true)
  })

  test('assigns the current worker server to a new session when the client omits server', async () => {
    storedConfigMock.mockResolvedValue(undefined)
    const reload = mockDeep<Reload>()
    const controller = new RegistrationController(
      jest.fn().mockResolvedValue({ ...defaultConfig, provider: 'zapo' }),
      reload,
      mockDeep<Logout>(),
    )
    const res = response()

    await controller.register({
      params: { phone: '5566000000099' },
      body: { provider: 'zapo', connectionType: 'qrcode', zapoWebClientProfile: 'wa_personal' },
      headers: {},
      query: {},
    } as unknown as Request, res)

    expect(setConfigMock).toHaveBeenCalledWith('5566000000099', expect.objectContaining({
      server: 'server_1',
      zapoWebClientProfile: 'wa_personal',
    }))
  })

  test('mobile deregister persists suspension before dispatch, never logs out', async () => {
    storedConfigMock.mockResolvedValue({ mobilePrimaryDraftId: 'lab-device', webhooks: [{ id: 'a', url: 'https://example.test/a' }, { id: 'b', url: 'https://example.test/b' }] })
    const reload = mockDeep<Reload>(); const logout = mockDeep<Logout>()
    const controller = new RegistrationController(jest.fn(), reload, logout)
    const req = { params: { phone: '5566000000084' }, body: { webhooks: [{ id: 'a' }] }, headers: {}, query: {} } as unknown as Request
    const res = response()
    await controller.deregister(req, res)
    expect(res.status).toHaveBeenCalledWith(204)
    expect(setConfigMock).toHaveBeenCalledWith('5566000000084', { autoConnect: false, overrideWebhooks: true, webhooks: [] })
    expect(setConfigMock.mock.invocationCallOrder[0]).toBeLessThan(reload.run.mock.invocationCallOrder[0])
    expect(logout.run).not.toHaveBeenCalled()
    reload.run.mockRejectedValue(new Error('broker down'))
    const failed = response()
    await controller.deregister(req, failed)
    expect(failed.status).toHaveBeenCalledWith(503)
  })

  test('mobile register resumes only after saving destination and autoConnect', async () => {
    const before = { ...defaultConfig, provider: 'zapo' as const, server: 'mobile_lab', autoConnect: false }
    storedConfigMock.mockResolvedValue({ mobilePrimaryDraftId: 'lab-device' })
    const reload = mockDeep<Reload>()
    const controller = new RegistrationController(jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, autoConnect: true }), reload, mockDeep<Logout>())
    const res = response()
    await controller.register({ params: { phone: '5566000000085' }, body: { webhooks: [{ id: 'a', url: 'https://example.test/a' }], autoConnect: false }, headers: {}, query: {} } as unknown as Request, res)
    expect(setConfigMock).toHaveBeenCalledWith('5566000000085', expect.objectContaining({ autoConnect: true }))
    expect(setConfigMock.mock.invocationCallOrder[0]).toBeLessThan(reload.run.mock.invocationCallOrder[0])
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test.each([true, false])('server_1 alias preserves primary ownership regardless of legacy lab flag (%s)', async (enabled) => {
    const oldFlag = process.env.UNOAPI_MOBILE_PRIMARY_LAB
    const oldServer = process.env.UNOAPI_SERVER_NAME
    process.env.UNOAPI_MOBILE_PRIMARY_LAB = String(enabled)
    process.env.UNOAPI_SERVER_NAME = 'production_east'
    try {
      const config = { ...defaultConfig, provider: 'zapo' as const, server: 'production_east', webhooks: [] }
      storedConfigMock.mockResolvedValue({ provider: 'zapo', mobilePrimaryDraftId: 'lab-device' })
      const reload = mockDeep<Reload>()
      const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
      const res = response()
      await controller.register({ params: { phone: '5566000000083' }, body: { server: 'server_1', webhooks: [] }, headers: {}, query: {} } as unknown as Request, res)
      expect(res.status).toHaveBeenCalledWith(200)
      expect(setConfigMock).toHaveBeenCalledWith('5566000000083', expect.objectContaining({ server: 'production_east', webhooks: [] }))
      expect(reload.run).not.toHaveBeenCalled()
    } finally {
      if (oldFlag === undefined) delete process.env.UNOAPI_MOBILE_PRIMARY_LAB
      else process.env.UNOAPI_MOBILE_PRIMARY_LAB = oldFlag
      if (oldServer === undefined) delete process.env.UNOAPI_SERVER_NAME
      else process.env.UNOAPI_SERVER_NAME = oldServer
    }
  })

  test('accepts empty body and repeated mobile deregister without destructive logout', async () => {
    storedConfigMock.mockResolvedValue({ provider: 'zapo', mobilePrimaryDraftId: 'lab-device' })
    const logout = mockDeep<Logout>()
    const controller = new RegistrationController(jest.fn(), mockDeep<Reload>(), logout)
    const res = response()
    await controller.deregister({ params: { phone: '5566000000081' }, body: {}, headers: {}, query: {} } as unknown as Request, res)
    expect(res.status).toHaveBeenCalledWith(204)
    expect(logout.run).not.toHaveBeenCalled()
    expect(setConfigMock).toHaveBeenCalledWith('5566000000081', { webhooks: [], overrideWebhooks: true, autoConnect: false })
  })

  test.each([{ provider: 'baileys' }, { server: 'other' }, { mobilePrimaryDraftId: '' }, { mobilePrimaryImported: false }])('protects mobile identity from register %j', async (body) => {
    storedConfigMock.mockResolvedValue({ provider: 'zapo', mobilePrimaryDraftId: 'lab-device' })
    const reload = mockDeep<Reload>()
    const controller = new RegistrationController(jest.fn().mockResolvedValue({ ...defaultConfig, provider: 'zapo', server: 'mobile_lab' }), reload, mockDeep<Logout>())
    const res = response()
    await controller.register({ params: { phone: '5566000000082' }, body, headers: {}, query: {} } as unknown as Request, res)
    expect(res.status).toHaveBeenCalledWith('mobilePrimaryDraftId' in body || 'mobilePrimaryImported' in body ? 400 : 409)
    expect(setConfigMock).not.toHaveBeenCalled()
    expect(reload.run).not.toHaveBeenCalled()
  })

  test('applies consecutive webhook changes without reconnecting an existing Zapo session', async () => {
    const before = { ...defaultConfig, provider: 'zapo' as const }
    const after = { ...before, webhooks: [{ ...before.webhooks[0], id: 'type', url: 'https://example.test' }] }
    storedConfigMock.mockResolvedValue({ provider: 'zapo' })
    const reload = mockDeep<Reload>()
    const getConfig = jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
      .mockResolvedValueOnce(after).mockResolvedValueOnce({ ...after, webhooks: [] })
    const controller = new RegistrationController(getConfig, reload, mockDeep<Logout>())
    const req = { params: { phone: '5566000000099' }, body: { webhooks: after.webhooks }, headers: {}, query: {} } as unknown as Request
    await controller.register(req, response())
    await controller.register(req, response())
    expect(setConfigMock).toHaveBeenCalledTimes(2)
    expect(reload.run).not.toHaveBeenCalled()
  })

  test('an offline Zapo register cannot switch QR to pairing code without deregister', async () => {
    const config = { ...defaultConfig, provider: 'zapo' as const, connectionType: 'qrcode' as const }
    storedConfigMock.mockResolvedValue({ provider: 'zapo', connectionType: 'qrcode' })
    const reload = mockDeep<Reload>()
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    const req = { params: { phone: '5566000000001' }, body: { connectionType: 'pairing_code' }, method: 'POST', headers: {}, query: {} } as unknown as Request

    await controller.register(req, response())

    expect(setConfigMock).toHaveBeenCalledWith('5566000000001', {
      provider: 'zapo',
      server: 'server_1',
      zapoWebClientProfile: 'default',
      connectionType: 'qrcode',
    })
    expect(reload.run).toHaveBeenCalledWith('5566000000001')
  })

  test('a new registration can select pairing code after deregister removed the config', async () => {
    const config = { ...defaultConfig, provider: 'zapo' as const, connectionType: 'pairing_code' as const }
    storedConfigMock.mockResolvedValue(undefined)
    const reload = mockDeep<Reload>()
    reload.run.mockResolvedValue(undefined)
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    const req = { params: { phone: '5566000000002' }, body: { connectionType: 'pairing_code' }, method: 'POST', headers: {}, query: {} } as unknown as Request

    await controller.register(req, response())

    expect(setConfigMock).toHaveBeenCalledWith('5566000000002', {
      autoConnect: false,
      sessionStorageProvisionPending: { autoConnect: true, id: expect.any(String) },
      provider: 'zapo',
      server: 'server_1',
      zapoWebClientProfile: 'default',
      connectionType: 'pairing_code',
    })
  })

  test('a new registration replaces a disabled Baileys request with Zapo', async () => {
    const config = { ...defaultConfig, provider: 'zapo' as const, connectionType: 'qrcode' as const }
    storedConfigMock.mockResolvedValue(undefined)
    const reload = mockDeep<Reload>()
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    const req = {
      params: { phone: '5566000000004' },
      body: {
        provider: 'baileys',
        label: 'Legacy client',
        connectionType: 'qrcode',
      },
      method: 'POST',
      headers: {},
      query: {},
    } as unknown as Request

    await controller.register(req, response())

    expect(setConfigMock).toHaveBeenCalledWith('5566000000004', {
      autoConnect: false,
      sessionStorageProvisionPending: { autoConnect: true, id: expect.any(String) },
      provider: 'zapo',
      server: 'server_1',
      label: 'Legacy client',
      zapoWebClientProfile: 'default',
      connectionType: 'qrcode',
    })
    expect(reload.run).toHaveBeenCalledWith('5566000000004')
  })

  test.each(['wa_personal', 'wa_business'] as const)('persists a new QR web profile in Redis config (%s)', async (profile) => {
    const config = { ...defaultConfig, provider: 'zapo' as const, connectionType: 'qrcode' as const, zapoWebClientProfile: profile }
    storedConfigMock.mockResolvedValue(undefined)
    const reload = mockDeep<Reload>()
    reload.run.mockResolvedValue(undefined)
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    const res = response()
    await controller.register({ params: { phone: profile === 'wa_personal' ? '5566000000011' : '5566000000012' }, body: { provider: 'zapo', connectionType: 'qrcode', zapoWebClientProfile: profile }, headers: {}, query: {} } as unknown as Request, res)
    expect(setConfigMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ zapoWebClientProfile: profile, connectionType: 'qrcode' }))
    expect(reload.run).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test('rejects invalid, pairing-code and existing-session profile changes', async () => {
    const controller = new RegistrationController(jest.fn().mockResolvedValue({ ...defaultConfig, provider: 'zapo' }), mockDeep<Reload>(), mockDeep<Logout>())
    storedConfigMock.mockResolvedValue(undefined)
    const invalid = response()
    await controller.register({ params: { phone: '5566000000013' }, body: { zapoWebClientProfile: 'android' }, headers: {}, query: {} } as unknown as Request, invalid)
    expect(invalid.status).toHaveBeenCalledWith(400)
    expect(invalid.json).toHaveBeenCalledWith({ status: 'error', message: 'zapo_web_client_profile_invalid' })
    const pairing = response()
    await controller.register({ params: { phone: '5566000000014' }, body: { connectionType: 'pairing_code', zapoWebClientProfile: 'wa_personal' }, headers: {}, query: {} } as unknown as Request, pairing)
    expect(pairing.status).toHaveBeenCalledWith(400)
    storedConfigMock.mockResolvedValue({ provider: 'zapo', zapoWebClientProfile: 'default' })
    const existing = response()
    await controller.register({ params: { phone: '5566000000015' }, body: { zapoWebClientProfile: 'wa_business' }, headers: {}, query: {} } as unknown as Request, existing)
    expect(existing.status).toHaveBeenCalledWith(409)
    expect(setConfigMock).not.toHaveBeenCalled()
  })

  test('a persisted Baileys session must be deregistered instead of reconnecting', async () => {
    const config = { ...defaultConfig, provider: 'baileys' as const }
    storedConfigMock.mockResolvedValue({ provider: 'baileys' })
    const reload = mockDeep<Reload>()
    const res = response()
    const controller = new RegistrationController(
      jest.fn().mockResolvedValue(config),
      reload,
      mockDeep<Logout>(),
    )
    const req = {
      params: { phone: '5566000000003' },
      body: {},
      method: 'POST',
      headers: {},
      query: {},
    } as unknown as Request

    await controller.register(req, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      message: 'baileys_provider_disabled_deregister_required',
    })
    expect(setConfigMock).not.toHaveBeenCalled()
    expect(reload.run).not.toHaveBeenCalled()
  })

  test('SQLite explicitly unlinked by deregister can choose a new QR profile without replacing historical storage', async () => {
    const config = { ...defaultConfig, provider: 'zapo' as const, server: 'owner_1', autoConnect: false, connectionType: 'pairing_code' as const, zapoWebClientProfile: 'default' as const,
      sessionStorageUnlinked: true, sessionStorage: { backend: 'sqlite' as const, storageId: '12345678-1234-4234-8234-123456789abc', owner: 'owner_1', generation: 3, state: 'offline' as const } }
    storedConfigMock.mockResolvedValue(config)
    const reload = mockDeep<Reload>(); reload.run.mockResolvedValue(undefined)
    const res = response(), controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    await controller.register({ params: { phone: '5566000000171' }, body: { connectionType: 'qrcode', zapoWebClientProfile: 'wa_business' }, headers: {}, query: {} } as unknown as Request, res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(setConfigMock).toHaveBeenCalledWith('5566000000171', expect.objectContaining({ sessionStorageUnlinked: false, autoConnect: true, connectionType: 'qrcode', zapoWebClientProfile: 'wa_business' }))
    expect(setConfigMock.mock.calls[0][1]).not.toHaveProperty('sessionStorage')
    expect(reload.run).toHaveBeenCalledWith('5566000000171')
  })

  test.each(['marker-forged', 'linked', 'online', 'primary', 'transition', 'owner-change', 'provider-change'])('retained SQLite config does not bypass registration guards (%s)', async reason => {
    const config: any = { ...defaultConfig, provider: 'zapo', server: 'owner_1', autoConnect: false, sessionStorageUnlinked: true,
      sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'owner_1', generation: 3, state: 'offline' } }
    const body: any = { zapoWebClientProfile: 'wa_business' }
    if (reason === 'marker-forged') body.sessionStorageUnlinked = true
    if (reason === 'linked') config.sessionStorageUnlinked = false
    if (reason === 'online') config.autoConnect = true
    if (reason === 'primary') config.mobilePrimaryDraftId = 'draft'
    if (reason === 'transition') config.sessionStorage.state = 'migrating'
    if (reason === 'owner-change') body.server = 'foreign'
    if (reason === 'provider-change') body.provider = 'baileys'
    storedConfigMock.mockResolvedValue(config)
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), mockDeep<Reload>(), mockDeep<Logout>()), res = response()
    await controller.register({ params: { phone: '5566000000172' }, body, headers: {}, query: {} } as unknown as Request, res)
    expect(res.status).toHaveBeenCalledWith(reason === 'marker-forged' ? 400 : 409)
    expect(setConfigMock).not.toHaveBeenCalled()
  })

  test('an explicit SQLite relink is not suppressed by a recent registration debounce', async () => {
    const config: any = { ...defaultConfig, provider: 'zapo', server: 'owner_1', autoConnect: false, sessionStorageUnlinked: true,
      sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'owner_1', generation: 3, state: 'offline' } }
    const reload = mockDeep<Reload>(); reload.run.mockResolvedValue(undefined)
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    const request: any = { params: { phone: '5566000000173' }, body: { connectionType: 'qrcode', zapoWebClientProfile: 'wa_personal' }, headers: {}, query: {} }
    storedConfigMock.mockResolvedValue(config)
    const first = response(); await controller.register(request, first)
    const second = response(); await controller.register({ ...request, body: { ...request.body, zapoWebClientProfile: 'wa_business' } }, second)
    expect(first.status).toHaveBeenCalledWith(200); expect(second.status).toHaveBeenCalledWith(200)
    expect(reload.run).toHaveBeenCalledTimes(2)
  })
})
