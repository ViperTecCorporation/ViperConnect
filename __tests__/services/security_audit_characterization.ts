// Characterization of unresolved findings, NOT the desired security contract.
// Replace these expectations with rejection tests when each fix is authorized.
import { EmbeddedController } from '../../src/controllers/embedded_controller'
import { MediaController } from '../../src/controllers/media_controller'
import { WebhookController } from '../../src/controllers/webhook_controller'
import Security from '../../src/services/security'

jest.mock('../../src/defaults', () => ({ UNOAPI_AUTH_TOKEN: 'audit-admin', UNOAPI_HEADER_NAME: 'Authorization' }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('../../src/services/meta_alias', () => ({ resolveSessionPhoneByMetaId: async (phone: string) => phone }))
jest.mock('../../src/services/redis', () => ({ getPhoneByPhoneNumberId: jest.fn() }))
jest.mock('../../src/services/coexistence_window', () => ({ registerMetaWebhookWindow: jest.fn() }))

const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn(), send: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}
const req = (params = {}, token = ''): any => ({ path: '/v24.0/test', params, headers: { authorization: token }, query: {}, body: {} })

describe('unresolved security findings (isolated characterization)', () => {
  test('public OAuth mint is accepted for an arbitrary session without checking its tokens', async () => {
    const res = response()
    await new EmbeddedController().oauthAccessToken(req(), res)
    const token = res.json.mock.calls[0][0].access_token
    const store: any = { getTokens: jest.fn() }
    const next = jest.fn()
    await new Security(store).run(req({ phone: 'session-B' }, `Bearer ${token}`), response(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(store.getTokens).not.toHaveBeenCalled()
  })
  test('a session-A token can resolve session-B media through the unscoped typebot route', async () => {
    const store: any = { getTokens: jest.fn().mockResolvedValue(['session-A-token']) }
    const config: any = jest.fn().mockResolvedValue({ getStore: async () => ({
      dataStore: { loadMediaPayload: async () => ({ url: 'https://example.invalid/fixture', mime_type: 'image/png' }) },
      mediaStore: { getMedia: async () => undefined },
    }) })
    const request = req({ media_id: '22222222222-fixture' }, 'Bearer session-A-token')
    const next = jest.fn()
    await new Security(store).run(request, response(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(store.getTokens).toHaveBeenCalledWith('*')
    const res = response()
    await new MediaController('https://example.invalid', config, store).typebot(request, res)
    expect(config).toHaveBeenCalledWith('22222222222')
    expect(res.status).toHaveBeenCalledWith(200)
  })
  test('malformed token is rejected instead of throwing (Manager parser regression)', async () => {
    const request = req()
    request.query.access_token = { unexpected: 'value' }
    const res = response()
    const next = jest.fn()
    await new Security({} as any).run(request, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  test('inbound webhook forwards an unsigned body', async () => {
    const outgoing: any = { send: jest.fn().mockResolvedValue(undefined) }
    const config: any = async () => ({ coexistenceEnabled: false })
    const request = req({ phone: '22222222222' })
    request.body = { fixture: true }
    await new WebhookController(outgoing, config).whatsapp(request, response())
    expect(outgoing.send).toHaveBeenCalledWith('22222222222', { fixture: true })
  })
})
