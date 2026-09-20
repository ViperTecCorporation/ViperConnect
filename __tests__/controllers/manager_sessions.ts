import express from 'express'
import request from 'supertest'
import { managerAccess } from '../../src/services/manager_access'
import { PhoneNumberController } from '../../src/controllers/phone_number_controller'

jest.mock('../../src/services/meta_alias', () => ({ resolveSessionPhoneByMetaId: async value => value }))
jest.mock('../../src/services/privacy_token_quota', () => ({ getMissingTcTokenQuotaStatus: async () => undefined }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() } }))

describe('Manager session listing retains ownership independently of connection', () => {
  const phone = '5566996269251', second = '5566999554300', absent = '5566999424178'
  const authenticate = jest.fn()
  const store: any = { getPhones: jest.fn(), getStatus: jest.fn(async () => 'online') }
  const getConfig = jest.fn(async value => ({ provider: 'zapo', label: value, authToken: 'legacy-global', webhooks: [] } as any))
  const controller = new PhoneNumberController(getConfig, store)
  const app = express().use(managerAccess({ authenticate } as any, async value => value))
    .get('/sessions', controller.list.bind(controller))
  beforeEach(() => {
    getConfig.mockClear()
    store.getPhones.mockResolvedValue([phone, second])
    authenticate.mockResolvedValue({ id: 'u1', username: 'u1', name: 'User', role: 'user', kind: 'login', phones: [phone, absent] })
  })
  test('lists only assigned sessions and includes preassigned disconnected number', async () => {
    const response = await request(app).get('/sessions').auth('mgr_login_test', { type: 'bearer' })
    expect(response.status).toBe(200)
    expect(response.body.data.map(row => row.phone)).toEqual([phone, absent])
    expect(response.body.data[1]).toMatchObject({ manager_pending: true, status: 'disconnected' })
    expect(getConfig).not.toHaveBeenCalledWith(second)
    expect(response.text).not.toContain('legacy-global')
  })
  test('removal preserves placeholder; reconnect automatically restores real status', async () => {
    store.getPhones.mockResolvedValue([])
    const removed = await request(app).get('/sessions').auth('mgr_login_test', { type: 'bearer' })
    expect(removed.body.data[0]).toMatchObject({ phone, manager_pending: true })
    store.getPhones.mockResolvedValue([phone])
    const connected = await request(app).get('/sessions').auth('mgr_login_test', { type: 'bearer' })
    expect(connected.body.data[0]).toMatchObject({ phone, status: 'online' })
    expect(connected.body.data[0].manager_pending).toBeUndefined()
  })
  test('admin sees all existing sessions plus preassigned absent numbers', async () => {
    authenticate.mockResolvedValue({ id: 'admin', role: 'admin', phones: [absent], kind: 'login' })
    const response = await request(app).get('/sessions').auth('mgr_login_admin', { type: 'bearer' })
    expect(response.body.data.map(row => row.phone)).toEqual([phone, second, absent])
  })
  test('previous owner loses listing after transfer even when session reconnects', async () => {
    authenticate.mockResolvedValue({ id: 'u1', role: 'user', phones: [], kind: 'login' })
    const response = await request(app).get('/sessions').auth('mgr_login_test', { type: 'bearer' })
    expect(response.body.data).toEqual([])
    expect(getConfig).not.toHaveBeenCalled()
  })
})
