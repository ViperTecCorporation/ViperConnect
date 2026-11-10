/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../src/services/passkey_bridge', () => ({
  deletePasskeyBridgeSession: jest.fn(),
  fromBase64Url: jest.fn(),
  getPasskeyBridgeSession: jest.fn(),
  listPasskeyBridgeSessions: jest.fn(),
  updatePasskeyBridgeSession: jest.fn(),
}))
jest.mock('../../src/services/session_storage/rpc', () => ({ sessionStorageRpc: jest.fn() }))

import { PasskeyBridgeController } from '../../src/controllers/passkey_bridge_controller'
import { defaultConfig } from '../../src/services/config'
import { fromBase64Url, getPasskeyBridgeSession, updatePasskeyBridgeSession } from '../../src/services/passkey_bridge'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'

describe('PasskeyBridgeController', () => {
  afterEach(() => {
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
    ;(sessionStorageRpc as jest.Mock).mockResolvedValue({ bridgeId: session.bridgeId, status: 'response-sent', providerManagedConfirmation: true })
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

    expect(sessionStorageRpc).toHaveBeenCalledWith(phone, expect.any(Object), 'passkey.confirm', [session.bridgeId])
    expect(updatePasskeyBridgeSession).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      bridge_id: session.bridgeId,
      status: 'response-sent',
      provider_managed_confirmation: true,
    })
  })

  test.each(['accepted', 'unauthorized', 'missing-result', 'transport-failure'])('HTTP assertion uses owner RPC only and never invents success: %s', async reason => {
    const phone = '999123456789', bridgeId = 'bridge-fixture'
    ;(getPasskeyBridgeSession as jest.Mock).mockResolvedValue({ phone, bridgeId, status: 'request' })
    ;(fromBase64Url as jest.Mock).mockReturnValue(Buffer.from([1, 2, 255]))
    ;(sessionStorageRpc as jest.Mock).mockResolvedValue(reason === 'missing-result' ? undefined : { bridgeId, status: 'response-sent' })
    if (reason === 'transport-failure') (sessionStorageRpc as jest.Mock).mockRejectedValueOnce(new Error('private_transport_diagnostic'))
    const controller = new PasskeyBridgeController(async () => ({ ...defaultConfig, provider: 'zapo', server: 'owner_fixture', authToken: 'session-token' }))
    const req: any = { params: { bridgeId }, headers: { authorization: `Bearer ${reason === 'unauthorized' ? 'foreign' : 'session-token'}` }, query: {}, body: { credential_id: 'AQI_', assertion_json: { authenticatorData: 'synthetic' } } }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    await controller.assertion(req, res)
    expect(res.status).toHaveBeenCalledWith(reason === 'accepted' ? 200 : reason === 'unauthorized' ? 403 : reason === 'missing-result' ? 502 : 503)
    if (reason === 'unauthorized') expect(sessionStorageRpc).not.toHaveBeenCalled()
    else expect(sessionStorageRpc).toHaveBeenCalledWith(phone, expect.objectContaining({ server: 'owner_fixture' }), 'passkey.assertion', [bridgeId, { credentialId: Buffer.from([1, 2, 255]), assertionJson: '{"authenticatorData":"synthetic"}' }])
    expect(updatePasskeyBridgeSession).not.toHaveBeenCalled()
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('private_transport_diagnostic')
  })
})
