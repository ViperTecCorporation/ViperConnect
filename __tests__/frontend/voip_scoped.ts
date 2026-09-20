import { ViperConnectApp } from '../../frontend/app'
import { renderScopedVoip, scopedExtensions, scopedRegistrations } from '../../frontend/pages/voip_scoped'
import { renderVoipCredentialsModal } from '../../frontend/pages/voip'
import type { VoipBootstrap } from '../../frontend/domain/types'

const bootstrap = (): VoipBootstrap => ({
  bridges: [], calls: [],
  capabilities: { activeCalls: true, callCommands: true, createCalls: false, history: false, recordings: false, configuration: false,
    automaticLines: true, automaticExtensions: true, extensionCredentials: true, extensionRegistrations: true },
  zapoLines: [{ session: '5511', sourceId: 'worker', connected: true, automatic: {
    extensionId: 'owned', username: 'automatic-5511', status: 'active', registrationCount: 1, freeRegistrationCount: 1,
    busyRegistrationCount: 0, transports: ['webrtc'], basicInboundEnabled: true,
  } }],
  extensions: [{ id: 'owned', displayName: 'Minha <linha>', enabled: true }, { id: 'foreign', displayName: 'Outra empresa' }],
  registrations: { webrtc: [{ id: 'owned', registrationId: 'browser/1', userAgent: '<Browser>' }, { id: 'foreign', registrationId: 'private' }],
    sipRtp: [{ id: 'owned', registrationId: 'sip/1' }, { username: 'automatic-5511', registrationId: 'ambiguous' }] },
})
const event = (action: string, data: Record<string, string>) => ({ target: {
  closest: (selector: string) => selector === '[data-action]' ? { dataset: { action, ...data } } : null,
  matches: () => false,
} })
const appSetup = () => {
  const app = Object.create(ViperConnectApp.prototype) as any
  app.identity = { role: 'user' }
  app.voip = bootstrap()
  app.api = { voipConsole: jest.fn().mockResolvedValue({ username: 'automatic-5511', password: 'secret' }) }
  app.render = jest.fn()
  app.showToast = jest.fn()
  app.loadVoip = jest.fn()
  return app
}

const submit = async (app: any, values: Record<string, string>, name = 'voip-sip-mode') => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
  const OriginalFormData = globalThis.FormData
  class FakeForm { dataset = { form: name } }
  const data = new OriginalFormData()
  Object.entries(values).forEach(([key, value]) => data.set(key, value))
  Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: FakeForm })
  globalThis.FormData = jest.fn(() => data) as unknown as typeof FormData
  app.beginSubmitFeedback = jest.fn(() => jest.fn())
  try { await app.handleSubmit({ target: new FakeForm(), preventDefault: jest.fn() }) }
  finally {
    globalThis.FormData = OriginalFormData
    if (descriptor) Object.defineProperty(globalThis, 'HTMLFormElement', descriptor)
    else Reflect.deleteProperty(globalThis, 'HTMLFormElement')
  }
}

describe('scoped SIP endpoint mode', () => {
  test('renders mode form only with capability and current owned extension', () => {
    const app = appSetup()
    app.modal = { type: 'voip-credentials', value: { extensionId: 'owned', sipEndpointMode: 'trunk' } }
    expect(app.renderModal()).not.toContain('data-form="voip-sip-mode"')
    app.voip.capabilities.extensionSipMode = true
    expect(app.renderModal()).toContain('data-form="voip-sip-mode"')
    expect(app.renderModal()).toContain('value="trunk" checked')
    expect(app.renderModal()).not.toContain('data-form="voip-resource')
    app.modal.value.extensionId = 'foreign'
    expect(app.renderModal()).not.toContain('data-form="voip-sip-mode"')
  })

  test('changes extension to trunk and back using strict payload, then reloads state', async () => {
    const app = appSetup()
    app.voip.capabilities.extensionSipMode = true
    for (const mode of ['trunk', 'extension']) {
      app.modal = { type: 'voip-credentials', value: { extensionId: 'owned', sipEndpointMode: mode === 'trunk' ? 'extension' : 'trunk' } }
      app.api.voipConsole.mockResolvedValueOnce({ extensionId: 'owned', sipEndpointMode: mode })
      await submit(app, { extensionId: 'owned', sipEndpointMode: mode, password: 'must-not-send', enabled: 'true' })
      expect(app.api.voipConsole).toHaveBeenLastCalledWith('extensions/owned/sip-mode', 'PUT', { sipEndpointMode: mode })
      expect(app.modal).toBeUndefined()
    }
    expect(app.api.voipConsole).toHaveBeenCalledTimes(2)
    expect(app.loadVoip).toHaveBeenCalledTimes(2)
  })

  test.each(['false', 'missing', 'foreign', 'unlinked', 'wrong-modal', 'invalid-mode'])(
    'blocks %s without making a request', async reason => {
      const app = appSetup()
      app.voip.capabilities.extensionSipMode = true
      app.modal = { type: 'voip-credentials', value: { extensionId: 'owned' } }
      if (reason === 'false') app.voip.capabilities.extensionSipMode = false
      if (reason === 'missing') delete app.voip.capabilities.extensionSipMode
      if (reason === 'unlinked') app.voip.zapoLines = []
      if (reason === 'wrong-modal') app.modal.value.extensionId = 'another'
      await submit(app, { extensionId: reason === 'foreign' ? 'foreign' : 'owned', sipEndpointMode: reason === 'invalid-mode' ? 'invalid' : 'trunk' })
      expect(app.api.voipConsole).not.toHaveBeenCalled()
    })

  test.each(['voip-resource-fields', 'voip-console-json', 'voip-recording-settings', 'voip-sip-mode-extra'])(
    'does not authorize other global form %s', async name => {
      const app = appSetup()
      app.voip.capabilities.extensionSipMode = true
      app.modal = { type: 'voip-credentials', value: { extensionId: 'owned' } }
      await submit(app, { extensionId: 'owned', sipEndpointMode: 'trunk' }, name)
      expect(app.api.voipConsole).not.toHaveBeenCalled()
    })
})

describe('scoped automatic telephony resources', () => {
  test('supports final backend lines/sip contract and explicit disconnect denial', async () => {
    const app = appSetup()
    delete app.voip.capabilities.automaticLines
    app.voip.capabilities.lines = true
    app.voip.capabilities.disconnectRegistration = false
    const html = renderScopedVoip(app.voip, false, '')
    expect(html).toContain('Minhas linhas')
    expect(html).not.toContain('data-action="drop-voip-registration"')
    await app.handleClick(event('drop-voip-registration', { extensionId: 'owned', registrationId: 'browser/1', registrationType: 'webrtc' }))
    expect(app.api.voipConsole).not.toHaveBeenCalled()
    const modal = renderVoipCredentialsModal({ sip: { domain: 'sip.example', publicWsUrl: 'wss://sip.example/ws', lanDomain: 'sip.internal' } }, true)
    expect(modal).toContain('wss://sip.example/ws')
    expect(modal).toContain('sip.internal')
    expect(modal).not.toContain('voip-sip-mode')
  })
  test('renders linked automatic lines/extensions/registrations only and hides configuration', () => {
    const state = bootstrap()
    expect(scopedExtensions(state).map(row => row.id)).toEqual(['owned'])
    expect(scopedRegistrations(state).map(row => row.registrationId)).toEqual(['browser/1', 'sip/1'])
    const html = renderScopedVoip(state, false, '')
    expect(html).toContain('Minhas linhas')
    expect(html).toContain('Minha &lt;linha&gt;')
    expect(html).toContain('data-id="owned"')
    expect(html).toContain('&lt;Browser&gt;')
    for (const text of ['foreign', 'Outra empresa', 'ambiguous', 'voip-sip-mode', 'voip-transfer', 'new-voip-resource', 'edit-voip-resource']) expect(html).not.toContain(text)
  })

  test.each(['automaticLines', 'automaticExtensions', 'extensionCredentials', 'extensionRegistrations'] as const)('honors %s capability independently', capability => {
    const state = bootstrap()
    state.capabilities![capability] = false
    const html = renderScopedVoip(state, false, '')
    const hidden = { automaticLines: 'Minhas linhas', automaticExtensions: 'Meus ramais automáticos', extensionCredentials: 'show-voip-credentials', extensionRegistrations: 'drop-voip-registration' }
    expect(html).not.toContain(hidden[capability])
  })

  test('missing capabilities fail closed even when resource arrays contain data', () => {
    const state = bootstrap()
    state.capabilities = undefined
    expect(scopedExtensions(state)).toEqual([])
    expect(scopedRegistrations(state)).toEqual([])
    expect(renderScopedVoip(state, false, '')).not.toContain('owned')
  })

  test('credentials use the existing endpoint; forged unowned IDs/capability are blocked', async () => {
    const app = appSetup()
    await app.handleClick(event('show-voip-credentials', { id: 'foreign' }))
    expect(app.api.voipConsole).not.toHaveBeenCalled()
    await app.handleClick(event('show-voip-credentials', { id: 'owned' }))
    expect(app.api.voipConsole).toHaveBeenCalledWith('extensions/owned/credentials')
    expect(app.modal.type).toBe('voip-credentials')
    expect(app.renderModal()).not.toContain('voip-sip-mode')
    app.voip.capabilities.extensionCredentials = false
    await app.handleClick(event('show-voip-credentials', { id: 'owned' }))
    expect(app.api.voipConsole).toHaveBeenCalledTimes(1)
  })

  test('restricted credential modal keeps copy/close but omits SIP configuration', async () => {
    const value = { username: 'u', password: '<secret>', sipUri: 'sip:u@example.com' }
    const html = renderVoipCredentialsModal(value, true)
    expect(html).toContain('&lt;secret&gt;')
    expect(html).toContain('data-action="copy-value"')
    expect(html).toContain('data-close-modal')
    expect(html).not.toContain('voip-sip-mode')
    expect(renderVoipCredentialsModal(value)).toContain('voip-sip-mode')
    const app = appSetup()
    app.modal = { type: 'voip-credentials', value }
    app.closeModal = jest.fn()
    await app.handleClick({ target: { closest: () => null, matches: () => true } })
    expect(app.closeModal).not.toHaveBeenCalled()
    await app.handleClick({ target: { closest: (selector: string) => selector === '[data-close-modal]' ? {} : null } })
    expect(app.closeModal).toHaveBeenCalledTimes(1)
  })

  test('registration disconnect needs an exact owned row and supported transport, then confirmation', async () => {
    const app = appSetup()
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const confirm = jest.fn().mockReturnValue(true)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm } })
    try {
      const row = { extensionId: 'owned', registrationId: 'browser/1', registrationType: 'webrtc' }
      await app.handleClick(event('drop-voip-registration', { ...row, extensionId: 'foreign' }))
      await app.handleClick(event('drop-voip-registration', { ...row, registrationType: 'sip_rtp' }))
      expect(confirm).not.toHaveBeenCalled()
      expect(app.api.voipConsole).not.toHaveBeenCalled()
      await app.handleClick(event('drop-voip-registration', row))
      expect(app.api.voipConsole).toHaveBeenCalledWith('extensions/owned/registrations/browser%2F1?type=webrtc', 'DELETE')
      app.voip.capabilities.extensionRegistrations = false
      await app.handleClick(event('drop-voip-registration', row))
      expect(app.api.voipConsole).toHaveBeenCalledTimes(1)
    } finally {
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
})
