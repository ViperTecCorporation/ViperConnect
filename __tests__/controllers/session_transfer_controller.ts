import express from 'express'
import request from 'supertest'
import { sessionTransferRouter } from '../../src/controllers/session_transfer_controller'
import { ManagerError } from '../../src/services/manager_identity'

test('session transfers are admin-only and deletion reauthenticates without forwarding password', async () => {
  const identity = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login', id: 'admin' })), confirmAdminPassword: jest.fn(async () => {}) }
  const service = { list: jest.fn(async () => ({ tasks: [] })), remove: jest.fn(), restore: jest.fn(async () => ({ restored: true })), tasks: { start: jest.fn(async () => ({ status: 'running' })), download: jest.fn(async () => ({ archive: 'encrypted' })) } }
  const app = express().use(express.json()).use('/transfer', sessionTransferRouter(identity as any, async () => service as any))
  expect((await request(app).get('/transfer/backups')).status).toBe(401)
  expect((await request(app).get('/transfer/backups').set('Authorization', 'Bearer test')).status).toBe(200)
  const body = { password: 'admin-password', phone: '999123456789', confirm: true, backupValidated: true }
  identity.confirmAdminPassword.mockRejectedValueOnce(new ManagerError(401, 'wrong'))
  expect((await request(app).delete('/transfer/999123456789/transfer-removal').set('Authorization', 'Bearer test').send(body)).status).toBe(401)
  expect(service.remove).not.toHaveBeenCalled()
  expect((await request(app).delete('/transfer/999123456789/transfer-removal').set('Authorization', 'Bearer test').send(body)).status).toBe(204)
  expect(service.remove).toHaveBeenCalledWith(body.phone, { phone: body.phone, confirm: true, backupValidated: true })
  expect((await request(app).post('/transfer/999123456789/backup-tasks').set('Authorization', 'Bearer test').send({})).status).toBe(202)
  identity.authenticate.mockResolvedValue({ role: 'admin', kind: 'api', id: 'admin' })
  expect((await request(app).post('/transfer/restore').set('Authorization', 'Bearer test').send({})).status).toBe(403)
})
