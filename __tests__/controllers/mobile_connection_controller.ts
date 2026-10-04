import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'

test('mobile connection routes require admin and keep secrets out of failures', async () => {
  const identity: any = { authenticate: jest.fn(async (): Promise<any> => ({ role: 'admin', kind: 'stack' })) }
  const connection: any = { status: jest.fn(async () => ({ status: 'online' })), connect: jest.fn(async () => ({ status: 'connection_requested' })) }
  const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity, {} as any, () => true, {} as any, async () => connection))
  expect((await request(app).post('/manager/mobile-devices/id/connection').send({ confirm: true })).status).toBe(401)
  expect((await request(app).post('/manager/mobile-devices/id/connection').set('Authorization', 'Bearer test').send({ confirm: true })).status).toBe(202)
  expect(connection.connect).toHaveBeenCalledWith('id', { confirm: true })
  expect((await request(app).get('/manager/mobile-devices/id/connection').set('Authorization', 'Bearer test')).body.status).toBe('online')
  identity.authenticate.mockResolvedValue({ role: 'user', kind: 'login' })
  expect((await request(app).post('/manager/mobile-devices/id/connection').set('Authorization', 'Bearer test')).status).toBe(403)
  identity.authenticate.mockResolvedValue({ role: 'admin', kind: 'stack' })
  connection.connect.mockRejectedValue(new Error('SECRET'))
  const failure = await request(app).post('/manager/mobile-devices/id/connection').set('Authorization', 'Bearer test').send({ confirm: true })
  expect(failure.status).toBe(503); expect(failure.text).not.toContain('SECRET')
})
