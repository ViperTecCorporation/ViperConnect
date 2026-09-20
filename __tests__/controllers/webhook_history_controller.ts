import express from 'express'
import request from 'supertest'
import { WebhookHistoryController } from '../../src/controllers/webhook_history_controller'
import { WebhookHistory, WebhookHistoryError } from '../../src/services/webhook_history'
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), publishConfigUpdate: jest.fn() }))
const setup = () => {
  const history = { entries: jest.fn().mockResolvedValue([]), restore: jest.fn().mockResolvedValue(undefined) }
  const controller = new WebhookHistoryController(history as unknown as WebhookHistory, 'admin')
  const app = express().use(express.json())
  app.get('/admin/webhooks/history/:phone', controller.handle.bind(controller))
  app.post('/admin/webhooks/history/:phone/restore', controller.handle.bind(controller))
  return { app, history }
}
const url = '/admin/webhooks/history/5511999999'
describe('webhook history routes', () => {
  test.each(['', 'session-token'])('rejects non-admin %s before reading history', async token => {
    const { app, history } = setup()
    expect((await request(app).get(url).set('Authorization', `Bearer ${token}`)).status).toBe(403)
    expect(history.entries).not.toHaveBeenCalled()
  })
  test('lists history even after session deletion', async () => {
    const { app, history } = setup()
    expect((await request(app).get(url).set('Authorization', 'Bearer admin')).body).toEqual({ snapshots: [] })
    expect(history.entries).toHaveBeenCalledWith('5511999999')
  })
  test.each([{}, { snapshot_id: 's', webhook_ids: [] }, { snapshot_id: 's', webhook_ids: ['x', 'x'] }, { snapshot_id: 's', webhook_ids: [1] }, { snapshot_id: 's', webhook_ids: ['x'], replace_existing: 'true' }])('rejects invalid selection %j', async body => {
    const { app, history } = setup()
    expect((await request(app).post(`${url}/restore`).set('Authorization', 'Bearer admin').send(body)).status).toBe(400)
    expect(history.restore).not.toHaveBeenCalled()
  })
  test('restores with explicit replacement and returns no secrets', async () => {
    const { app, history } = setup()
    const result = await request(app).post(`${url}/restore`).set('Authorization', 'Bearer admin').send({ snapshot_id: 's', webhook_ids: ['x'], replace_existing: true })
    expect(result.body).toEqual({ restored: ['x'], enabled: false })
    expect(history.restore).toHaveBeenCalledWith('5511999999', 's', ['x'], true)
  })
  test.each([409, 503])('handles conflict or sanitized infrastructure error %s', async status => {
    const { app, history } = setup()
    history.restore.mockRejectedValue(status === 409 ? new WebhookHistoryError(409, 'configuration_changed') : new Error('secret'))
    const result = await request(app).post(`${url}/restore`).set('Authorization', 'Bearer admin').send({ snapshot_id: 's', webhook_ids: ['x'] })
    expect(result.status).toBe(status)
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })
})
