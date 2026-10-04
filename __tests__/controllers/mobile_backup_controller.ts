import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'

test('backup/restore accept only an authenticated administrator and set no-store', async () => {
  const identity = { authenticate: jest.fn().mockResolvedValue({ id: 'admin', role: 'admin', kind: 'stack' }) }
  const service = { export: jest.fn().mockResolvedValue({ archive: 'encrypted' }), restore: jest.fn().mockResolvedValue({ status: 'disconnected' }) }
  const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity as any, {} as any, () => true, {} as any, undefined, undefined, async () => service))
  const url = '/manager/mobile-devices'
  expect((await request(app).post(url + '/draft/backup').send({})).status).toBe(401)
  expect((await request(app).post(url + '/restore').send({})).status).toBe(401)
  const body = { confirmSuspend: true, password: 'synthetic-password' }
  const response = await request(app).post(url + '/draft/backup').set('Authorization', 'Bearer synthetic').send(body)
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
  expect(service.export).toHaveBeenCalledWith('draft', body)
  expect((await request(app).post(url + '/restore').set('Authorization', 'Bearer synthetic').send({ archive: 'encrypted' })).status).toBe(201)
  expect(service.restore).toHaveBeenCalledWith({ archive: 'encrypted' }, 'admin')
  identity.authenticate.mockResolvedValue({ id: 'user', role: 'user', kind: 'login' })
  expect((await request(app).post(url + '/restore').set('Authorization', 'Bearer synthetic').send({})).status).toBe(403)
  expect(service.restore).toHaveBeenCalledTimes(1)
})
test('background backup and downloads require admin; accepted response contains metadata only', async () => {
  const tasks = { start: jest.fn(async () => ({ id: 'task', deviceId: 'draft', status: 'running' })), status: jest.fn(async () => ({ id: 'task', status: 'ready' })), download: jest.fn(async () => ({ archive: 'encrypted', fileName: 'backup.viperdevice' })) }
  const identity = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login', id: 'admin' })) }
  const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity as any, { list: async () => [{ id: 'draft' }] } as any, () => true, {} as any, undefined, undefined, undefined, undefined, undefined, async () => tasks as any))
  const url = '/manager/mobile-devices/draft/backup-tasks'
  expect((await request(app).post(url).send({})).status).toBe(401)
  const accepted = await request(app).post(url).set('Authorization', 'Bearer test').send({ password: 'test-password-123', mode: 'complete', confirmSuspend: true })
  expect(accepted.status).toBe(202)
  expect(JSON.stringify(accepted.body)).not.toContain('password')
  expect((await request(app).get('/manager/mobile-devices/backups').set('Authorization', 'Bearer test')).body.tasks).toHaveLength(1)
  expect((await request(app).get(url + '/task/download').set('Authorization', 'Bearer test')).body.archive).toBe('encrypted')
  identity.authenticate.mockResolvedValue({ role: 'admin', kind: 'api', id: 'admin' })
  expect((await request(app).get(url + '/task/download').set('Authorization', 'Bearer test')).status).toBe(403)
  expect(tasks.download).toHaveBeenCalledTimes(1)
})
