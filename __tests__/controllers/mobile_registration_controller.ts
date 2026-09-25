import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'

describe('experimental registration HTTP authorization and contract', () => {
  const identity = { authenticate: jest.fn() }
  const reg: any = { enabled: () => true, status: jest.fn(), execute: jest.fn() }
  const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity as any, {} as any, () => true, reg))
  beforeEach(() => { jest.clearAllMocks(); identity.authenticate.mockResolvedValue({ role: 'admin', kind: 'stack' }); reg.execute.mockResolvedValue({ status: 'code_required' }); reg.status.mockResolvedValue({ status: 'idle' }) })
  test('requires bearer admin on every endpoint', async () => {
    expect((await request(app).get('/manager/mobile-devices/id/registration')).status).toBe(401)
    expect((await request(app).post('/manager/mobile-devices/id/registration/request').send({ token: 'secret' })).status).toBe(401)
    identity.authenticate.mockResolvedValue({ role: 'user', kind: 'login' })
    expect((await request(app).post('/manager/mobile-devices/id/registration/verify').set('Authorization', 'Bearer secret').send({ code: '123456' })).status).toBe(403)
    expect(reg.execute).not.toHaveBeenCalled()
  })
  test('delegates status and both operations with no-store', async () => {
    const status = await request(app).get('/manager/mobile-devices/id/registration').set('Authorization', 'Bearer secret')
    expect(status.body.status).toBe('idle'); expect(status.headers['cache-control']).toBe('no-store')
    for (const [operation, body] of [['request', { confirm: true }], ['verify', { code: '012345' }]] as const) {
      const response = await request(app).post(`/manager/mobile-devices/id/registration/${operation}`).set('Authorization', 'Bearer secret').send(body)
      expect(response.status).toBe(200); expect(reg.execute).toHaveBeenLastCalledWith('id', operation, body)
    }
  })
  test('provider exception cannot leak secrets', async () => {
    reg.execute.mockRejectedValue(new Error('secret code=123456'))
    const response = await request(app).post('/manager/mobile-devices/id/registration/request').set('Authorization', 'Bearer secret').send({ confirm: true })
    expect(response.status).toBe(503); expect(response.text).not.toContain('123456')
  })
})
