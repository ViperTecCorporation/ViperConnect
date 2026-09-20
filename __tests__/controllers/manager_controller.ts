import express from 'express'
import request from 'supertest'
import { managerRouter } from '../../src/controllers/manager_controller'
import { ManagerError } from '../../src/services/manager_identity'

describe('Manager HTTP contracts', () => {
  const user = { id: 'u1', role: 'user', kind: 'login', username: 'maria', name: 'Maria', phones: [] }
  const identity: any = Object.fromEntries(['authenticate','login','logout','users','createUser','updateUser','revokeKeys',
    'assignments','assign','keys','createKey','revokeKey','changePassword'].map(name => [name, jest.fn()]))
  const app = express().use(express.json()).use('/manager', managerRouter(identity))
  beforeEach(() => {
    Object.values(identity).forEach((fn: any) => fn.mockReset())
    identity.authenticate.mockResolvedValue(user)
  })
  test('login passes credentials to service without echoing a password', async () => {
    identity.login.mockResolvedValue({ token: 'mgr_login_example', user })
    const response = await request(app).post('/manager/login').send({ username: 'maria', password: 'password-example' })
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.text).not.toContain('password-example')
    expect(identity.authenticate).not.toHaveBeenCalled()
  })
  test.each(['/users', '/assignments'])('ordinary user cannot read admin %s', async path => {
    expect((await request(app).get(`/manager${path}`)).status).toBe(403)
  })
  test('untrusted role or user ID in request body does not grant admin', async () => {
    expect((await request(app).post('/manager/users').send({ role: 'admin', user_id: 'admin' })).status).toBe(403)
    expect(identity.createUser).not.toHaveBeenCalled()
  })
  test('API keys cannot mint keys, edit passwords, or list secrets', async () => {
    identity.authenticate.mockResolvedValue({ ...user, kind: 'api' })
    expect((await request(app).get('/manager/keys')).status).toBe(403)
    expect((await request(app).post('/manager/keys').send({ name: 'x' })).status).toBe(403)
    expect((await request(app).post('/manager/password').send({ password: 'x' })).status).toBe(403)
    expect((await request(app).get('/manager/me')).status).toBe(200)
  })
  test('key ownership is taken from authenticated account, never payload', async () => {
    identity.createKey.mockResolvedValue({ token: 'mgr_key_new', key: { id: 'k1' } })
    await request(app).post('/manager/keys').send({ user_id: 'other', name: 'ERP' })
    expect(identity.createKey).toHaveBeenCalledWith('u1', { user_id: 'other', name: 'ERP' })
    await request(app).delete('/manager/keys/k1')
    expect(identity.revokeKey).toHaveBeenCalledWith('u1', 'k1')
  })
  test('transfer requires explicit expected owner and preserves conflict detail', async () => {
    identity.authenticate.mockResolvedValue({ ...user, role: 'admin' })
    expect((await request(app).put('/manager/assignments/5566996269251').send({ user_id: 'u2' })).status).toBe(400)
    expect(identity.assign).not.toHaveBeenCalled()
    identity.assign.mockRejectedValue(new ManagerError(409, 'manager_assignment_conflict', { current_owner: 'u3' }))
    const response = await request(app).put('/manager/assignments/5566996269251').send({ user_id: 'u2', expected_owner: 'u1' })
    expect(response.status).toBe(409)
    expect(response.body.current_owner).toBe('u3')
  })
  test('missing auth and Redis failures fail closed without exposing internals', async () => {
    identity.authenticate.mockResolvedValue(undefined)
    expect((await request(app).get('/manager/me')).status).toBe(401)
    identity.authenticate.mockRejectedValue(new Error('redis://secret-password'))
    const response = await request(app).get('/manager/me')
    expect(response.status).toBe(503)
    expect(response.text).not.toContain('secret-password')
  })
})
