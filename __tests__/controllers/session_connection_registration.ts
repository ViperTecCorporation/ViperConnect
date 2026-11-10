jest.mock('../../src/services/redis')
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn(), amqpRpc: jest.fn() }))
import express from 'express'
import request from 'supertest'
import { defaultConfig } from '../../src/services/config'
import { markSessionConfigRegistration } from '../../src/services/session_storage/connection_registration'
import { ConnectController } from '../../src/controllers/connect_controller'
import { SessionController } from '../../src/controllers/session_controller'
import { PairingCodeController } from '../../src/controllers/pairing_code_controller'
import { SendError } from '../../src/services/send_error'
import { IncomingAmqp } from '../../src/services/incoming_amqp'
import { amqpRpc } from '../../src/amqp'

const phone = '5566000000882'
test.each(['redis', 'sqlite'])('connect and sessions reject an unknown phone before reload/store and preserve known %s sessions', async backend => {
  const store = { sessionStore: { isStatusDisconnect: jest.fn().mockResolvedValue(true) } }
  const config = { ...defaultConfig, useRedis: true, provider: 'zapo' as const, getStore: jest.fn().mockResolvedValue(store),
    ...(backend === 'sqlite' ? { sessionStorage: { backend: 'sqlite' as const, storageId: 'synthetic', generation: 1, owner: 'worker', state: 'offline' as const } } : {}) }
  markSessionConfigRegistration(config, false)
  const reload = { run: jest.fn().mockResolvedValue(undefined) }
  const connect = new ConnectController(reload as any, async () => config)
  const sessions = new SessionController(async () => config, reload as any)
  const app = express().get('/connect/:phone', connect.index.bind(connect)).get('/sessions/:phone', sessions.index.bind(sessions))
  for (const path of ['connect', 'sessions']) {
    const response = await request(app).get(`/${path}/${phone}`)
    expect(response.status).toBe(409)
    expect(response.body.error).toBe('session_storage_registration_required')
  }
  expect(config.getStore).not.toHaveBeenCalled(); expect(reload.run).not.toHaveBeenCalled()
  markSessionConfigRegistration(config, true)
  for (const path of ['connect', 'sessions']) expect((await request(app).get(`/${path}/${phone}`)).status).toBe(200)
  expect(reload.run).toHaveBeenCalledTimes(2)
})

test('pairing code propagates registration/owner fences as explicit HTTP errors, never success', async () => {
  const service = { requestPairingCode: jest.fn().mockRejectedValue(new SendError(409, 'session_storage_registration_required')) }
  const controller = new PairingCodeController(service as any)
  const app = express().post('/:phone/request_code', controller.request.bind(controller))
  const response = await request(app).post(`/${phone}/request_code`)
  expect(response.status).toBe(409)
  expect(response.body).toEqual({ status: 'error', message: 'session_storage_registration_required' })
})

test('pairing preserves a recognized AMQP error and sanitizes unknown remote failures', async () => {
  const service = { requestPairingCode: jest.fn().mockRejectedValueOnce(Object.assign(new Error('RPC failed'), { remote: { message: '409: session_storage_registration_required' } }))
    .mockRejectedValueOnce(new Error('timeout queue: private diagnostics')) }
  const controller = new PairingCodeController(service as any)
  const app = express().post('/:phone/request_code', controller.request.bind(controller))
  const known = await request(app).post(`/${phone}/request_code`)
  expect(known.status).toBe(409); expect(known.body.message).toBe('session_storage_registration_required')
  const unknown = await request(app).post(`/${phone}/request_code`)
  expect(unknown.status).toBe(503); expect(unknown.body.message).toBe('pairing_code_unavailable')
})

test('legacy session configuration form never renders private storage/provisioning fields as editable inputs', async () => {
  const config = { ...defaultConfig, useRedis: true, provider: 'zapo' as const,
    getStore: jest.fn().mockResolvedValue({ sessionStore: { isStatusDisconnect: async () => false, isStatusOffline: async () => false, getStatus: async () => 'online' } }) }
  markSessionConfigRegistration(config, true)
  const controller = new SessionController(async () => config, { run: jest.fn() } as never)
  const app = express().get('/:phone', controller.index.bind(controller))
  const response = await request(app).get(`/${phone}`)
  expect(response.status).toBe(200)
  expect(response.text).toContain('name="authToken"')
  expect(response.text).not.toMatch(/name="(?:sessionStorage|mobilePrimary)/)
})

test('HTTP pairing rejects an unregistered phone before publishing an RPC to a default or nonexistent owner', async () => {
  const config = { ...defaultConfig, useRedis: true, provider: 'zapo' as const }
  markSessionConfigRegistration(config, false)
  const controller = new PairingCodeController(new IncomingAmqp(async () => config))
  const app = express().post('/:phone/request_code', controller.request.bind(controller))
  const response = await request(app).post(`/${phone}/request_code`)
  expect(response.status).toBe(409)
  expect(response.body.message).toBe('session_storage_registration_required')
  expect(amqpRpc).not.toHaveBeenCalled()
})
