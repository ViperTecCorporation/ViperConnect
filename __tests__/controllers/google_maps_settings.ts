import express from 'express'
import request from 'supertest'
import { GoogleMapsSettingsController } from '../../src/controllers/google_maps_settings_controller'
import { GoogleMapsSettings } from '../../src/services/google_maps_settings'

test('admin-only configuration never echoes key; rejects invalid bodies and sanitizes errors', async () => {
  const store = { status: jest.fn().mockResolvedValue({ configured: true }), browserConfig: jest.fn().mockResolvedValue({ apiKey: 'browser-restricted-key' }), save: jest.fn(), remove: jest.fn() }
  const controller = new GoogleMapsSettingsController(store as any, 'admin-secret')
  const app = express(); app.use(express.json()); app.all('/maps', controller.handle.bind(controller))
  app.get('/maps/browser', controller.handle.bind(controller))
  await request(app).get('/maps/browser').expect(403)
  expect(store.browserConfig).not.toHaveBeenCalled()
  const browser = await request(app).get('/maps/browser').set('Authorization', 'Bearer admin-secret').expect(200)
  expect(browser.body.apiKey).toBe('browser-restricted-key')
  expect(browser.headers['cache-control']).toBe('no-store')
  await request(app).get('/maps').expect(403)
  await request(app).put('/maps').send({ apiKey: 'a'.repeat(39) }).expect(403)
  expect(store.save).not.toHaveBeenCalled()
  const key = 'test-key-' + 'a'.repeat(30)
  const result = await request(app).put('/maps').set('Authorization', 'Bearer admin-secret').send({ apiKey: key }).expect(200)
  expect(store.save).toHaveBeenCalledWith(key)
  expect(result.body).toEqual({ configured: true })
  expect(result.headers['cache-control']).toBe('no-store')
  await request(app).get('/maps').set('Authorization', 'Bearer admin-secret').expect(200, { configured: true })
  await request(app).put('/maps').set('Authorization', 'Bearer admin-secret').send({ apiKey: '' }).expect(400)
  await request(app).put('/maps').set('Authorization', 'Bearer admin-secret').send({ apiKey: key, extra: true }).expect(400)
  await request(app).delete('/maps').set('Authorization', 'Bearer admin-secret').expect(200, { configured: false })
  expect(store.remove).toHaveBeenCalledTimes(1)
  store.status.mockRejectedValue(new Error(key))
  await request(app).get('/maps').set('Authorization', 'Bearer admin-secret').expect(503, { error: 'google_maps_settings_unavailable' })
})

test('Redis stores configuration without TTL and removal clears it', async () => {
  let value: string | undefined
  const redis = { get: jest.fn(async () => value), set: jest.fn(async (_k, v) => { value = v }), del: jest.fn(async () => { value = undefined }) }
  const store = new GoogleMapsSettings(async () => redis as any)
  expect(await store.status()).toEqual({ configured: false })
  await store.save('sample-key')
  expect(await store.browserConfig()).toEqual({ apiKey: 'sample-key' })
  expect(redis.set).toHaveBeenCalledWith('unoapi-settings:google-maps:browser-key', 'sample-key')
  expect(await store.status()).toEqual({ configured: true })
  await store.remove(); expect(await store.status()).toEqual({ configured: false })
})
