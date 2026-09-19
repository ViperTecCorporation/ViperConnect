import request from 'supertest'
import { mock } from 'jest-mock-extended'
import { App } from '../../src/app'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'
import { SessionStore } from '../../src/services/session_store'
import { OnNewLogin } from '../../src/services/socket'
import { Reload } from '../../src/services/reload'
import { Logout } from '../../src/services/logout'

const addToBlacklist = jest.fn().mockReturnValue(Promise.resolve(true))

const sessionStore = mock<SessionStore>()
const getConfigTest: getConfig = async (_phone: string) => {
  return defaultConfig
}

describe('blacklist routes', () => {
  test.each(['50113712017501@lid', '5566996269251', '120363426717231138@g.us'])('accepts add/remove for %s and preserves explicit zero TTL', async to => {
    const app = new App(mock<Incoming>(), mock<Outgoing>(), '', getConfigTest, sessionStore,
      mock<OnNewLogin>(), addToBlacklist, mock<Reload>(), mock<Logout>())
    for (const ttl of [-1, 60, 0]) {
      const res = await request(app.server).post('/2/blacklist/type?ttl=99').send({ to, ttl })
      expect(res.status).toBe(200)
      expect(addToBlacklist).toHaveBeenLastCalledWith('2', 'type', to, ttl)
    }
    const invalid = await request(app.server).post('/2/blacklist/type').send({ to, ttl: 'invalid' })
    expect(invalid.status).toBe(400)
  })
  test('update', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const onNewLogin = mock<OnNewLogin>()
    const reload = mock<Reload>()
    const logout = mock<Logout>()
    const app: App = new App(incoming, outgoing, '', getConfigTest, sessionStore, onNewLogin, addToBlacklist, reload, logout)
    const res = await request(app.server).post('/2/blacklist/1').send({ttl: 1, to: '3'})
    expect(addToBlacklist).toHaveBeenCalledWith('2', '1', '3', 1);
    expect(res.status).toEqual(200)
  })
})
