import express from 'express'
import request from 'supertest'
import { SessionWebhooksController } from '../../src/controllers/session_webhooks_controller'
import { SessionWebhookStore, sessionEvent } from '../../src/services/session_webhook_store'
import { validateSessionDestination } from '../../src/services/session_webhook_contract'

const input = () => ({ name: 'ViperChat', url: 'https://chat.example.com/events', server: 'server_1', enabled: true,
  session_ids: ['5511999999999'], auto_include_new_sessions: false, events: ['session.connected'], signing_secret: 's'.repeat(32) })

const setup = () => {
  const store = { destinations: jest.fn().mockResolvedValue([]), states: jest.fn().mockResolvedValue([]), save: jest.fn(), removeDestination: jest.fn() }
  const config = jest.fn().mockResolvedValue({ server: 'server_1', provider: 'zapo' })
  const controller = new SessionWebhooksController(store as unknown as SessionWebhookStore, config, 'global-token')
  const app = express().use(express.json())
  app.get('/admin/session-webhooks/states', controller.handle.bind(controller))
  app.all('/admin/session-webhooks/:id?', controller.handle.bind(controller))
  return { app, store, config }
}

describe('central session webhook routes', () => {
  test.each([undefined, ''])('creates unsigned destination with secret %j', signing_secret => {
    const { app, store } = setup()
    return request(app).post('/admin/session-webhooks').set('Authorization', 'Bearer global-token')
      .send({ ...input(), signing_secret }).then(result => {
        expect(result.status).toBe(201)
        expect(result.body.has_signing_secret).toBe(false)
        expect(result.body.signing_secret).toBeUndefined()
        expect(store.save.mock.calls[0][0].signing_secret).toBe('')
      })
  })
  test('explicit empty secret removes HMAC on PUT', async () => {
    const { app, store } = setup()
    const previous = validateSessionDestination(input())
    store.destinations.mockResolvedValue([previous])
    const result = await request(app).put(`/admin/session-webhooks/${previous.id}`)
      .set('Authorization', 'Bearer global-token').send({ ...input(), signing_secret: '' })
    expect(result.status).toBe(200)
    expect(result.body.has_signing_secret).toBe(false)
    expect(store.save.mock.calls[0][0].signing_secret).toBe('')
  })
  test.each(['', 'session-token'])('rejects non-global token %s before storage', async token => {
    const { app, store } = setup()
    expect((await request(app).get('/admin/session-webhooks').set('Authorization', `Bearer ${token}`)).status).toBe(403)
    expect(store.destinations).not.toHaveBeenCalled()
  })
  test('creates and lists redacted configuration with the selected sessions', async () => {
    const { app, store } = setup()
    const created = await request(app).post('/admin/session-webhooks').set('Authorization', 'Bearer global-token').send(input())
    expect(created.status).toBe(201)
    expect(created.body.has_signing_secret).toBe(true)
    expect(created.body.signing_secret).toBeUndefined()
    store.destinations.mockResolvedValue([store.save.mock.calls[0][0]])
    const listed = await request(app).get('/admin/session-webhooks').set('Authorization', 'Bearer global-token')
    expect(listed.body.destinations).toEqual([created.body])
  })
  test.each([null, { server: 'server_2', provider: 'zapo' }, { server: 'server_1', provider: 'baileys' }, { server: 'server_1' }])('rejects missing/wrong-scope sessions %j', async session => {
    const { app, store, config } = setup()
    config.mockResolvedValue(session)
    const result = await request(app).post('/admin/session-webhooks').set('Authorization', 'Bearer global-token').send(input())
    expect(result.status).toBe(400)
    expect(store.save).not.toHaveBeenCalled()
  })
  test('updates preserve secrets, explicit membership survives disabling auto-enrollment', async () => {
    const { app, store } = setup()
    const previous = validateSessionDestination({ ...input(), auto_include_new_sessions: true })
    store.destinations.mockResolvedValue([previous])
    const body = { ...input(), signing_secret: undefined }
    const result = await request(app).put(`/admin/session-webhooks/${previous.id}`).set('Authorization', 'Bearer global-token').send(body)
    expect(result.status).toBe(200)
    expect(result.body.auto_include_new_sessions).toBe(false)
    expect(result.body.session_ids).toEqual(previous.session_ids)
    expect(store.save.mock.calls[0][0].signing_secret).toBe(previous.signing_secret)
  })
  test('delete only removes destination; missing destinations return 404', async () => {
    const { app, store, config } = setup()
    const previous = validateSessionDestination(input())
    store.destinations.mockResolvedValue([previous])
    expect((await request(app).delete(`/admin/session-webhooks/${previous.id}`).set('Authorization', 'Bearer global-token')).status).toBe(204)
    expect(config).not.toHaveBeenCalled()
    expect(store.removeDestination).toHaveBeenCalledWith(previous.id)
    expect((await request(app).put('/admin/session-webhooks/missing').set('Authorization', 'Bearer global-token').send(input())).status).toBe(404)
  })
  test('state queries filter by current membership; unknown filter returns 404', async () => {
    const { app, store } = setup()
    const destination = validateSessionDestination(input())
    store.destinations.mockResolvedValue([destination])
    store.states.mockResolvedValue([sessionEvent('5511999999999', 'connected'), sessionEvent('5511888888888', 'removed')])
    const filtered = await request(app).get(`/admin/session-webhooks/states?destination_id=${destination.id}`).set('Authorization', 'Bearer global-token')
    expect(filtered.body.states).toHaveLength(1)
    expect((await request(app).get('/admin/session-webhooks/states').set('Authorization', 'Bearer global-token')).body.states).toHaveLength(2)
    expect((await request(app).get('/admin/session-webhooks/states?destination_id=unknown').set('Authorization', 'Bearer global-token')).status).toBe(404)
  })
  test('storage failures expose no internals; invalid payload returns 400', async () => {
    const { app, store } = setup()
    expect((await request(app).post('/admin/session-webhooks').set('Authorization', 'Bearer global-token').send({})).status).toBe(400)
    store.destinations.mockRejectedValue(new Error('secret'))
    const result = await request(app).get('/admin/session-webhooks').set('Authorization', 'Bearer global-token')
    expect(result.status).toBe(503)
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })
})
