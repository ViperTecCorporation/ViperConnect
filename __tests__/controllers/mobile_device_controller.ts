import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'
import { MobileDeviceError } from '../../src/services/mobile_device_service'
import { apiErrorLocalization } from '../../src/services/api_error_localization'

describe('mobile draft administrative API', () => {
  const identity = { authenticate: jest.fn() }
  const service: any = { list: jest.fn(), get: jest.fn(), create: jest.fn(), remove: jest.fn() }
  const enabled = jest.fn()
  const app = express().use(express.json()).use(apiErrorLocalization).use('/manager/mobile-devices', mobileDeviceRouter(identity as any, service, enabled))
  const auth = { Authorization: 'Bearer lab-token' }
  beforeEach(() => {
    jest.resetAllMocks(); enabled.mockReturnValue(true)
    identity.authenticate.mockResolvedValue({ id: 'admin', role: 'admin', kind: 'stack' })
    service.list.mockResolvedValue([])
  })
  test('feature is disabled without touching authentication or Redis', async () => {
    enabled.mockReturnValue(false)
    expect((await request(app).get('/manager/mobile-devices').set(auth)).status).toBe(404)
    expect(identity.authenticate).not.toHaveBeenCalled()
    expect(service.list).not.toHaveBeenCalled()
  })
  test.each(['', '?access_token=lab-token'])('rejects absent bearer header %s', async suffix => {
    expect((await request(app).get('/manager/mobile-devices' + suffix)).status).toBe(401)
    expect(identity.authenticate).not.toHaveBeenCalled()
  })
  test.each([{ role: 'user', kind: 'login' }, { role: 'admin', kind: 'api' }, { role: 'unknown', kind: 'stack' }])('denies non-admin/non-login principal %#', async principal => {
    identity.authenticate.mockResolvedValue(principal)
    expect((await request(app).get('/manager/mobile-devices').set(auth)).status).toBe(403)
    expect(service.list).not.toHaveBeenCalled()
  })
  test('invalid authentication and infrastructure failures are distinct', async () => {
    identity.authenticate.mockResolvedValue(null)
    expect((await request(app).get('/manager/mobile-devices').set(auth)).status).toBe(401)
    identity.authenticate.mockRejectedValue(new Error('secret-do-not-expose'))
    const response = await request(app).get('/manager/mobile-devices').set(auth)
    expect(response.status).toBe(503)
    expect(response.text).not.toContain('secret-do-not-expose')
  })
  test('capabilities explicitly deny SMS, connection and companions', async () => {
    const response = await request(app).get('/manager/mobile-devices/capabilities').set(auth)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ smsRegistration: false, primaryConnection: false, companionQr: false })
    expect(response.headers['cache-control']).toBe('no-store')
  })
  test('create delegates actor from authenticated identity, never from request input', async () => {
    service.create.mockResolvedValue({ id: 'test', state: 'draft' })
    const response = await request(app).post('/manager/mobile-devices').set(auth).send({ name: 'Lab' })
    expect(response.status).toBe(201)
    expect(service.create).toHaveBeenCalledWith({ name: 'Lab' }, 'admin')
  })
  test('list and get return service data', async () => {
    expect((await request(app).get('/manager/mobile-devices').set(auth)).body).toEqual({ devices: [] })
    service.get.mockResolvedValue({ id: 'test' })
    expect((await request(app).get('/manager/mobile-devices/test').set(auth)).body).toEqual({ id: 'test' })
  })
  test('delete requires explicit confirmation and no extra fields', async () => {
    for (const body of [{}, { confirm: 'true' }, { confirm: true, all: true }]) {
      expect((await request(app).delete('/manager/mobile-devices/test').set(auth).send(body)).status).toBe(400)
    }
    expect(service.remove).not.toHaveBeenCalled()
    expect((await request(app).delete('/manager/mobile-devices/test').set(auth).send({ confirm: true })).status).toBe(204)
    expect(service.remove).toHaveBeenCalledWith('test')
  })
  test('known conflict is localized and unknown infrastructure details are hidden', async () => {
    service.create.mockRejectedValue(new MobileDeviceError(409, 'mobile_phone_already_drafted'))
    const conflict = await request(app).post('/manager/mobile-devices').set(auth).send({})
    expect(conflict.status).toBe(409)
    expect(conflict.body.error_code).toBe('mobile_phone_already_drafted')
    expect(conflict.body.error).toMatch(/telefone/)
    service.list.mockRejectedValue(new Error('secret-do-not-expose'))
    const response = await request(app).get('/manager/mobile-devices').set(auth)
    expect(response.status).toBe(503)
    expect(response.text).not.toContain('secret-do-not-expose')
  })
})
