import express from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { ServiceControlController } from '../../src/controllers/service_control_controller'
import { serviceControlServer } from '../../src/services/service_control/agent_server'
import { ServiceControlError } from '../../src/services/service_control/types'
import { managerAccess } from '../../src/services/manager_access'

const component = 'a'.repeat(24), secret = 'agent-test-only-secret'.repeat(2), guard = 'guard-test-only-secret'.repeat(2)
test('Manager administrator works after header redaction, ordinary Manager user is denied', async () => {
  const client = { overview: jest.fn().mockResolvedValue({ configured: true, targets: [] }) }
  const controller = new ServiceControlController(client as any, 'global-test')
  const app = express()
  app.use(managerAccess({ authenticate: async token => ({ id: 'administrator-id', role: token === 'mgr_admin_test' ? 'admin' : 'user', phones: [], username: 'test', name: 'test', kind: 'login' }) } as any))
  app.get('/admin/resources/control', controller.handle.bind(controller))
  expect((await request(app).get('/admin/resources/control').set('Authorization', 'Bearer mgr_user_test')).status).toBe(403)
  expect(client.overview).not.toHaveBeenCalled()
  expect((await request(app).get('/admin/resources/control').set('Authorization', 'Bearer mgr_admin_test')).status).toBe(200)
})
test('web proxy is admin only, strips caller fields and has no arbitrary target/URL/command', async () => {
  const client = { overview: jest.fn().mockResolvedValue({ configured: false, targets: [] }), restart: jest.fn().mockResolvedValue({ state: 'accepted' }), operation: jest.fn().mockResolvedValue({ state: 'running' }) }
  const controller = new ServiceControlController(client as any, 'admin-secret', jest.fn(), guard)
  const app = express(); app.use(express.json()); app.get('/admin/resources/control', controller.handle.bind(controller)); app.get('/admin/resources/operations/:operation', controller.handle.bind(controller)); app.post('/admin/resources/:component/restart', controller.handle.bind(controller))
  const body = { operationId: randomUUID(), confirm: component, confirmation: 'proof', actor: 'fake', target: '/etc/passwd', url: 'http://evil' }
  expect((await request(app).get('/admin/resources/control')).status).toBe(403)
  expect((await request(app).post(`/admin/resources/${component}/restart`).set('Authorization', 'Bearer session-token').send(body)).status).toBe(403)
  expect(client.restart).not.toHaveBeenCalled()
  expect((await request(app).get('/admin/resources/control').set('Authorization', 'Bearer admin-secret')).body).toEqual({ configured: false, targets: [] })
  expect((await request(app).post(`/admin/resources/${component}/restart`).set('Authorization', 'Bearer admin-secret').send(body)).status).toBe(202)
  expect(client.restart).toHaveBeenCalledWith(component, { operationId: body.operationId, confirm: component, confirmation: 'proof' }, 'global-admin')
  expect((await request(app).post('/admin/resources/total/restart').set('Authorization', 'Bearer admin-secret').send(body)).status).toBe(400)
  expect((await request(app).get('/admin/resources/operations/no').set('Authorization', 'Bearer admin-secret')).status).toBe(400)
  const status = await request(app).get(`/admin/resources/operations/${body.operationId}`).set('Authorization', 'Bearer admin-secret')
  expect(status.status).toBe(200); expect(status.header['cache-control']).toBe('no-store')
})
test('internal safety endpoint requires its own dedicated token and returns explicit refusal', async () => {
  const safety = jest.fn().mockResolvedValue({ safe: true, checkedAt: Date.now() }), controller = new ServiceControlController({} as any, 'admin-secret', safety, guard)
  const app = express(); app.get('/internal/service-control/safety', controller.guard.bind(controller))
  expect((await request(app).get('/internal/service-control/safety').set('Authorization', 'Bearer admin-secret')).status).toBe(403)
  expect(safety).not.toHaveBeenCalled()
  expect((await request(app).get('/internal/service-control/safety').set('Authorization', `Bearer ${guard}`)).body.safe).toBe(true)
  safety.mockRejectedValueOnce(new ServiceControlError(423, 'control_calls_active'))
  expect((await request(app).get('/internal/service-control/safety').set('Authorization', `Bearer ${guard}`)).body).toEqual({ error: 'control_calls_active' })
})
test('agent HTTP has no unauthenticated, delete, shell or query-string-token capability', async () => {
  const agent = { overview: jest.fn().mockResolvedValue({ targets: [] }), submit: jest.fn().mockResolvedValue({ state: 'accepted' }), operation: jest.fn().mockResolvedValue({ state: 'running' }) }
  const app = serviceControlServer(agent as any, secret)
  expect((await request(app).get(`/v1/targets?token=${secret}`)).status).toBe(403)
  expect(agent.overview).not.toHaveBeenCalled()
  expect((await request(app).get('/v1/targets').set('Authorization', `Bearer ${secret}`)).status).toBe(200)
  expect((await request(app).delete(`/v1/targets/${component}`).set('Authorization', `Bearer ${secret}`)).status).toBe(404)
  expect((await request(app).post('/v1/shell').set('Authorization', `Bearer ${secret}`).send({ command: 'reboot' })).status).toBe(404)
  const body = { operationId: randomUUID(), confirm: component, confirmation: 'proof' }
  expect((await request(app).post(`/v1/targets/${component}/restart`).set('Authorization', `Bearer ${secret}`).send(body)).status).toBe(202)
  agent.submit.mockRejectedValueOnce(new ServiceControlError(409, 'control_busy'))
  expect((await request(app).post(`/v1/targets/${component}/restart`).set('Authorization', `Bearer ${secret}`).send(body)).body).toEqual({ error: 'control_busy' })
})
