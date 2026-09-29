import express from 'express'
import request from 'supertest'
import { mobileDeviceRouter } from '../../src/controllers/mobile_device_controller'
import { MobileDeviceError } from '../../src/services/mobile_device_service'

const base = '/manager/mobile-devices/00000000-0000-0000-0000-000000000001/companion-history'
const identity: any = { authenticate: jest.fn() }
const status = jest.fn().mockResolvedValue({ state: 'submitted', sent: 2, total: 2 })
const runtime = { requestCompanionHistory: jest.fn().mockRejectedValue(new MobileDeviceError(410, 'mobile_history_pair_time_only')), companionHistoryService: jest.fn().mockResolvedValue({ status }) }
const app = express().use(express.json()).use('/manager/mobile-devices', mobileDeviceRouter(identity, {} as any, () => true, {} as any, undefined, undefined, undefined, undefined, async () => runtime as any))
beforeEach(() => { jest.clearAllMocks(); identity.authenticate.mockResolvedValue({ id: 'admin', role: 'admin', kind: 'stack' }) })
test('manual export returns Gone; old status remains readable without messages/keys', async () => {
  const response = await request(app).post(base).set('Authorization', 'Bearer test').send({ target: '999123456789:2@s.whatsapp.net', confirm: true })
  expect(response.status).toBe(410); expect(response.body.error).toBe('mobile_history_pair_time_only'); expect(response.headers['cache-control']).toBe('no-store')
  expect((await request(app).get(base + '/job').set('Authorization', 'Bearer test')).body).toEqual({ state: 'submitted', sent: 2, total: 2 })
})
test.each([{ role: 'user', kind: 'login' }, { role: 'admin', kind: 'api' }])('rejects non-admin or API-key principal %j', async principal => {
  identity.authenticate.mockResolvedValue(principal)
  expect((await request(app).post(base).set('Authorization', 'Bearer test').send({ confirm: true })).status).toBe(403)
  expect((await request(app).get(base + '/job').set('Authorization', 'Bearer test')).status).toBe(403)
  expect(runtime.requestCompanionHistory).not.toHaveBeenCalled(); expect(runtime.companionHistoryService).not.toHaveBeenCalled()
})
test('requires header authentication, no token in query', async () => {
  expect((await request(app).post(base + '?token=test').send({ confirm: true })).status).toBe(401)
  expect(identity.authenticate).not.toHaveBeenCalled()
})
