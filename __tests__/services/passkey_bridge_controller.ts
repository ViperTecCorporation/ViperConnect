/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../src/services/passkey_bridge', () => ({
  deletePasskeyBridgeSession: jest.fn(),
  fromBase64Url: jest.fn(),
  getPasskeyBridgeSession: jest.fn(),
  listPasskeyBridgeSessions: jest.fn(),
  updatePasskeyBridgeSession: jest.fn(),
}))

import { PasskeyBridgeController } from '../../src/controllers/passkey_bridge_controller'
import { clients } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import { getPasskeyBridgeSession, updatePasskeyBridgeSession } from '../../src/services/passkey_bridge'

describe('PasskeyBridgeController', () => {
  afterEach(() => {
    clients.clear()
    jest.clearAllMocks()
  })

  test('keeps provider-managed Zapo confirmation pending until auth_paired', async () => {
    const phone = '5566999999999'
    const session = {
      bridgeId: 'bridge-1',
      phone,
      status: 'response-sent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    ;(getPasskeyBridgeSession as jest.Mock).mockResolvedValue(session)
    const sendPasskeyConfirmation = jest.fn().mockResolvedValue({
      ok: { success: true, provider_managed_confirmation: true },
    })
    clients.set(phone, { sendPasskeyConfirmation } as any)
    const controller = new PasskeyBridgeController(async () => ({
      ...defaultConfig,
      authToken: 'session-token',
    }))
    const req = {
      params: { bridgeId: session.bridgeId },
      headers: { authorization: 'Bearer session-token' },
      query: {},
      body: {},
    } as any
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as any

    await controller.confirm(req, res)

    expect(sendPasskeyConfirmation).toHaveBeenCalledTimes(1)
    expect(updatePasskeyBridgeSession).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      bridge_id: session.bridgeId,
      status: 'response-sent',
      provider_managed_confirmation: true,
    })
  })
})
