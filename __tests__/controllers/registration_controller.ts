import type { Request, Response } from 'express'
import { mockDeep } from 'jest-mock-extended'
import { defaultConfig } from '../../src/services/config'
import { RegistrationController } from '../../src/controllers/registration_controller'
import type { Logout } from '../../src/services/logout'
import type { Reload } from '../../src/services/reload'
import { getConfig as getStoredConfig, setConfig } from '../../src/services/redis'

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
  beforeEach(() => jest.clearAllMocks())

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

  test.each([true, false])('server_1 alias is restricted to the mobile lab (enabled=%s)', async (enabled) => {
    const oldFlag = process.env.UNOAPI_MOBILE_PRIMARY_LAB
    const oldServer = process.env.UNOAPI_SERVER_NAME
    process.env.UNOAPI_MOBILE_PRIMARY_LAB = String(enabled)
    process.env.UNOAPI_SERVER_NAME = 'mobile_lab'
    try {
      const config = { ...defaultConfig, provider: 'zapo' as const, server: 'mobile_lab', webhooks: [] }
      storedConfigMock.mockResolvedValue({ provider: 'zapo', mobilePrimaryDraftId: 'lab-device' })
      const reload = mockDeep<Reload>()
      const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
      const res = response()
      await controller.register({ params: { phone: '5566000000083' }, body: { server: 'server_1', webhooks: [] }, headers: {}, query: {} } as unknown as Request, res)
      expect(res.status).toHaveBeenCalledWith(enabled ? 200 : 409)
      if (enabled) expect(setConfigMock).toHaveBeenCalledWith('5566000000083', expect.objectContaining({ server: 'mobile_lab', webhooks: [] }))
      else expect(setConfigMock).not.toHaveBeenCalled()
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
      connectionType: 'qrcode',
    })
    expect(reload.run).toHaveBeenCalledWith('5566000000001')
  })

  test('a new registration can select pairing code after deregister removed the config', async () => {
    const config = { ...defaultConfig, provider: 'zapo' as const, connectionType: 'pairing_code' as const }
    storedConfigMock.mockResolvedValue(undefined)
    const reload = mockDeep<Reload>()
    const controller = new RegistrationController(jest.fn().mockResolvedValue(config), reload, mockDeep<Logout>())
    const req = { params: { phone: '5566000000002' }, body: { connectionType: 'pairing_code' }, method: 'POST', headers: {}, query: {} } as unknown as Request

    await controller.register(req, response())

    expect(setConfigMock).toHaveBeenCalledWith('5566000000002', {
      provider: 'zapo',
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
      provider: 'zapo',
      label: 'Legacy client',
      connectionType: 'qrcode',
    })
    expect(reload.run).toHaveBeenCalledWith('5566000000004')
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
})
