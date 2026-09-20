import { ApiClient, ApiError } from '../../frontend/core/api'
import { ManagerPage, managerIdentity } from '../../frontend/features/manager'
import { renderLayout, renderLogin } from '../../frontend/components/layout'
import { icon } from '../../frontend/components/icons'
import { renderDashboard } from '../../frontend/pages/dashboard'
import { renderSessionPage } from '../../frontend/pages/session'
import { renderSessionConfig, sessionConfigPayload } from '../../frontend/features/session_config'
import { renderScopedVoip } from '../../frontend/pages/voip_scoped'
import { ViperConnectApp } from '../../frontend/app'
import type { ManagerIdentity } from '../../frontend/domain/manager_types'
import type { VoipBootstrap } from '../../frontend/domain/types'

const identity: ManagerIdentity = { id: 'u1', name: 'Maria', username: 'maria', role: 'user' }
const user = { ...identity, active: true, phones: ['55119999'] }
const key = { id: 'k1', name: 'CRM <demo>', prefix: 'mgr_key_abc', created_at: '2026-09-20', expires_at: '2026-10-20', last_used_at: null, revoked: false }
const form = (values: Record<string, string>) => {
  const data = new FormData()
  Object.entries(values).forEach(([key, value]) => data.set(key, value))
  return data
}
const setup = () => {
  const api = { request: jest.fn(), getToken: () => 'mgr_login_test' }
  const page = new ManagerPage(api as unknown as ApiClient, jest.fn())
  return { api, page }
}
const layout = (role: 'admin' | 'user', canManageAccount = true) => renderLayout({ content: '', identity: { ...identity, role }, canManageAccount,
  collapsed: false, mobileOpen: false, versionStatus: { installed_version: '', update_available: false, status: 'unknown', checked_at: '' } })
const click = (action: string, extra: Record<string, string> = {}) => ({ target: {
  closest: (selector: string) => selector === '[data-action]' ? { dataset: { action, ...extra }, setAttribute: jest.fn(), removeAttribute: jest.fn() } : null,
  matches: () => false,
} })

describe('Manager identity and access', () => {
  test('loads identity and limits legacy fallback to 401 and non-manager tokens', async () => {
    const api = new ApiClient('', jest.fn().mockResolvedValue(new Response(JSON.stringify({ user: identity }))))
    api.setToken('mgr_login_test')
    await expect(managerIdentity(api)).resolves.toEqual(identity)
    for (const status of [401, 403, 404, 500]) for (const token of ['old-session', 'mgr_login_test', 'mgr_key_test']) {
      const client = new ApiClient('', jest.fn().mockResolvedValue(new Response('{}', { status })))
      client.setToken(token)
      if (status === 401 && token === 'old-session') await expect(managerIdentity(client)).resolves.toBeNull()
      else await expect(managerIdentity(client)).rejects.toBeInstanceOf(ApiError)
    }
  })

  test('drops an in-flight response after logout, even when the same token is reused', async () => {
    let finish!: (value: Response) => void
    const client = new ApiClient('', jest.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    client.setToken('one')
    const pending = client.request('/manager/keys')
    client.setToken('')
    client.setToken('one')
    finish(new Response(JSON.stringify({ keys: [key] })))
    await expect(pending).rejects.toThrow('Requisição descartada')
  })

  test('shows users below session webhooks for admin, scoped phone and account for user', () => {
    const admin = layout('admin')
    expect(admin).toContain(`${icon('users')}<span>Usuários</span>`)
    expect(admin).toContain('<span>Webhook</span>')
    expect(admin).not.toContain('Webhooks de sessões')
    expect(admin.indexOf('data-action="open-users"')).toBeGreaterThan(admin.indexOf('data-action="open-session-webhooks"'))
    expect(admin).not.toContain('data-action="open-account"')
    const regular = layout('user')
    for (const action of ['open-users', 'open-redis', 'open-queues', 'open-session-webhooks']) expect(regular).not.toContain(`data-action="${action}"`)
    expect(regular).toContain('data-action="open-voip"')
    expect(regular).toContain('data-action="open-account"')
    expect(layout('user', false)).not.toContain('data-action="open-account"')
    expect(renderLogin()).toContain('name="username"')
    expect(renderLogin()).toContain('name="password"')
    expect(renderLogin()).toContain('data-form="legacy-login"')
  })

  test.each(['open-users', 'open-queues', 'open-redis', 'open-session-webhooks', 'new-session', 'new-voip-resource', 'play-voip-recording', 'end-voip-call'])(
    'rejects forged user action %s', async action => {
      const app = Object.create(ViperConnectApp.prototype) as any
      app.identity = identity
      app.render = jest.fn()
      await app.handleClick(click(action))
      expect(app.render).not.toHaveBeenCalled()
    })

  test('hides forbidden config values and removes them even from a forged form', () => {
    const session = { phone: '5511', authToken: 'secret-stack', proxyUrl: 'private-proxy' }
    const html = renderSessionConfig(session, true)
    expect(html).not.toContain('secret-stack')
    expect(html).not.toContain('private-proxy')
    const payload = sessionConfigPayload(form({ authToken: 'secret', proxyUrl: 'proxy', storage: 'x', baseStore: 'y', getStore: 'z', label: 'Minha sessão' }), true)
    for (const field of ['authToken', 'proxyUrl', 'storage', 'baseStore', 'getStore']) expect(payload).not.toHaveProperty(field)
    expect(payload.label).toBe('Minha sessão')
  })

  test('allows assigned disconnected numbers to reconnect without an initial detail GET', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.sessions = [{ phone: '5511', status: 'disconnected' }]
    app.api = { register: jest.fn().mockResolvedValue({}), session: jest.fn() }
    app.watchConnection = jest.fn()
    app.render = jest.fn()
    await app.openConnection('5511')
    expect(app.api.register).toHaveBeenCalledWith('5511')
    expect(app.api.session).not.toHaveBeenCalled()
    await app.openConnection('5522')
    expect(app.api.register).toHaveBeenCalledTimes(1)
    const html = renderDashboard({ sessions: app.sessions, query: '', status: 'all', loading: false, refreshIn: 15, visibleLimit: 20, canCreate: false })
    expect(html).not.toContain('data-action="new-session"')
    expect(html).toContain('data-action="connect-session"')
  })
})

describe('Manager users and transfers', () => {
  test('suggests existing labeled sessions and owners while accepting an absent phone', async () => {
    const { page, api } = setup()
    page.users = [user]
    page.knownPhones = [{ phone: '55119999', label: 'Loja <Centro>' }, { phone: '5522', label: 'Filial' }]
    page.assignments.assignments = { '55119999': user.id }
    page.focusAssignment('55119999')
    const html = page.renderPage(true)
    expect(html).toContain('list="manager-known-phones"')
    expect(html).toContain('value="55119999" label="Loja &lt;Centro&gt; — Maria"')
    expect(html).toContain('value="5522" label="Filial — Sem responsável"')
    expect(html).toContain('value="55119999" required')
    await page.form('manager-assign', form({ phone: '553333', user_id: user.id }), true)
    expect(page.pending).toEqual({ phone: '553333', owner: null, target: user.id })
    expect(api.request).not.toHaveBeenCalled()
    page.reset()
    expect(page.knownPhones).toEqual([])
    expect(page.assignmentPhone).toBe('')
  })

  test('admin session detail offers assignment shortcut; ordinary users do not', () => {
    const options = { session: { phone: '5511' }, tab: 'overview' as const, contacts: [], contactsHasMore: false, contactCount: 0, contactsQuery: '', groups: [], groupsHasMore: false, groupsQuery: '', loadingSection: false, sectionError: '' }
    expect(renderSessionPage({ ...options, canManageUsers: true })).toContain('data-action="open-users" data-phone="5511"')
    expect(renderSessionPage(options)).not.toContain('data-action="open-users"')
  })

  test('opening Users populates datalist options from App.sessions', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    const { page, api } = setup()
    app.identity = { ...identity, role: 'admin' }
    app.api = api
    app.manager = page
    app.sessions = [{ phone: '55119999', label: 'Loja Centro' }]
    api.request.mockResolvedValueOnce({ users: [user] }).mockResolvedValueOnce({ assignments: { '55119999': user.id }, history: [] })
    await app.handleClick(click('open-users', { phone: '55119999' }))
    expect(page.knownPhones).toEqual([{ phone: '55119999', label: 'Loja Centro' }])
    expect(page.assignmentPhone).toBe('55119999')
    expect(page.selected).toBe(user.id)
    expect(page.tab).toBe('Sessões')
  })
  test('renders data/session/history tabs with escaping, edits and revokes keys', async () => {
    const { page, api } = setup()
    page.users = [{ ...user, name: '<script>Maria</script>' }]
    await page.action('manager-select', user.id, true)
    expect(page.renderPage(true)).toContain('&lt;script&gt;Maria&lt;/script&gt;')
    expect(page.renderPage(true)).toContain('Redefinir senha')
    expect(page.renderPage(true)).toContain('manager-revoke-all')
    await page.action('manager-tab', 'Sessões', true)
    expect(page.renderPage(true)).toContain('inclusive desconectado')
    page.assignments.history = [{ phone: '5511', from: null, to: user.id, at: '2026-09-20', actor: 'admin' }]
    await page.action('manager-tab', 'Histórico', true)
    expect(page.renderPage(true)).toContain('5511')
    api.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ users: [user] })
    await page.form('manager-edit', form({ name: 'Maria', password: 'new-password' }), true)
    expect(api.request.mock.calls[0]).toEqual(['/manager/users/u1', { method: 'PATCH', body: JSON.stringify({ name: 'Maria', active: false, password: 'new-password' }) }])
  })

  test('requires explicit transfer confirmation, uses expected owner and handles 409', async () => {
    const { page, api } = setup()
    page.users = [user]
    page.assignments.assignments['5511'] = 'previous'
    await page.form('manager-assign', form({ phone: '+55 11', user_id: user.id }), true)
    expect(api.request).not.toHaveBeenCalled()
    expect(page.renderConfirmation()).toContain('role="dialog"')
    expect(page.pending).toEqual({ phone: '5511', owner: 'previous', target: 'u1' })
    api.request.mockRejectedValueOnce(new ApiError(409, 'changed', { current_owner: 'someone-else' }))
      .mockResolvedValueOnce({ users: [user] }).mockResolvedValueOnce({ assignments: { '5511': 'someone-else' }, history: [] })
    await page.action('manager-confirm', '', true)
    expect(api.request.mock.calls[0]).toEqual(['/manager/assignments/5511', { method: 'PUT', body: JSON.stringify({ user_id: 'u1', expected_owner: 'previous' }) }])
    expect(page.pending).toBeUndefined()
    expect(page.error).toContain('someone-else')
    await page.form('manager-assign', form({ phone: '5511', user_id: '' }), true)
    expect(page.pending).toEqual({ phone: '5511', owner: 'someone-else', target: null })
  })

  test('transfer modal stays open on backdrop and closes only explicitly', async () => {
    const { page } = setup()
    page.pending = { phone: '5511', owner: null, target: 'u1' }
    const app = Object.create(ViperConnectApp.prototype) as any
    app.manager = page
    app.closeModal = jest.fn()
    app.render = jest.fn()
    await app.handleClick({ target: { closest: () => null, matches: () => true } })
    expect(page.pending).toBeDefined()
    expect(app.closeModal).not.toHaveBeenCalled()
    await app.handleClick({ target: { closest: (selector: string) => selector === '[data-close-modal]' ? {} : null } })
    expect(page.pending).toBeUndefined()
  })
})

describe('Manager account keys', () => {
  test('renders active/revoked key rows and never derives the full token from listing', async () => {
    const { page, api } = setup()
    api.request.mockResolvedValue({ keys: [key, { ...key, id: 'k2', revoked: true, name: 'Revogada', last_used_at: '2026-09-21' }] })
    await page.load(false)
    const html = page.renderPage(false)
    expect(html).toContain('CRM &lt;demo&gt;')
    expect(html).toContain('mgr_key_abc')
    expect(html).toContain('2026-10-20')
    expect(html).toContain('2026-09-21')
    expect(html).toContain('Nunca')
    expect(html.match(/data-action="manager-revoke"/g)).toHaveLength(1)
    expect(html).not.toContain('data-action="manager-copy-key"')
  })

  test('shows new key once, copies explicitly, clears on dismissal/navigation and revokes', async () => {
    const { page, api } = setup()
    const writeText = jest.fn().mockResolvedValue(undefined)
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
    try {
      api.request.mockResolvedValueOnce({ token: 'mgr_key_FULL_SECRET', key })
      await page.form('manager-key', form({ name: 'CRM', days: '30' }), false)
      expect(page.renderPage(false)).toContain('mgr_key_FULL_SECRET')
      await page.action('manager-copy-key', '', false)
      expect(writeText).toHaveBeenCalledWith('mgr_key_FULL_SECRET')
      await page.action('manager-hide-key', '', false)
      expect(page.renderPage(false)).not.toContain('mgr_key_FULL_SECRET')
      api.request.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ keys: [] })
      await page.action('manager-revoke', key.id, false)
      expect(api.request).toHaveBeenCalledWith('/manager/keys/k1', { method: 'DELETE' })
      page.secret = 'other-secret'
      page.reset()
      expect(page.secret).toBe('')
      expect(page.keys).toEqual([])
    } finally {
      if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator)
      else Reflect.deleteProperty(globalThis, 'navigator')
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test('does not generate duplicate keys during a pending request and validates days', async () => {
    const { page, api } = setup()
    let finish!: (value: unknown) => void
    api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = page.form('manager-key', form({ name: 'CRM' }), false)
    await page.form('manager-key', form({ name: 'CRM' }), false)
    expect(api.request).toHaveBeenCalledTimes(1)
    finish({ token: 'secret', key })
    await first
    await page.form('manager-key', form({ name: 'CRM', days: '-1' }), false)
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(page.error).toContain('inteiro positivo')
  })

  test('does not restore a one-time secret after navigating away during generation', async () => {
    const { page, api } = setup()
    let finish!: (value: unknown) => void
    api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = page.form('manager-key', form({ name: 'CRM' }), false)
    page.reset()
    finish({ token: 'must-not-reappear', key })
    await pending
    expect(page.secret).toBe('')
    expect(page.keys).toEqual([])
    expect(page.busy).toBe(false)
  })

  test('app password success logs out explicitly and renders a reauthentication message', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.identity = identity
    app.api = { getToken: () => 'mgr_login_test' }
    app.manager = { form: jest.fn().mockResolvedValue(undefined), passwordChanged: true }
    app.logout = jest.fn()
    app.render = jest.fn()
    const oldFormClass = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
    const oldFormData = globalThis.FormData
    class FakeForm { dataset = { form: 'manager-password' } }
    Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: FakeForm })
    const data = form({ current_password: 'old', password: 'new' })
    globalThis.FormData = jest.fn(() => data) as unknown as typeof FormData
    try {
      await app.handleSubmit({ target: new FakeForm(), preventDefault: jest.fn() })
      expect(app.logout).toHaveBeenCalledWith(false)
      expect(app.loginError).toContain('Entre novamente com a nova senha')
      expect(app.render).toHaveBeenCalled()
    } finally {
      globalThis.FormData = oldFormData
      if (oldFormClass) Object.defineProperty(globalThis, 'HTMLFormElement', oldFormClass)
      else Reflect.deleteProperty(globalThis, 'HTMLFormElement')
    }
  })

  test('app logout clears secrets, account data, sockets, timers and both token stores', () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    const { page } = setup()
    page.secret = 'one-time'
    page.keys = [key]
    Object.assign(app, {
      identity, manager: page, api: { setToken: jest.fn(), request: jest.fn().mockResolvedValue(undefined) },
      socket: { clear: jest.fn() }, contactPictures: { clear: jest.fn() }, render: jest.fn(),
      redisExpandedPrefixes: new Set(['private']), redisSearchCollapsedPrefixes: new Set(['private']),
      voipRecordingUrls: {}, voipTransferAudioUrls: {}, webhookHistoryRequest: 1,
      refreshTimer: 1, versionTimer: 2, sessions: [{ phone: '5511' }], contacts: { items: [{ name: 'private' }] },
      selectedPhone: '5511', queues: ['private'], redisKeys: ['secret'],
    })
    const descriptors = ['window', 'localStorage', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
    const local = { removeItem: jest.fn() }
    const session = { removeItem: jest.fn() }
    const clearInterval = jest.fn()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { clearInterval, clearTimeout: jest.fn() } })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session })
    try {
      app.logout()
      expect(app.api.request).toHaveBeenCalledWith('/manager/logout', { method: 'POST' })
      expect(app.api.setToken).toHaveBeenCalledWith('')
      expect(local.removeItem).toHaveBeenCalledWith('whatsappApiToken')
      expect(session.removeItem).toHaveBeenCalledWith('whatsappApiToken')
      expect(app.identity).toBeNull()
      expect(app.sessions).toEqual([])
      expect(app.contacts.items).toEqual([])
      expect(app.queues).toEqual([])
      expect(app.redisKeys).toEqual([])
      expect(page.secret).toBe('')
      expect(page.keys).toEqual([])
      expect(app.socket.clear).toHaveBeenCalled()
      expect(clearInterval).toHaveBeenCalledTimes(2)
    } finally {
      descriptors.forEach(([name, descriptor]) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      })
    }
  })

  test('password changes require the current password and mark login invalidated', async () => {
    const { page, api } = setup()
    api.request.mockResolvedValue(undefined)
    await page.form('manager-password', form({ current_password: 'old-password', password: 'new-password' }), false)
    expect(api.request).toHaveBeenCalledWith('/manager/password', { method: 'POST', body: JSON.stringify({ current_password: 'old-password', password: 'new-password' }) })
    expect(page.passwordChanged).toBe(true)
  })
})

describe('Scoped VoIP', () => {
  const state: VoipBootstrap = { bridges: [], calls: [{ callId: 'call-1', session: '5511', direction: 'incoming' }],
    capabilities: { activeCalls: true, callCommands: true, createCalls: false, history: false, recordings: false, configuration: false } }
  test('renders only active calls and approved commands, fail closed without capabilities', () => {
    const html = renderScopedVoip(state, false, '')
    for (const command of ['accept', 'reject', 'end', 'mute']) expect(html).toContain(`data-command="${command}"`)
    for (const forbidden of ['voip-call', 'voip-transfer', 'recording', 'voip-resource', 'voip-history']) expect(html).not.toContain(forbidden)
    expect(renderScopedVoip({ ...state, capabilities: undefined }, false, '')).not.toContain('call-1')
    expect(renderScopedVoip({ ...state, capabilities: { ...state.capabilities!, callCommands: false } }, false, '')).not.toContain('data-command=')
  })
  test('dispatches mute with the assigned session and rejects unknown calls', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.identity = identity
    app.voip = state
    app.api = { voipCommand: jest.fn().mockResolvedValue({}) }
    app.loadVoip = jest.fn()
    await app.handleClick(click('scoped-voip-command', { command: 'mute', session: '5511', callId: 'call-1' }))
    expect(app.api.voipCommand).toHaveBeenCalledWith('5511', 'call-1', 'mute', { muted: true })
    await app.handleClick(click('scoped-voip-command', { command: 'end', session: 'other', callId: 'call-1' }))
    expect(app.api.voipCommand).toHaveBeenCalledTimes(1)
  })
})
