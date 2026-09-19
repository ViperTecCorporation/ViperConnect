import { renderSessionWebhooks, sessionDestinationPayload } from '../../frontend/pages/session_webhooks'
import { ApiClient } from '../../frontend/core/api'
import { ViperConnectApp } from '../../frontend/app'

describe('session destination panel', () => {
  test('loads destinations through the application and clears prior admin data after authorization failure', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.api = { sessionDestinations: jest.fn().mockResolvedValue({ destinations: [{ id: 'destination' }] }) }
    app.render = jest.fn()
    await app.loadSessionDestinations()
    expect(app.sessionDestinations).toEqual([{ id: 'destination' }])
    expect(app.sessionDestinationError).toBe('')
    app.api.sessionDestinations.mockRejectedValue(new Error('admin_token_required'))
    await app.loadSessionDestinations()
    expect(app.sessionDestinations).toEqual([])
    expect(app.sessionDestinationError).toBe('admin_token_required')
    expect(app.render).toHaveBeenCalledTimes(2)
  })
  test('renders selection, future flag, escaped names and write-only secrets', () => {
    const html = renderSessionWebhooks([{ id: 'test', name: '<script>', url: 'https://example.com', server: 'server_1', enabled: true,
      session_ids: ['5511999999999'], auto_include_new_sessions: true, events: ['session.connected'], heartbeat_interval_seconds: 300,
      has_bearer_token: true, has_signing_secret: true }], [{ phone: '5511999999999', provider: 'zapo', server: 'server_1', label: '<img>' }], 'test')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('name="auto_include_new_sessions" checked')
    expect(html).toContain('value="5511999999999" checked')
    expect(html).toContain('type="password"')
    expect(renderSessionWebhooks([], [])).toContain('Nenhum destino')
  })
  test('serializes explicit membership and omits unchanged secrets', () => {
    const form = new FormData()
    form.set('name', 'Chat')
    form.set('url', 'https://chat.example.com')
    form.set('server', 'server_1')
    form.set('enabled', 'on')
    form.append('session_ids', '5511999999999')
    form.append('events', 'session.connected')
    expect(sessionDestinationPayload(form)).toEqual({ name: 'Chat', url: 'https://chat.example.com', server: 'server_1', enabled: true,
      auto_include_new_sessions: false, session_ids: ['5511999999999'], events: ['session.connected'], heartbeat_interval_seconds: 300 })
    form.set('bearer_token', 'token'); form.set('signing_secret', 'secret')
    expect(sessionDestinationPayload(form)).toEqual(expect.objectContaining({ bearer_token: 'token', signing_secret: 'secret' }))
    form.set('clear_bearer_token', 'on')
    expect(sessionDestinationPayload(form).bearer_token).toBe('')
  })
  test('API uses existing authenticated transport for CRUD and encodes IDs', async () => {
    const fetcher = jest.fn().mockImplementation(async () => new Response('{}', { status: 200 }))
    const api = new ApiClient('https://uno.example.com', fetcher)
    api.setToken('global-token')
    await api.sessionDestinations()
    await api.saveSessionDestination({ name: 'chat' })
    await api.saveSessionDestination({ name: 'chat' }, 'a/b')
    await api.deleteSessionDestination('a/b')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://uno.example.com/admin/session-webhooks', 'https://uno.example.com/admin/session-webhooks',
      'https://uno.example.com/admin/session-webhooks/a%2Fb', 'https://uno.example.com/admin/session-webhooks/a%2Fb',
    ])
    expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual([undefined, 'POST', 'PUT', 'DELETE'])
    expect(fetcher.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer global-token')
  })
})
