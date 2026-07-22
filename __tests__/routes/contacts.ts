import request from 'supertest'
import { mock } from 'jest-mock-extended'
import { App } from '../../src/app'
import { defaultConfig, getConfig } from '../../src/services/config'
import type { Incoming } from '../../src/services/incoming'
import type { Outgoing } from '../../src/services/outgoing'
import type { SessionStore } from '../../src/services/session_store'
import type { OnNewLogin } from '../../src/services/socket'
import type { addToBlacklist } from '../../src/services/blacklist'
import type { Reload } from '../../src/services/reload'
import type { Logout } from '../../src/services/logout'
import type { Contact } from '../../src/services/contact'
import { getRedis } from '../../src/services/redis'

jest.mock('../../src/services/redis', () => ({
  ...jest.requireActual('../../src/services/redis'),
  getRedis: jest.fn(),
}))

describe('contacts directory route', () => {
  test('serves the normalized Zapo contact page through GET /:phone/contacts', async () => {
    const redis = {
      scan: jest.fn().mockResolvedValue({
        cursor: '0',
        keys: ['unoapi:zapo:contact:5566:123@lid'],
      }),
      hGetAll: jest.fn().mockResolvedValue({
        jid: '123@lid',
        phone_number: '556699554300@s.whatsapp.net',
        push_name: 'Maria',
        last_updated_ms: '1710000000000',
      }),
    }
    ;(getRedis as jest.Mock).mockResolvedValue(redis)
    const getConfigTest: getConfig = jest.fn().mockResolvedValue({ ...defaultConfig, provider: 'zapo' })
    const app = new App(
      mock<Incoming>(),
      mock<Outgoing>(),
      '',
      getConfigTest,
      mock<SessionStore>(),
      mock<OnNewLogin>(),
      mock<addToBlacklist>(),
      mock<Reload>(),
      mock<Logout>(),
      undefined,
      undefined,
      mock<Contact>(),
    )

    const response = await request(app.server).get('/5566/contacts?limit=20').expect(200)

    expect(response.body).toEqual({
      contacts: [
        {
          user_id: '123@lid',
          phone_number: '5566999554300',
          push_name: 'Maria',
          last_updated_ms: 1710000000000,
        },
      ],
      next_cursor: '0',
      has_more: false,
    })
  })
})
