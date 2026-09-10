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
