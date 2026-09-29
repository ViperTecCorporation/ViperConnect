import express from 'express'
import request from 'supertest'
import { OwnProfileController } from '../../src/controllers/own_profile_controller'
import { managerRequestScope, managerAccess } from '../../src/services/manager_access'
jest.mock('../../src/services/own_privacy_cache', () => ({ OwnPrivacyCache: jest.fn().mockImplementation(() => ({
  read: (_phone: string, fetch: () => Promise<any>) => fetch(), invalidate: jest.fn(),
})) }))
jest.mock('../../src/services/own_profile_cache', () => ({ OwnProfileCache: jest.fn().mockImplementation(() => ({
  read: (_phone: string, _refresh: boolean, fetch: () => Promise<any>) => fetch(), invalidate: jest.fn(),
})) }))

test('HTTP profile read, edit, delete; validation precedes RPC and provider errors are sanitized', async () => {
  const incoming = { ownProfile: jest.fn().mockResolvedValue({ success: true }) }
  const controller = new OwnProfileController(incoming as any)
  const app = express(); app.use(express.json())
  app.get('/:phone/profile', controller.handle.bind(controller))
  app.put('/:phone/profile/:field', controller.handle.bind(controller))
  app.delete('/:phone/profile/:field', controller.handle.bind(controller))
  await request(app).get('/5511999999999/profile').expect(200)
  expect(incoming.ownProfile).toHaveBeenLastCalledWith('5511999999999', { action: 'get' })
  await request(app).put('/5511999999999/profile/name').send({ value: 'João' }).expect(200)
  expect(incoming.ownProfile).toHaveBeenLastCalledWith('5511999999999', { action: 'set', field: 'name', value: 'João' })
  await request(app).delete('/5511999999999/profile/picture').expect(200)
  incoming.ownProfile.mockClear()
  await request(app).put('/5511999999999/profile/name').send({ value: 'x', targetJid: 'someone' }).expect(400)
  await request(app).put('/5511999999999/profile/not-real').send({ value: '' }).expect(400)
  expect(incoming.ownProfile).not.toHaveBeenCalled()
  incoming.ownProfile.mockRejectedValue(new Error('409: profile_username_rejected'))
  await request(app).put('/5511999999999/profile/username').send({ value: 'joao' }).expect(409)
  incoming.ownProfile.mockRejectedValue(new Error('secret credentials'))
  const res = await request(app).get('/5511999999999/profile').expect(502)
  expect(res.body.error).toBe('profile_provider_request_failed')
})
test('manager profile routes are scoped to phone, never global', () => {
  expect(managerRequestScope('/5511999999999/profile/privacy')).toBe('5511999999999')
  expect(managerRequestScope('/5511999999999/profile/account_email')).toBe('5511999999999')
  expect(managerRequestScope('/5511999999999/profile')).toBe('5511999999999')
  expect(managerRequestScope('/5511999999999/profile/business')).toBe('5511999999999')
  expect(managerRequestScope('/profile/business')).toBeUndefined()
})

test('account email bypasses snapshot and cover, validates before RPC and returns no-store', async () => {
  const incoming = { ownProfile: jest.fn().mockResolvedValue({ email: null, verified: false, confirmed: false }) }
  const cache = { read: jest.fn(), invalidate: jest.fn() }
  const cover = jest.fn()
  const controller = new OwnProfileController(incoming as any, cache as any, cover)
  const app = express(); app.use(express.json())
  app.get('/:phone/profile/:field', controller.handle.bind(controller))
  app.put('/:phone/profile/:field', controller.handle.bind(controller))
  const response = await request(app).get('/5511999999999/profile/account_email').expect(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(incoming.ownProfile).toHaveBeenLastCalledWith('5511999999999', { action: 'get', field: 'account_email' })
  incoming.ownProfile.mockResolvedValueOnce({ success: true } as any)
  await request(app).put('/5511999999999/profile/account_email').send({ value: { operation: 'request_code' } }).expect(200)
  expect(cache.read).not.toHaveBeenCalled()
  expect(cache.invalidate).not.toHaveBeenCalled()
  expect(cover).not.toHaveBeenCalled()
  incoming.ownProfile.mockClear()
  await request(app).put('/5511999999999/profile/account_email').send({ value: { operation: 'verify', code: '123' } }).expect(400)
  await request(app).get('/5511999999999/profile/picture').expect(400)
  expect(incoming.ownProfile).not.toHaveBeenCalled()
  incoming.ownProfile.mockRejectedValue(new Error('429: profile_email_too_many_retries'))
  const failed = await request(app).put('/5511999999999/profile/account_email').send({ value: { operation: 'request_code' } }).expect(429)
  expect(failed.body).toEqual({ error: 'profile_email_too_many_retries' })
})

test('privacy read and write bypass public cache and reject unknown operations before RPC', async () => {
  const incoming = { ownProfile: jest.fn().mockResolvedValue({ success: true }) }
  const cache = { read: jest.fn(), invalidate: jest.fn() }
  const controller = new OwnProfileController(incoming as any, cache as any)
  const app = express(); app.use(express.json())
  app.get('/:phone/profile/:field', controller.handle.bind(controller))
  app.put('/:phone/profile/:field', controller.handle.bind(controller))
  const result = await request(app).get('/5511999999999/profile/privacy').expect(200)
  expect(result.headers['cache-control']).toBe('no-store')
  expect(incoming.ownProfile).toHaveBeenLastCalledWith('5511999999999', { action: 'get', field: 'privacy' })
  await request(app).put('/5511999999999/profile/privacy').send({ value: { operation: 'timer', duration: 0 } }).expect(200)
  expect(cache.read).not.toHaveBeenCalled(); expect(cache.invalidate).not.toHaveBeenCalled()
  incoming.ownProfile.mockClear()
  await request(app).put('/5511999999999/profile/privacy').send({ value: { operation: 'unknown' } }).expect(400)
  expect(incoming.ownProfile).not.toHaveBeenCalled()
})

test('local cover preview is added after snapshot lookup and preview failure preserves profile', async () => {
  const incoming = { ownProfile: jest.fn() }
  const cache = { read: jest.fn(async () => ({ name: 'João', warnings: [] })), invalidate: jest.fn() }
  const preview = jest.fn().mockResolvedValue({ id: 'cover1', url: 'https://s3.example/signed', source: 'uno_upload' })
  const cover = jest.fn().mockResolvedValue({ preview })
  const controller = new OwnProfileController(incoming as any, cache as any, cover)
  const app = express(); app.get('/:phone/profile', controller.handle.bind(controller))
  const result = await request(app).get('/5511999999999/profile').expect(200)
  expect(result.body.cover.id).toBe('cover1')
  expect(cover).toHaveBeenCalledWith('5511999999999')
  expect(incoming.ownProfile).not.toHaveBeenCalled()
  preview.mockRejectedValueOnce(new Error('private storage details'))
  const failed = await request(app).get('/5511999999999/profile').expect(200)
  expect(failed.body).toMatchObject({ name: 'João', cover: null, warnings: ['cover_preview'] })
  expect(JSON.stringify(failed.body)).not.toContain('private storage details')
})
test('manager denies another session before profile RPC', async () => {
  const incoming = { ownProfile: jest.fn().mockResolvedValue({ name: 'Own' }) }
  const app = express(); app.use(express.json())
  app.use(managerAccess({ authenticate: jest.fn().mockResolvedValue({ role: 'user', phones: ['5511999999999'] }) } as any, async phone => phone))
  const controller = new OwnProfileController(incoming as any)
  app.get('/:phone/profile', controller.handle.bind(controller))
  app.put('/:phone/profile/:field', controller.handle.bind(controller))
  await request(app).get('/5511888888888/profile').set('Authorization', 'Bearer mgr_test').expect(403)
  await request(app).put('/5511888888888/profile/account_email').set('Authorization', 'Bearer mgr_test').send({ value: { operation: 'confirm' } }).expect(403)
  await request(app).put('/5511888888888/profile/privacy').set('Authorization', 'Bearer mgr_test').send({ value: { operation: 'timer', duration: 0 } }).expect(403)
  await request(app).put('/5511888888888/profile/name').set('Authorization', 'Bearer mgr_test').send({ value: 'bad' }).expect(403)
  expect(incoming.ownProfile).not.toHaveBeenCalled()
  await request(app).get('/5511999999999/profile').set('Authorization', 'Bearer mgr_test').expect(200)
})
