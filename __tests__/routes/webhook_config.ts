import request from 'supertest'
import { mock } from 'jest-mock-extended'

jest.mock('../../src/services/redis', () => ({
  ...jest.requireActual('../../src/services/redis'),
  setConfig: jest.fn(),
}))

import { App } from '../../src/app'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'
import { SessionStore } from '../../src/services/session_store'
import { OnNewLogin } from '../../src/services/socket'
import { Reload } from '../../src/services/reload'
import { Logout } from '../../src/services/logout'
import { addToBlacklist } from '../../src/services/blacklist'
import { setConfig } from '../../src/services/redis'

const addToBlacklistMock = mock<addToBlacklist>()
const setConfigMock = setConfig as jest.MockedFunction<typeof setConfig>

describe('webhook config routes', () => {
  test('disables a specific webhook in redis without removing the others', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const sessionStore = mock<SessionStore>()
    const onNewLogin = mock<OnNewLogin>()
    const reload = mock<Reload>()
    const logout = mock<Logout>()
    const phone = '5566996269251'
    const config: any = {
      ...defaultConfig,
      webhooks: [
        { ...defaultConfig.webhooks[0], id: 'chatwoot', url: 'https://chatwoot.local/webhook', enabled: true },
        { ...defaultConfig.webhooks[0], id: 'typebot', urlAbsolute: 'https://bot.local/webhook', enabled: true },
      ],
    }
    const getConfigTest: getConfig = async () => config
    setConfigMock.mockImplementation(async (_phone: string, value: any) => {
      config.webhooks = value.webhooks
      return { ...config, ...value }
    })

    const app: App = new App(incoming, outgoing, '', getConfigTest, sessionStore, onNewLogin, addToBlacklistMock, reload, logout)
    const res = await request(app.server)
      .patch(`/v19.0/${phone}/webhooks/typebot`)
      .send({ enabled: false })

    expect(res.status).toEqual(200)
    expect(setConfigMock).toHaveBeenCalledWith(phone, {
      webhooks: [
        { ...defaultConfig.webhooks[0], id: 'chatwoot', url: 'https://chatwoot.local/webhook', enabled: true },
        { ...defaultConfig.webhooks[0], id: 'typebot', urlAbsolute: 'https://bot.local/webhook', enabled: false },
      ],
      overrideWebhooks: true,
    })
    expect(res.body.webhook.enabled).toBe(false)
    expect(res.body.webhooks).toHaveLength(2)
  })
})
