import express from 'express'
import request from 'supertest'
import { ResourceMetricsController } from '../../src/controllers/resource_metrics_controller'

test('only administrator/global token can read resources; invalid IDs and periods are rejected before storage', async () => {
  const current = jest.fn().mockResolvedValue({ components: [] }), history = jest.fn().mockResolvedValue({ points: [] })
  const service = jest.fn().mockResolvedValue({ current, history }), controller = new ResourceMetricsController(service as any, 'test-admin-only')
  const app = express(); app.get('/admin/resources', controller.handle.bind(controller)); app.get('/admin/resources/:component/history', controller.handle.bind(controller))
  expect((await request(app).get('/admin/resources')).status).toBe(403)
  expect((await request(app).get('/admin/resources').set('Authorization', 'Bearer other-user')).status).toBe(403)
  expect(service).not.toHaveBeenCalled()
  const response = await request(app).get('/admin/resources').set('Authorization', 'Bearer test-admin-only')
  expect(response.status).toBe(200); expect(response.header['cache-control']).toBe('no-store')
  expect((await request(app).get('/admin/resources/unsafe/history').set('Authorization', 'Bearer test-admin-only')).status).toBe(400)
  expect((await request(app).get(`/admin/resources/${'a'.repeat(24)}/history?range=alltime`).set('Authorization', 'Bearer test-admin-only')).status).toBe(400)
  expect((await request(app).get(`/admin/resources/${'a'.repeat(24)}/history?range=90d`).set('Authorization', 'Bearer test-admin-only')).status).toBe(200)
  expect(history).toHaveBeenCalledWith('a'.repeat(24), '90d')
})
