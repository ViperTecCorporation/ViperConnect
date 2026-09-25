import { MobileDevicesPanel } from '../../frontend/features/mobile_devices'
import { ApiClient, ApiError } from '../../frontend/core/api'
import { renderDashboard } from '../../frontend/pages/dashboard'

const draft = { id: '00000000-0000-0000-0000-000000000001', phone: '5511999999999', name: '<img src=x onerror=alert(1)>', platform: 'android' as const, accountType: 'personal' as const, state: 'draft' as const, connectionMode: 'mobile_primary' as const, createdAt: '2026-09-22' }
const setup = () => {
  const api = { request: jest.fn() }
  const render = jest.fn()
  return { api, render, panel: new MobileDevicesPanel(api as unknown as ApiClient, render) }
}
const form = (values: Record<string, string>) => {
  const data = new FormData()
  Object.entries(values).forEach(([key, value]) => data.set(key, value))
  return data
}
describe('experimental mobile devices panel', () => {
  test('registered device connects only with explicit confirmation and reports worker request', async () => {
    const { panel, api } = setup(); panel.enabled = true; panel.selected = draft; panel.smsRegistration = true
    panel.registration = { status: 'registered' }
    expect(panel.renderRegistration()).toContain('Conectar à Zapo')
    await panel.submit('mobile-connect', form({})); expect(api.request).not.toHaveBeenCalled()
    api.request.mockResolvedValueOnce({ status: 'connection_requested', phone: draft.phone, imported: true })
    await panel.submit('mobile-connect', form({ confirmConnection: 'on' }))
    expect(api.request).toHaveBeenLastCalledWith(expect.stringContaining('/connection'), { method: 'POST', body: '{"confirm":true}' })
    expect(panel.renderRegistration()).toContain('Conexão solicitada ao worker')
    api.request.mockResolvedValueOnce({ status: 'online', phone: draft.phone, imported: true })
    await panel.connectionOperation(false)
    expect(panel.renderRegistration()).toContain('Conectado à Zapo')
  })
  test('missing-code resend unlocks after remote wait and still needs consent', async () => {
    jest.useFakeTimers(); jest.setSystemTime(100000)
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.devices = [draft]
    try {
      api.request.mockResolvedValueOnce({ status: 'code_required', retryAt: 102000, canResendSms: false })
      panel.action('mobile-details', draft.id); await Promise.resolve(); await Promise.resolve()
      expect(panel.renderRegistration()).toContain('name="code"')
      expect(panel.renderRegistration()).not.toContain('data-form="mobile-sms"')
      api.request.mockResolvedValueOnce({ status: 'code_required', canResendSms: true })
      await jest.advanceTimersByTimeAsync(2000)
      expect(panel.renderRegistration()).toContain('Não recebi o código — solicitar novo SMS')
      await panel.submit('mobile-sms', form({}))
      expect(api.request).toHaveBeenCalledTimes(2)
      api.request.mockResolvedValueOnce({ status: 'code_required', retryAt: 222000, canResendSms: false })
      await panel.submit('mobile-sms', form({ confirmSms: 'on' }))
      expect(api.request).toHaveBeenLastCalledWith(expect.stringContaining('/request'), expect.objectContaining({ body: '{"confirm":true,"confirmResend":true}' }))
      expect(panel.renderRegistration()).toContain('name="code"')
    } finally { panel.reset(); jest.useRealTimers() }
  })
  test('read-only status refresh preserves a typed code without retaining it in panel state', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const input = { value: '012345' }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => input } })
    const { panel, api, render } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.selected = draft; panel.registration = { status: 'code_required' }
    try {
      render.mockImplementation(() => { input.value = '' })
      api.request.mockResolvedValue({ status: 'code_required', canResendSms: true })
      await panel.refreshRegistration()
      expect(input.value).toBe('012345')
      expect(JSON.stringify(panel)).not.toContain('012345')
    } finally {
      panel.reset()
      if (original) Object.defineProperty(globalThis, 'document', original); else delete (globalThis as any).document
    }
  })
  test('countdown performs one GET on expiry; SMS and verification require explicit submission', async () => {
    jest.useFakeTimers(); jest.setSystemTime(100000)
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.devices = [draft]
    try {
      api.request.mockResolvedValueOnce({ status: 'blocked', retryAt: 102000, canResendSms: false, diagnostic: { stage: 'request', reason: 'rate_limited', providerReason: 'too_recent' } })
      panel.action('mobile-details', draft.id)
      await Promise.resolve(); await Promise.resolve()
      expect(panel.renderRegistration()).toContain('00:00:02')
      await panel.submit('mobile-sms', form({ confirmSms: 'on' }))
      expect(api.request).toHaveBeenCalledTimes(1)
      api.request.mockResolvedValueOnce({ status: 'blocked', canResendSms: true })
      await jest.advanceTimersByTimeAsync(2000)
      expect(api.request).toHaveBeenCalledTimes(2)
      expect(api.request.mock.calls.every(call => call.length === 1)).toBe(true)
      expect(panel.renderRegistration()).toContain('Solicitar novo SMS')
      expect(jest.getTimerCount()).toBe(0)
      api.request.mockResolvedValueOnce({ status: 'code_required' })
      await panel.submit('mobile-sms', form({ confirmSms: 'on' }))
      expect(panel.renderRegistration()).toContain('name="code"')
      api.request.mockResolvedValueOnce({ status: 'registered' })
      await panel.submit('mobile-verify', form({ code: '123456' }))
      expect(api.request).toHaveBeenCalledTimes(4)
      expect(panel.renderRegistration()).not.toContain('name="code"')
    } finally { panel.reset(); jest.useRealTimers() }
  })
  test.each(['mobile-close', 'reset'])('countdown stops on %s', async action => {
    jest.useFakeTimers(); jest.setSystemTime(100000)
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.devices = [draft]
    try {
      api.request.mockResolvedValue({ status: 'blocked', retryAt: 102000, canResendSms: false })
      panel.action('mobile-details', draft.id); await Promise.resolve(); await Promise.resolve()
      expect(jest.getTimerCount()).toBe(1)
      if (action === 'reset') panel.reset(); else panel.action(action)
      await jest.advanceTimersByTimeAsync(4000)
      expect(api.request).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
    } finally { panel.reset(); jest.useRealTimers() }
  })
  test('failed expiry GET does not loop or enable sending', async () => {
    jest.useFakeTimers(); jest.setSystemTime(100000)
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.devices = [draft]
    try {
      api.request.mockResolvedValueOnce({ status: 'blocked', retryAt: 101000, canResendSms: false }).mockRejectedValueOnce(new Error('offline'))
      panel.action('mobile-details', draft.id); await Promise.resolve(); await Promise.resolve()
      await jest.advanceTimersByTimeAsync(10000)
      expect(api.request).toHaveBeenCalledTimes(2)
      expect(panel.registration?.canResendSms).toBe(false)
      expect(jest.getTimerCount()).toBe(0)
    } finally { panel.reset(); jest.useRealTimers() }
  })
  test('displays remote wait or unknown deadline without sending SMS', () => {
    const { panel, api } = setup(); panel.smsRegistration = true
    panel.registration = { status: 'blocked', retryAt: 1800000000000, diagnostic: { stage: 'request', reason: 'rate_limited', waitSeconds: 7200 } }
    expect(panel.renderRegistration()).toContain('informada pelo provedor')
    delete panel.registration.diagnostic!.waitSeconds
    delete panel.registration.retryAt
    expect(panel.renderRegistration()).toContain('Prazo não informado pelo provedor')
    expect(panel.renderRegistration()).not.toContain('local de segurança')
    expect(api.request).not.toHaveBeenCalled()
  })
  test('additional confirmation explains unsupported actions without offering SMS or code submission', () => {
    const { panel, api } = setup(); panel.smsRegistration = true
    panel.registration = { status: 'additional_confirmation_required' }
    const html = panel.renderRegistration()
    expect(html).toContain('Confirmação adicional necessária')
    expect(html.match(/disabled/g)).toHaveLength(3)
    expect(html).not.toContain('data-form=')
    expect(html).toContain('estado local')
    expect(api.request).not.toHaveBeenCalled()
  })
  test('renders provider diagnostic codes with HTML escaping', () => {
    const { panel } = setup(); panel.smsRegistration = true
    panel.registration = { status: 'blocked', diagnostic: { stage: 'verify', reason: 'provider_response', providerStatus: 'fail', providerReason: '<script>', providerPending: 'test_pending' } }
    const html = panel.renderRegistration()
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
    expect(html).toContain('Pendência do provedor'); expect(html).not.toContain('name="code"')
  })
  test('resend requires explicit consent and sends confirmResend', async () => {
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.selected = draft
    panel.registration = { status: 'blocked', canResendSms: true }
    expect(panel.renderRegistration()).toContain('Solicitar novo SMS')
    await panel.submit('mobile-sms', form({}))
    expect(api.request).not.toHaveBeenCalled()
    api.request.mockResolvedValueOnce({ status: 'code_required', canResendSms: false })
    await panel.submit('mobile-sms', form({ confirmSms: 'on' }))
    expect(api.request).toHaveBeenLastCalledWith(expect.stringContaining('/request'), expect.objectContaining({ body: '{"confirm":true,"confirmResend":true}' }))
    expect(panel.renderRegistration()).not.toContain('Solicitar novo SMS')
  })
  test('recovery requires consent and warns about authorization on the current phone', async () => {
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.selected = draft
    panel.registration = { status: 'blocked', canRetryVerification: true, diagnostic: { stage: 'verify', reason: 'unknown' } }
    expect(panel.renderRegistration()).toContain('ainda não detecta automaticamente')
    await panel.submit('mobile-verify', form({ code: '012345' }))
    expect(api.request).not.toHaveBeenCalled()
    api.request.mockResolvedValueOnce({ status: 'blocked', canRetryVerification: false, diagnostic: { stage: 'verify', reason: 'code_expired' } })
    await panel.submit('mobile-verify', form({ code: '012345', confirmRecovery: 'on' }))
    expect(api.request).toHaveBeenLastCalledWith(expect.stringContaining('/verify'), expect.objectContaining({ body: '{"code":"012345","confirmRecovery":true}' }))
    expect(panel.renderRegistration()).toContain('Código expirado')
    expect(panel.renderRegistration()).not.toContain('name="code"')
    expect(panel.renderRegistration()).not.toContain('012345')
  })
  test('SMS capability gates all registration calls', async () => {
    const { panel, api } = setup(); panel.enabled = true; panel.selected = draft
    await panel.refreshRegistration(); await panel.submitRegistration('mobile-sms', form({ confirmSms: 'on' }))
    expect(api.request).not.toHaveBeenCalled()
    expect(panel.renderRegistration()).toContain('desativado')
  })
  test('registration status and consent lead to bounded explicit actions', async () => {
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.selected = draft
    api.request.mockResolvedValueOnce({ status: 'idle' })
    await panel.refreshRegistration(); expect(panel.renderRegistration()).toContain('confirmSms')
    await panel.submit('mobile-sms', form({})); expect(api.request).toHaveBeenCalledTimes(1)
    api.request.mockResolvedValueOnce({ status: 'code_required' })
    await panel.submit('mobile-sms', form({ confirmSms: 'on' }))
    expect(panel.renderRegistration()).toContain('Confirmar código')
    api.request.mockResolvedValueOnce({ status: 'registered', canonicalPhone: '999123456789' })
    await panel.submit('mobile-verify', form({ code: '012345' }))
    expect(api.request).toHaveBeenLastCalledWith(expect.stringContaining('/verify'), expect.objectContaining({ body: '{"code":"012345"}' }))
    expect(panel.renderRegistration()).toContain('conexão Zapo ainda não iniciada')
    expect(panel.renderRegistration()).not.toContain('012345')
  })
  test('unknown request result requires consultation and never resends automatically', async () => {
    const { panel, api } = setup(); panel.enabled = true; panel.smsRegistration = true; panel.selected = draft
    panel.registration = { status: 'idle' }
    api.request.mockRejectedValue(new Error('private upstream response'))
    await panel.submit('mobile-sms', form({ confirmSms: 'on' }))
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(panel.error).toContain('Consulte'); expect(panel.error).not.toContain('private')
  })
  test('does not expose UI before admin capability discovery', async () => {
    const { panel, api } = setup()
    expect(panel.renderButton()).toBe('')
    await panel.load(false)
    expect(api.request).not.toHaveBeenCalled()
    panel.action('mobile-new')
    expect(panel.renderDialog()).toBe('')
  })
  test('renders grid above sessions and escapes names', async () => {
    const { panel, api } = setup()
    api.request.mockResolvedValueOnce({ draftManagement: true }).mockResolvedValueOnce({ devices: [draft] })
    await panel.load(true)
    const grid = panel.renderGrid()
    expect(grid).toContain('&lt;img')
    expect(grid).not.toContain('<img')
    const html = renderDashboard({ sessions: [], query: '', status: 'all', loading: false, refreshIn: 15, visibleLimit: 20, mobileButton: panel.renderButton(), mobileGrid: grid })
    expect(html.indexOf('Dispositivos principais')).toBeLessThan(html.indexOf('<h2>Sessões</h2>'))
    expect(html).toContain('Novo dispositivo principal')
    panel.action('mobile-details', draft.id)
    expect(panel.renderDialog()).toContain('desativado até autorização do teste real')
  })
  test.each([401, 403, 404])('feature denied (%s) hides pilot without breaking dashboard', async status => {
    const { panel, api } = setup()
    api.request.mockRejectedValue(new ApiError(status, 'unavailable'))
    await panel.load(true)
    expect(panel.enabled).toBe(false)
    expect(panel.renderGrid()).toBe('')
  })
  test('infrastructure failure remains visible and independent of sessions', async () => {
    const { panel, api } = setup()
    api.request.mockRejectedValue(new Error('network failure'))
    await panel.load(true)
    expect(panel.renderGrid()).toContain('sessões existentes continuam independentes')
  })
  test('modal preserves values on failure, blocks duplicate submit and never requests SMS', async () => {
    const { panel, api } = setup()
    panel.enabled = true
    panel.action('mobile-new')
    let reject!: (error: Error) => void
    api.request.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    const data = form({ phone: draft.phone, name: 'My Lab', platform: 'ios', accountType: 'business', labConsent: 'on' })
    const pending = panel.submit('mobile-create', data)
    await panel.submit('mobile-create', data)
    expect(api.request).toHaveBeenCalledTimes(1)
    panel.action('mobile-close')
    expect(panel.modal).toBe('new')
    reject(new Error('conflict'))
    await pending
    expect(panel.renderDialog()).toContain('value="My Lab"')
    expect(panel.renderDialog()).toContain('value="ios" selected')
    expect(panel.renderDialog()).toContain('conflict')
    expect(api.request).toHaveBeenCalledWith('/manager/mobile-devices', expect.objectContaining({ method: 'POST' }))
    panel.action('mobile-close')
    expect(panel.renderDialog()).toBe('')
  })
  test('successful create closes modal and reloads drafts', async () => {
    const { panel, api } = setup()
    panel.enabled = true; panel.action('mobile-new')
    api.request.mockResolvedValueOnce(draft).mockResolvedValueOnce({ draftManagement: true }).mockResolvedValueOnce({ devices: [draft] })
    await panel.submit('mobile-create', form({ name: 'Lab' }))
    expect(panel.modal).toBeUndefined()
    expect(panel.devices).toEqual([draft])
  })
  test('deletion requires confirmation and targets only selected draft', async () => {
    const { panel, api } = setup()
    panel.enabled = true; panel.devices = [draft]
    panel.action('mobile-remove', draft.id)
    await panel.submit('mobile-delete', form({}))
    expect(api.request).not.toHaveBeenCalled()
    api.request.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ draftManagement: true }).mockResolvedValueOnce({ devices: [] })
    await panel.submit('mobile-delete', form({ confirm: 'on' }))
    expect(api.request).not.toHaveBeenCalled()
    await panel.submit('mobile-delete', form({ confirm: 'on', acknowledgeNewSms: 'on', phone: draft.phone }))
    expect(api.request).toHaveBeenCalledWith(`/manager/mobile-devices/${draft.id}/full`, { method: 'DELETE', body: JSON.stringify({ confirm: true, acknowledgeNewSms: true, phone: draft.phone }) })
    expect(panel.devices).toEqual([])
  })
  test('logout invalidates pending reads and creation results', async () => {
    const { panel, api } = setup()
    let resolve!: (value: unknown) => void
    api.request.mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce({ devices: [draft] })
    const loading = panel.load(true)
    panel.reset(); resolve({ draftManagement: true }); await loading
    expect(panel.enabled).toBe(false); expect(panel.devices).toEqual([])
    panel.enabled = true; panel.action('mobile-new')
    api.request.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const creating = panel.submit('mobile-create', form({ name: 'Lab' }))
    panel.reset(); resolve(draft); await creating
    expect(panel.enabled).toBe(false); expect(panel.modal).toBeUndefined()
  })
  test('background refresh does not overwrite an open form', async () => {
    const { panel, api } = setup()
    panel.enabled = true; panel.action('mobile-new')
    await panel.load(true)
    expect(api.request).not.toHaveBeenCalled()
    expect(panel.renderDialog()).toContain('data-action="mobile-close"')
    expect(panel.renderDialog()).not.toContain('data-close-modal')
  })
})
