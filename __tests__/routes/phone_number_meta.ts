import request from 'supertest'
import { mock } from 'jest-mock-extended'

import { App } from '../../src/app'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { getStore, Store } from '../../src/services/store'
import { Config, getConfig } from '../../src/services/config'
import { DataStore } from '../../src/services/data_store'
import { SessionStore } from '../../src/services/session_store'
import { OnNewLogin } from '../../src/services/socket'
import { addToBlacklist } from '../../src/services/blacklist'
import { Reload } from '../../src/services/reload'
import { Logout } from '../../src/services/logout'

jest.mock('../../src/services/privacy_token_quota', () => ({
  getMissingTcTokenQuotaStatus: jest.fn().mockResolvedValue({
    enabled: true,
    limit: 40,
    used: 0,
    remaining: 40,
    windowHours: 24,
    blocked: false,
  }),
}))

const addToBlacklist = mock<addToBlacklist>()

describe('phone number meta-like routes', () => {
  const sessionPhone = '5566999554300'
  const phoneNumberId = 'phone-id-123'
  const businessAccountId = 'waba-id-123'
  let app: App
  let config: Config
  let sessionStore: SessionStore
  let dataStore: DataStore

  beforeEach(() => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const onNewLogin = mock<OnNewLogin>()
    const reload = mock<Reload>()
    const logout = mock<Logout>()
    sessionStore = mock<SessionStore>()
    dataStore = mock<DataStore>()
    const store = mock<Store>()
    config = mock<Config>()
    ;(sessionStore.getPhones as jest.Mock).mockResolvedValue([sessionPhone])
    ;(sessionStore.getStatus as jest.Mock).mockResolvedValue('online')
    ;(dataStore.loadTemplates as jest.Mock).mockResolvedValue([])
    store.dataStore = dataStore
    store.sessionStore = sessionStore
    ;(config.getStore as getStore as jest.Mock).mockResolvedValue(store)
    ;(config as any).authToken = 'client-token'
    ;(config as any).label = 'Viper'
    ;(config as any).webhookForward = { phoneNumberId, businessAccountId }
    const getConfigTest: getConfig = async () => config

    app = new App(incoming, outgoing, '', getConfigTest, sessionStore, onNewLogin, addToBlacklist, reload, logout)
  })

  test('lists whatsapp business accounts for authorized token', async () => {
    const res = await request(app.server).get('/v19.0/me/whatsapp_business_accounts').set('Authorization', 'Bearer client-token')

    expect(res.status).toEqual(200)
    expect(res.body).toEqual({ data: [{ id: businessAccountId, name: 'Viper' }] })
  })

  test('lists phone numbers under a business account id', async () => {
    const res = await request(app.server).get(`/v19.0/${businessAccountId}/phone_numbers`).set('Authorization', 'Bearer client-token')

    expect(res.status).toEqual(200)
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: phoneNumberId,
        business_account_id: businessAccountId,
        display_phone_number: businessAccountId,
        verified_name: 'Viper',
      }),
    )
  })

  test('lists sessions with stable edit identifiers when status is offline', async () => {
    ;(sessionStore.getStatus as jest.Mock).mockResolvedValue('offline')

    const res = await request(app.server).get('/sessions').set('Authorization', 'Bearer client-token')

    expect(res.status).toEqual(200)
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: sessionPhone,
        phone: sessionPhone,
        display_phone_number: sessionPhone,
        status: 'offline',
      }),
    )
  })

  test('returns debug token scopes for valid token', async () => {
    const res = await request(app.server).get('/v19.0/debug_token?input_token=client-token')

    expect(res.status).toEqual(200)
    expect(res.body.data.is_valid).toBe(true)
    expect(res.body.data.expires_at).toBe(0)
    expect(res.body.data.scopes).toEqual(['whatsapp_business_management', 'whatsapp_business_messaging'])
  })

  test('returns administrative meta mappings', async () => {
    const res = await request(app.server).get('/sessions/meta/mappings').set('Authorization', 'Bearer client-token')

    expect(res.status).toEqual(200)
    expect(res.body).toEqual({
      data: [
        {
          session_phone: sessionPhone,
          phone_number_id: phoneNumberId,
          business_account_id: businessAccountId,
        },
      ],
    })
  })
})
