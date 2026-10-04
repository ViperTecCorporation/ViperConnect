import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'

test('companion commands require admin bearer and sanitize failures', async () => {
  const identity: any = { authenticate: jest.fn().mockResolvedValue({ role: 'admin', kind: 'stack' }) }
  const operations: any = { submit: jest.fn().mockResolvedValue({ id: 'op', state: 'queued' }), status: jest.fn().mockResolvedValue({ id: 'op', state: 'done' }) }
  const factory: any = jest.fn().mockResolvedValue(operations)
  const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity, {} as any, () => true, {} as any, undefined, undefined, undefined, factory))
  const path = '/manager/mobile-devices/id/companions'
  expect((await request(app).post(path).send({ action: 'list' })).status).toBe(401)
  expect(factory).not.toHaveBeenCalled()
  expect((await request(app).post(path).set('Authorization', 'Bearer test').send({ action: 'list' })).status).toBe(202)
  expect(operations.submit).toHaveBeenCalledWith({ action: 'list' })
  expect((await request(app).get(path + '/op').set('Authorization', 'Bearer test')).body.state).toBe('done')
  expect(operations.status).toHaveBeenCalledWith('op')
  for (const principal of [{ role: 'user', kind: 'login' }, { role: 'admin', kind: 'api' }]) {
    identity.authenticate.mockResolvedValue(principal)
    expect((await request(app).post(path).set('Authorization', 'Bearer test').send({ action: 'list' })).status).toBe(403)
  }
  identity.authenticate.mockResolvedValue({ role: 'admin', kind: 'stack' })
  operations.submit.mockRejectedValue(new Error('SECRET'))
  const result = await request(app).post(path).set('Authorization', 'Bearer test').send({ action: 'list' })
  expect(result.status).toBe(503); expect(result.text).not.toContain('SECRET')
})
