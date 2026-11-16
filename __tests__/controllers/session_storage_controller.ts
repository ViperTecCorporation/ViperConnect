import express from 'express'
import request from 'supertest'
import { sessionStorageRouter } from '../../src/controllers/session_storage_controller'
import { SessionStorageError } from '../../src/services/session_storage/types'

const phone = '999123456789'
test('storage routes require login admin, never API credentials, and validate confirm/offline restore', async () => {
  const identity: any = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login' })) }
  const gateway = { status: jest.fn(async () => ({ backend: 'redis' })), migrate: jest.fn(async () => ({ id: 'task' })), task: jest.fn(async () => ({ status: 'ready' })), backup: jest.fn(async () => ({ id: 'backup' })), restore: jest.fn(async () => ({ autoConnect: false })) }
  const app = express().use('/manager', sessionStorageRouter(gateway, identity))
  const auth = (r: any) => r.set('Authorization', 'Bearer synthetic')
  expect((await request(app).get(`/manager/${phone}/storage`)).status).toBe(401)
  expect((await auth(request(app).get(`/manager/${phone}/storage`))).status).toBe(200)
  expect((await auth(request(app).post(`/manager/${phone}/storage/migrations`)).send({ target: 'sqlite', confirm: true })).status).toBe(202)
  expect((await auth(request(app).post(`/manager/${phone}/storage/migrations`)).send({ target: 'sqlite', confirm: false })).status).toBe(400)
  expect((await auth(request(app).get(`/manager/${phone}/storage/tasks/task`))).status).toBe(200)
  expect((await auth(request(app).post(`/manager/${phone}/storage/backups`)).send({ confirm: true })).status).toBe(202)
  expect((await auth(request(app).post(`/manager/${phone}/storage/backups`)).send({ confirm: true, path: '/private' })).status).toBe(400)
  expect((await auth(request(app).post(`/manager/${phone}/storage/restores`)).send({ confirm: true, mode: 'online', backupId: 'id' })).status).toBe(400)
  expect((await auth(request(app).post(`/manager/${phone}/storage/restores`)).send({ confirm: true, mode: 'offline', backupId: 'id' })).status).toBe(202)
  identity.authenticate.mockResolvedValueOnce({ role: 'admin', kind: 'api' })
  expect((await auth(request(app).get(`/manager/${phone}/storage`))).status).toBe(403)
  gateway.status.mockRejectedValueOnce(new SessionStorageError(409, 'session_storage_wrong_owner'))
  expect((await auth(request(app).get(`/manager/${phone}/storage`))).body.error).toBe('session_storage_wrong_owner')
  gateway.status.mockRejectedValueOnce(new Error('/private/password'))
  expect((await auth(request(app).get(`/manager/${phone}/storage`))).body).toEqual({ error: 'session_storage_unavailable' })
})

test('backup upload streams raw bytes only after login admin and explicit offline confirmation', async () => {
  const identity: any = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login' })) }
  const received: Buffer[] = [], gateway: any = { restoreUpload: jest.fn(async (_phone: string, stream: AsyncIterable<Buffer>, bytes: number) => {
    expect(bytes).toBe(4); for await (const chunk of stream) received.push(chunk)
    return { id: 'synthetic-task', phone, operation: 'restore', status: 'running' }
  }) }
  const app = express().use('/manager', sessionStorageRouter(gateway, identity)), path = `/manager/${phone}/storage/restore-upload?confirm=true&mode=offline`
  const upload = (target = path) => request(app).post(target).set('Authorization', 'Bearer synthetic').set('Content-Type', 'application/octet-stream').send(Buffer.from([0, 1, 254, 255]))
  expect((await upload()).status).toBe(202); expect(Buffer.concat(received)).toEqual(Buffer.from([0, 1, 254, 255]))
  expect(gateway.restoreUpload).toHaveBeenCalledTimes(1)
  expect((await upload(path.replace('mode=offline', 'mode=online'))).status).toBe(400)
  expect((await upload(path + '&path=/private')).status).toBe(400)
  identity.authenticate.mockResolvedValueOnce({ role: 'admin', kind: 'api' })
  expect((await upload()).status).toBe(403); expect(gateway.restoreUpload).toHaveBeenCalledTimes(1)
  expect((await request(app).post(path).set('Content-Type', 'application/octet-stream').send(Buffer.from('test'))).status).toBe(401)
  gateway.restoreUpload.mockRejectedValueOnce(new SessionStorageError(409, 'session_storage_restore_requires_offline'))
  expect((await upload()).body.error).toBe('session_storage_restore_requires_offline')
})

test('SQLite explorer GET/POST require login administrator, validate inputs and never expose SQL errors', async () => {
  const identity: any = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login' })) }
  const gateway: any = { explore: jest.fn(async () => ({ tables: [], rows: [] })), mutate: jest.fn(async () => ({ changed: true })) }
  const app = express().use('/v15.0', sessionStorageRouter(gateway, identity)), path = `/v15.0/${phone}/storage/explorer`
  const body = { action: 'create', table: 'uno_kv', generation: 1, confirm: true, values: { key: `unoapi-id:${phone}:id`, value: { utf8: 'uno' } } }
  expect((await request(app).get(path)).status).toBe(401)
  expect((await request(app).get(path).auth('synthetic', { type: 'bearer' })).status).toBe(200)
  expect((await request(app).post(path).auth('synthetic', { type: 'bearer' }).send(body)).status).toBe(200)
  expect(gateway.mutate).toHaveBeenCalledWith(phone, body)
  expect((await request(app).get(path + '?sql=DELETE').auth('synthetic', { type: 'bearer' })).status).toBe(400)
  expect((await request(app).post(path).auth('synthetic', { type: 'bearer' }).send({ ...body, confirm: false })).status).toBe(400)
  identity.authenticate.mockResolvedValueOnce({ role: 'admin', kind: 'api' })
  expect((await request(app).post(path).auth('synthetic', { type: 'bearer' }).send(body)).status).toBe(403)
  identity.authenticate.mockResolvedValueOnce({ role: 'user', kind: 'login' })
  expect((await request(app).get(path).auth('synthetic', { type: 'bearer' })).status).toBe(403)
  gateway.explore.mockRejectedValueOnce(new Error('SQL private-path password'))
  expect((await request(app).get(path).auth('synthetic', { type: 'bearer' })).body).toEqual({ error: 'session_storage_unavailable' })
  expect(gateway.mutate).toHaveBeenCalledTimes(1)
})
