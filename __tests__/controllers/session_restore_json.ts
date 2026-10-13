import express from 'express'
import request from 'supertest'
import { defaultRequestJson } from '../../src/services/request_json'
import { sessionTransferRouter } from '../../src/controllers/session_transfer_controller'
import { Readable } from 'node:stream'

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

test('stream restore authenticates first, rejects wrong content type and forwards a bounded stream', async () => {
  const restoreStream = jest.fn(async source => { let bytes = 0; for await (const chunk of source) bytes += chunk.length; return { bytes } })
  const app = express().use(defaultRequestJson()).use('/manager/session-transfers', sessionTransferRouter({ authenticate: async () => ({ role: 'admin', kind: 'login' }) } as any, async () => ({ restoreStream }) as any))
  const path = '/manager/session-transfers/restore-stream'
  expect((await request(app).post(path).set('Content-Type', 'application/octet-stream').send(Buffer.from('not-read'))).status).toBe(401)
  expect(restoreStream).not.toHaveBeenCalled()
  expect((await request(app).post(path).set('Authorization', 'Bearer test').send({})).status).toBe(415)
  const result = await request(app).post(path).set('Authorization', 'Bearer test').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(200000))
  expect(result.status).toBe(201); expect(result.body.bytes).toBe(200000)
})

test('download binary route is admin authenticated and does not expose archive object keys', async () => {
  const downloadStream = jest.fn(async () => ({ stream: Readable.from(['encrypted-stream']), fileName: 'test.vipersession' }))
  const app = express().use('/manager/session-transfers', sessionTransferRouter({ authenticate: async () => ({ role: 'admin', kind: 'login' }) } as any, async () => ({ downloadStream }) as any))
  const path = '/manager/session-transfers/999123456789/backup-tasks/task/download/file'
  expect((await request(app).get(path)).status).toBe(401)
  const result = await request(app).get(path).set('Authorization', 'Bearer test')
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store')
  expect(result.headers['content-disposition']).toContain('test.vipersession')
})

test('multipart routes authenticate before bodies and isolate tasks by administrator identity', async () => {
  const multipart = { start: jest.fn(async () => ({ id: 'upload' })), status: jest.fn(async () => ({ state: 'restoring' })),
    complete: jest.fn(async () => ({ state: 'restoring' })), cancel: jest.fn(async () => ({ cancelled: true })),
    part: jest.fn(async (_owner, _id, _index, _sha, source) => { let bytes = 0; for await (const chunk of source) bytes += chunk.length; return { bytes } }) }
  const identity: any = { authenticate: jest.fn(async () => ({ id: 'admin-id', role: 'admin', kind: 'login' })) }
  const app = express().use(defaultRequestJson()).use('/manager/session-transfers', sessionTransferRouter(identity, async () => ({ multipart }) as any))
  const base = '/manager/session-transfers/restore-uploads'
  expect((await request(app).post(base).send({ size: 500 })).status).toBe(401)
  expect((await request(app).post(base).set('Authorization', 'Bearer test').send({ size: 500 })).status).toBe(201)
  expect(multipart.start).toHaveBeenCalledWith('admin-id', { size: 500 })
  expect((await request(app).put(base + '/upload/parts/0').set('Authorization', 'Bearer test').set('Content-Type', 'application/octet-stream').set('X-Part-SHA256', 'digest').send(Buffer.alloc(200000))).body.bytes).toBe(200000)
  expect(multipart.part).toHaveBeenCalledWith('admin-id', 'upload', 0, 'digest', expect.anything())
  expect((await request(app).put(base + '/upload/parts/bad').set('Authorization', 'Bearer test').set('Content-Type', 'application/octet-stream').send(Buffer.from('x'))).status).toBe(400)
  expect((await request(app).put(base + '/upload/parts/0').set('Authorization', 'Bearer test').send({})).status).toBe(415)
  expect((await request(app).post(base + '/upload/complete').set('Authorization', 'Bearer test').send({ password: 'synthetic-password', confirmOriginOffline: true })).status).toBe(202)
  expect((await request(app).get(base + '/upload').set('Authorization', 'Bearer test')).status).toBe(200)
  expect((await request(app).delete(base + '/upload').set('Authorization', 'Bearer test')).status).toBe(200)
  identity.authenticate.mockResolvedValueOnce({ id: 'user', role: 'user', kind: 'login' })
  expect((await request(app).put(base + '/upload/parts/0').set('Authorization', 'Bearer test').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(10))).status).toBe(403)
})
