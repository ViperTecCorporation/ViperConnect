import express from 'express'
import request from 'supertest'
import { defaultRequestJson } from '../../src/services/request_json'
import { sessionTransferRouter } from '../../src/controllers/session_transfer_controller'

const setup = () => {
  const restore = jest.fn(async () => ({ restored: true }))
  const identity = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login' })) }
  const app = express().use(defaultRequestJson())
  app.use('/manager/session-transfers', sessionTransferRouter(identity as any, async () => ({ restore }) as any))
  app.post('/ordinary', (_req, res) => res.sendStatus(200))
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.type }))
  return { app, restore, identity }
}

test.each(['/manager/session-transfers/restore', '/manager/session-transfers/restore/'])('authenticated restore accepts JSON above the default 100 KB at %s', async path => {
  const { app, restore } = setup()
  const body = { archive: 'x'.repeat(200 * 1024), password: 'synthetic-password', confirmOriginOffline: true }
  expect((await request(app).post(path).set('Authorization', 'Bearer test').send(body)).status).toBe(201)
  expect(restore).toHaveBeenCalledWith(body)
})

test('large restore authenticates before parsing and keeps the route size limit', async () => {
  const { app, restore, identity } = setup()
  const path = '/manager/session-transfers/restore'
  expect((await request(app).post(path).send({ archive: 'x'.repeat(200 * 1024) })).status).toBe(401)
  identity.authenticate.mockResolvedValueOnce({ role: 'user', kind: 'login' })
  expect((await request(app).post(path).set('Authorization', 'Bearer test').send({ archive: 'x'.repeat(200 * 1024) })).status).toBe(403)
  expect((await request(app).post(path).set('Authorization', 'Bearer test').send({ archive: 'x'.repeat(17 * 1024 * 1024) })).status).toBe(413)
  expect(restore).not.toHaveBeenCalled()
})

test('ordinary endpoints retain the default JSON limit', async () => {
  expect((await request(setup().app).post('/ordinary').send({ data: 'x'.repeat(200 * 1024) })).status).toBe(413)
})

test.each(['/manager/mobile-devices/restore', '/123456789/profile/picture', '/123456789/profile/cover'])('existing deferred parser is preserved at %s', async path => {
  const app = express().use(defaultRequestJson()).post(path, express.json({ limit: '1mb' }), (_req, res) => res.sendStatus(200))
  expect((await request(app).post(path).send({ data: 'x'.repeat(200 * 1024) })).status).toBe(200)
})
