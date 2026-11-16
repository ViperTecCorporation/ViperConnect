import express from 'express'
import request from 'supertest'
import { ServiceLogsController } from '../../src/controllers/service_logs_controller'
import { serviceControlServer } from '../../src/services/service_control/agent_server'
import { ServiceLogService } from '../../src/services/service_control/log_service'
import { managerAccess } from '../../src/services/manager_access'
import { ServiceControlClient } from '../../src/services/service_control/client'
import { logOptions } from '../../src/services/service_control/log_types'

const component = 'a'.repeat(24), secret = 'test-agent-only'.repeat(4)
test('log route is administrator-only and rejects invalid queries before accessing infrastructure', async () => {
  const proxy = { stream: jest.fn(async (_id, _options, response) => response.type('application/x-ndjson').end('{"type":"connected"}\n')) }
  const controller = new ServiceLogsController(proxy as any, 'admin-only')
  const app = express(); app.use(managerAccess({ authenticate: async () => ({ id: 'user', role: 'user', phones: [], username: 'user' }) } as any)); app.get('/admin/resources/:component/logs', controller.handle.bind(controller))
  for (const token of ['', 'session-only', 'mgr_user']) expect((await request(app).get(`/admin/resources/${component}/logs`).set('Authorization', `Bearer ${token}`)).status).toBe(403)
  expect(proxy.stream).not.toHaveBeenCalled()
  expect((await request(app).get(`/admin/resources/${component}/logs?tail=999999`).set('Authorization', 'Bearer admin-only')).status).toBe(400)
  expect((await request(app).get(`/admin/resources/${component}/logs?command=cat`).set('Authorization', 'Bearer admin-only')).status).toBe(400)
  const result = await request(app).get(`/admin/resources/${component}/logs?include=audio&level=error`).set('Authorization', 'Bearer admin-only')
  expect(result.status).toBe(200); expect(result.header['cache-control']).toBe('no-store')
  expect(proxy.stream.mock.calls[0][1]).toMatchObject({ include: 'audio', level: 'error', tail: 300 })
})
test('private agent exposes only allowlisted log streams, with dedicated header authentication', async () => {
  const logs = new ServiceLogService([{ component, name: 'probe', backend: 'docker', target: 'only-probe' }], { open: async () => ({ close: jest.fn(), lines: (async function* () { yield { text: 'hello', channel: 'stdout' } })() }) } as any)
  const app = serviceControlServer({} as any, secret, logs)
  expect((await request(app).get(`/v1/targets/${component}/logs?token=${secret}`)).status).toBe(403)
  expect((await request(app).get(`/v1/targets/${'b'.repeat(24)}/logs`).set('Authorization', `Bearer ${secret}`)).status).toBe(404)
  const response = await request(app).get(`/v1/targets/${component}/logs`).set('Authorization', `Bearer ${secret}`)
  expect(response.status).toBe(200); expect(response.text).toContain('hello'); expect(response.headers['x-accel-buffering']).toBe('no')
})
test('agent client preserves streaming body, uses private auth and refuses redirects/invalid output', async () => {
  const fetcher = jest.fn().mockResolvedValue(new Response('{"type":"heartbeat"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } }))
  const client = new ServiceControlClient('http://agent.internal:9880', secret, fetcher)
  const response = await client.logs(component, logOptions({}), new AbortController().signal)
  expect(await response.text()).toContain('heartbeat')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${secret}` } })
  fetcher.mockResolvedValueOnce(new Response('{"error":"logs_viewers_limit"}', { status: 429 }))
  await expect(client.logs(component, logOptions({}), new AbortController().signal)).rejects.toThrow('logs_viewers_limit')
  fetcher.mockResolvedValueOnce(new Response('private body'))
  await expect(client.logs(component, logOptions({}), new AbortController().signal)).rejects.toThrow('logs_format_invalid')
  await expect(new ServiceControlClient('', '', fetcher).logs(component, logOptions({}), new AbortController().signal)).rejects.toThrow('logs_not_configured')
})
