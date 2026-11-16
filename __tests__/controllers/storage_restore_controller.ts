import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'
import { storageRestoreRouter } from '../../src/controllers/storage_restore_controller'
import { SessionStorageError } from '../../src/services/session_storage/types'

const phone = '999123456789', id = '12345678-1234-4234-8234-123456789abc'
function fixture() {
  const identity: any = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login' })) }
  const bytes = Buffer.from([0, 1, 254, 255]), received: Buffer[] = []
  const gateway = { workers: jest.fn(async () => ({ workers: [{ owner: 'destination', available: true }] })),
    upload: jest.fn(async (_phone: string, _owner: string, source: Readable, length: number) => { expect(length).toBe(4); for await (const chunk of source) received.push(chunk); return { id, phone, owner: 'destination', operation: 'restore', status: 'running' } }),
    task: jest.fn(async () => ({ id, phone, status: 'ready', result: { autoConnect: false, status: 'offline', connected: false, replayed: false } })),
    backups: jest.fn(async () => ({ latest: { id }, slots: [] })), download: jest.fn(async () => ({ stream: Readable.from([bytes]), fileName: `sessao-${phone}-${id}.viperstorage` })) }
  const app = express().use('/manager/storage', storageRestoreRouter(gateway, identity))
  const path = `/manager/storage/restore-upload?phone=${phone}&owner=destination&confirmOriginOffline=true&mode=offline`
  const upload = (target = path) => request(app).post(target).set('Authorization', 'Bearer synthetic').set('Content-Type', 'application/octet-stream').send(bytes)
  return { app, identity, gateway, upload, path, bytes, received }
}
test('global restore uploads absent-session raw bytes with admin login only and explicit origin-offline confirmation', async () => {
  const f = fixture()
  const reply = await f.upload()
  expect(reply.status).toBe(202); expect(reply.body).toMatchObject({ id, phone, operation: 'restore', status: 'running' }); expect(Buffer.concat(f.received)).toEqual(f.bytes)
  expect(f.gateway.upload).toHaveBeenCalledWith(phone, 'destination', expect.anything(), 4)
  expect((await f.upload(f.path.replace('confirmOriginOffline=true', 'confirmOriginOffline=false'))).status).toBe(400)
  expect((await f.upload(f.path + '&path=/private')).status).toBe(400)
  expect((await request(f.app).post(f.path).set('Authorization', 'Bearer synthetic').send({ password: 'never' })).status).toBe(400)
  expect(f.gateway.upload).toHaveBeenCalledTimes(1)
})
test.each([{ role: 'admin', kind: 'api' }, { role: 'user', kind: 'login' }, undefined])('download and upload refuse non-login admin principal %j', async principal => {
  const f = fixture(); f.identity.authenticate.mockResolvedValue(principal)
  const response = await request(f.app).get(`/manager/storage/${phone}/backups/latest/download`).set('Authorization', 'Bearer synthetic')
  expect(response.status).toBe(principal ? 403 : 401); expect(f.gateway.download).not.toHaveBeenCalled()
  expect((await f.upload()).status).toBe(principal ? 403 : 401); expect(f.gateway.upload).not.toHaveBeenCalled()
})
test('task polling works before a session config exists and verified downloads stream privately without signed URLs', async () => {
  const f = fixture(), auth = (query: any) => query.set('Authorization', 'Bearer synthetic')
  expect((await auth(request(f.app).get('/manager/storage/workers'))).body.workers).toHaveLength(1)
  expect((await auth(request(f.app).get(`/manager/storage/restores/${phone}/${id}`))).body.result).toMatchObject({ autoConnect: false, status: 'offline' })
  expect((await auth(request(f.app).get(`/manager/storage/${phone}/backups`))).body.latest).toEqual({ id })
  const response = await auth(request(f.app).get(`/manager/storage/${phone}/backups/latest/download`))
  expect(response.status).toBe(200); expect(response.body).toEqual(f.bytes)
  expect(response.headers['content-disposition']).toContain('.viperstorage'); expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['x-content-type-options']).toBe('nosniff')
})
test('errors preserve explicit conflict codes and never expose raw credentials or local paths', async () => {
  const f = fixture()
  f.gateway.upload.mockRejectedValueOnce(new SessionStorageError(409, 'session_storage_standalone_destination_exists'))
  expect((await f.upload()).body).toEqual({ error: 'session_storage_standalone_destination_exists' })
  f.gateway.upload.mockRejectedValueOnce(new Error('/private/secret credentials'))
  expect((await f.upload()).body).toEqual({ error: 'session_storage_unavailable' })
})
