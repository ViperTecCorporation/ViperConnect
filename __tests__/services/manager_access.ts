import express from 'express'
import request from 'supertest'
import { managerAccess, managerPrincipal, managerRequestScope, redactManagerConfig } from '../../src/services/manager_access'
import Security from '../../src/services/security'

jest.mock('../../src/services/meta_alias', () => ({ resolveSessionPhoneByMetaId: jest.fn(async value => value) }))

const own = '5566996269251'
const other = '5566999554300'
const user = { id: 'u1', name: 'Maria', username: 'maria', role: 'user', kind: 'api', phones: [own] }

describe('Manager personal credential gate (legacy access intentionally preserved)', () => {
  const authenticate = jest.fn()
  const resolve = jest.fn(async value => value === '1234567890123456' ? own : value)
  const app = express()
  app.use(express.json())
  app.use(managerAccess({ authenticate } as any, resolve))
  app.use((req, res) => res.json({ principal: managerPrincipal(req), header: req.headers.authorization,
    authToken: 'STACK_SECRET', storage: { secretAccessKey: 'S3_SECRET' }, body: req.body }))
  beforeEach(() => { authenticate.mockReset().mockResolvedValue({ ...user, phones: [own] }); resolve.mockClear() })

  test.each([
    `/v15.0/${own}`, `/v15.0/${own}/messages`, `/v15.0/${own}/groups/a/participants`,
    `/${own}/contacts`, `/${own}/contacts/import`, `/${own}/blacklist/type`,
    `/admin/webhooks/history/${own}`, `/admin/webhooks/history/${own}/restore`,
    `/connect/${own}`, `/sessions/${own}`, `/v15.0/download/${own}/file.pdf`,
    `/v15.0/${own}-messageid`, '/v15.0/1234567890123456/messages', '/sessions',
    '/sessions/meta/mappings', '/version', '/v15.0/me/whatsapp_business_accounts',
  ])('permits assigned resource %s', async path => {
    expect((await request(app).get(path).set('Authorization', 'Bearer mgr_key_example')).status).toBe(200)
  })
  test.each([
    `/v15.0/${other}`, `/v15.0/${other}/messages`, `/${other}/contacts`,
    `/connect/${other}`, `/admin/webhooks/history/${other}`, `/v15.0/${other}-mediaid`,
    '/admin/redis/query', '/admin/rabbitmq/queues', '/admin/session-webhooks', '/passkey-bridge/pending',
    '/v15.0/ambiguousmediaid', '/v15.0/oauth/access_token',
    `/v15.0/download/${own}/%2e%2e%2f${other}%2fsecret.pdf`,
  ])('denies unrelated/unscoped route %s', async path => {
    expect((await request(app).get(path).set('Authorization', 'Bearer mgr_key_example')).status).toBe(403)
  })
  test('fresh lookup denies a transferred or revoked session on the next request', async () => {
    expect((await request(app).get(`/v15.0/${own}`).auth('mgr_key_example', { type: 'bearer' })).status).toBe(200)
    authenticate.mockResolvedValue({ ...user, phones: [] })
    expect((await request(app).get(`/v15.0/${own}`).auth('mgr_key_example', { type: 'bearer' })).status).toBe(403)
  })
  test('invalid and unavailable credentials fail closed, even on public routes', async () => {
    authenticate.mockResolvedValue(undefined)
    expect((await request(app).get(`/connect/${own}`).auth('mgr_key_bad', { type: 'bearer' })).status).toBe(401)
    authenticate.mockRejectedValue(new Error('redis unavailable'))
    expect((await request(app).get('/sessions').auth('mgr_key_bad', { type: 'bearer' })).status).toBe(503)
  })
  test('legacy public routes and legacy tokens are unchanged', async () => {
    expect((await request(app).get(`/connect/${other}`)).status).toBe(200)
    expect((await request(app).get('/v15.0/oauth/access_token').auth('legacy', { type: 'bearer' })).status).toBe(200)
    expect(authenticate).not.toHaveBeenCalled()
  })
  test('admin manager login may use all routes without handing downstream code the token', async () => {
    authenticate.mockResolvedValue({ ...user, role: 'admin', kind: 'login', phones: [] })
    const response = await request(app).get('/admin/redis/keys').auth('mgr_login_admin', { type: 'bearer' })
    expect(response.status).toBe(200)
    expect(response.body.header).toBe('[manager-authenticated]')
  })
  test('configuration output does not leak legacy/global credentials', async () => {
    const response = await request(app).get(`/v15.0/${own}`).auth('mgr_key_example', { type: 'bearer' })
    expect(response.text).not.toContain('STACK_SECRET')
    expect(response.text).not.toContain('S3_SECRET')
    expect(response.text).not.toContain('mgr_key_example')
  })
  test('webhook updates also redact the returned session configuration', async () => {
    const response = await request(app).patch(`/v15.0/${own}/webhooks/destination`).auth('mgr_key_example', { type: 'bearer' }).send({ enabled: true })
    expect(response.status).toBe(200)
    expect(response.text).not.toContain('STACK_SECRET')
    expect(response.text).not.toContain('S3_SECRET')
  })
  test('blank redacted transcription keys preserve existing configuration', async () => {
    const response = await request(app).post(`/v15.0/${own}/register`).auth('mgr_key_example', { type: 'bearer' }).send({ openaiApiKey: '', groqApiKey: '', label: 'x' })
    expect(response.body.body).toEqual({ label: 'x' })
  })
  test.each(['authToken', 'auth_token', 'storage', 'proxyUrl', 'baseStore', 'getStore'])('user cannot install credential bypass through %s', async field => {
    const response = await request(app).post(`/v15.0/${own}/register`).auth('mgr_key_example', { type: 'bearer' }).send({ [field]: 'secret' })
    expect(response.status).toBe(403)
  })
  test('blank legacy token field is discarded without blocking ordinary configuration', async () => {
    const response = await request(app).post(`/v15.0/${own}/register`).auth('mgr_key_example', { type: 'bearer' }).send({ authToken: '', label: 'Sessão' })
    expect(response.status).toBe(200)
    expect(response.body.body).toEqual({ label: 'Sessão' })
  })
  test('message body is not redacted as if it were server configuration', async () => {
    const response = await request(app).post(`/v15.0/${own}/messages`).auth('mgr_key_example', { type: 'bearer' }).send({ text: { body: 'hello', secret: 'ordinary content' } })
    expect(response.body.body.text.secret).toBe('ordinary content')
  })
  test('the legacy security middleware only trusts a principal installed by the gate', async () => {
    const next = jest.fn()
    const security = new Security({ getTokens: jest.fn() } as any)
    const req: any = { headers: { authorization: 'Bearer mgr_key_example' }, path: `/v15.0/${own}`, query: {}, body: {} }
    const res: any = { locals: {}, json: jest.fn(), status: jest.fn().mockReturnThis() }
    await managerAccess({ authenticate } as any, resolve)(req, res, async () => security.run(req, res, next))
    expect(next).toHaveBeenCalledTimes(1)
  })
  test('helper strips only configured secret fields recursively', () => {
    expect(redactManagerConfig([{ authToken: 'secret', label: 'name', child: { password: 'hidden', enabled: true } }]))
      .toEqual([{ label: 'name', child: { enabled: true } }])
    expect(managerRequestScope('/admin/voip/bootstrap')).toBe('voip')
    expect(managerRequestScope('/unknown')).toBeUndefined()
  })
})
