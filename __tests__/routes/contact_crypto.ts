import express from 'express'
import request from 'supertest'
import { mock } from 'jest-mock-extended'
import { ContactCryptoController } from '../../src/controllers/contact_crypto_controller'
import type { Incoming } from '../../src/services/incoming'
import { defaultConfig } from '../../src/services/config'
import { SendError } from '../../src/services/send_error'
import { managerAccess } from '../../src/services/manager_access'

describe('POST /:phone/contacts/recover-crypto', () => {
  const phone = '5511999999999'
  const incoming = mock<Incoming>()
  const config = jest.fn()
  const authenticate = jest.fn()
  const controller = new ContactCryptoController(incoming, config)
  const app = express()
  app.use(express.json())
  app.use(managerAccess({ authenticate } as never, async value => value))
  app.post('/:phone/contacts/recover-crypto', controller.recover.bind(controller))
  const post = (body = { user_id: '123@lid', confirm: true }, target = phone) => request(app)
    .post(`/${target}/contacts/recover-crypto`).set('Authorization', 'Bearer mgr_key_test').send(body)
  beforeEach(() => {
    jest.clearAllMocks()
    authenticate.mockResolvedValue({ id: 'u1', role: 'user', kind: 'api', phones: [phone] })
    config.mockResolvedValue({ ...defaultConfig, provider: 'zapo' })
    incoming.recoverContactCrypto!.mockResolvedValue({ success: true, user_id: '123@lid', resent: false, cooldown_seconds: 300 })
  })
  test('uses the authenticated assigned session and explicit confirmation', async () => {
    const result = await post().expect(200)
    expect(result.body.resent).toBe(false)
    expect(incoming.recoverContactCrypto).toHaveBeenCalledWith(phone, '123@lid')
  })
  test('denies another session', async () => {
    await post(undefined, '5511888888888').expect(403)
    expect(incoming.recoverContactCrypto).not.toHaveBeenCalled()
  })
  test('denies invalid personal credentials', async () => {
    authenticate.mockResolvedValue(null)
    expect((await post()).status).toBeGreaterThanOrEqual(400)
    expect(incoming.recoverContactCrypto).not.toHaveBeenCalled()
  })
  test.each([{ user_id: '123@g.us', confirm: true }, { user_id: '123@lid', confirm: false }])('rejects unsafe request %p', async body => {
    await post(body).expect(400)
    expect(incoming.recoverContactCrypto).not.toHaveBeenCalled()
  })
  test('does not fall back to another engine', async () => {
    config.mockResolvedValue({ ...defaultConfig, provider: 'baileys' })
    await post().expect(409)
    expect(incoming.recoverContactCrypto).not.toHaveBeenCalled()
  })
  test.each([404, 409, 429, 502])('preserves worker error %s including RPC serialized errors', async code => {
    incoming.recoverContactCrypto!.mockRejectedValue(new Error(`${code}: recovery_error`))
    const result = await post().expect(code)
    if (code === 429) expect(result.headers['retry-after']).toBe('300')
  })
  test('preserves direct provider errors', async () => {
    incoming.recoverContactCrypto!.mockRejectedValue(new SendError(409, 'zapo_client_not_connected'))
    expect((await post().expect(409)).body.error).toBe('zapo_client_not_connected')
  })
  test('does not claim completion on RPC timeout or expose internal errors', async () => {
    incoming.recoverContactCrypto!.mockRejectedValue(new Error('timeout internal data'))
    expect((await post().expect(502)).body).toEqual({ error: 'contact_crypto_recovery_unconfirmed' })
  })
})
