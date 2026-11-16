import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'
import { voipBackupRouter } from '../../src/controllers/voip_backup_controller'
test('VoIP S3 management is administrator-login-only, confirmed and bounded, with scoped file downloads', async () => {
  const identity: any = { authenticate: jest.fn(async () => ({ role: 'admin', kind: 'login' })) }
  const backend: any = { status: jest.fn(async () => ({ enabled: true })), backup: jest.fn(async () => ({ status: 'ready' })), restore: jest.fn(async () => ({ restored: true })), download: jest.fn(async () => ({ manifest: { id: 'synthetic', bytes: 4 }, stream: Readable.from(['data']) })) }
  const app = express().use('/manager/voip-backups', voipBackupRouter(backend, identity)), url = '/manager/voip-backups'
  const auth = (r: any) => r.auth('synthetic', { type: 'bearer' })
  expect((await request(app).get(url)).status).toBe(401)
  expect((await auth(request(app).get(url))).status).toBe(200)
  expect((await auth(request(app).post(url)).send({ confirm: false })).status).toBe(400)
  expect((await auth(request(app).post(url)).send({ confirm: true })).status).toBe(200)
  identity.authenticate.mockResolvedValueOnce({ role: 'admin', kind: 'api' })
  expect((await auth(request(app).post(url)).send({ confirm: true })).status).toBe(403)
  identity.authenticate.mockResolvedValueOnce({ role: 'user', kind: 'login' })
  expect((await auth(request(app).get(url + '/id/download'))).status).toBe(403)
  const download = await auth(request(app).get(url + '/id/download')); expect(download.status).toBe(200); expect(download.headers['cache-control']).toBe('no-store')
  expect((await auth(request(app).post(url + '/restore')).send({ backupId: 'id', confirm: true })).status).toBe(200)
  expect((await auth(request(app).post(url + '/restore-upload?confirm=true')).set('Content-Type', 'application/octet-stream').send(Buffer.from('test'))).status).toBe(200)
  backend.status.mockRejectedValueOnce(new Error('/private/credentials'))
  expect((await auth(request(app).get(url))).body).toEqual({ error: 'voip_backup_unavailable' })
})
