import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'

test('full deletion requires authenticated administrator and delegates explicit confirmation', async () => {
  const identity = { authenticate: jest.fn().mockResolvedValue({ role: 'admin', kind: 'stack' }) }
  const service = { remove: jest.fn().mockResolvedValue(undefined) }
  const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity as any, {} as any, () => true, {} as any, undefined, async () => service as any))
  const url = '/manager/mobile-devices/draft/full', body = { confirm: true, acknowledgeNewSms: true, phone: '999123456789' }
  expect((await request(app).delete(url).send(body)).status).toBe(401)
  expect(service.remove).not.toHaveBeenCalled()
  expect((await request(app).delete(url).set('Authorization', 'Bearer test').send(body)).status).toBe(204)
  expect(service.remove).toHaveBeenCalledWith('draft', body)
  identity.authenticate.mockResolvedValue({ role: 'user', kind: 'login' })
  expect((await request(app).delete(url).set('Authorization', 'Bearer test').send(body)).status).toBe(403)
  expect(service.remove).toHaveBeenCalledTimes(1)
})
