import { parseVoipWebhookUrl, renderVoipWebhookFields, syncVoipWebhookFields, voipWebhookPayload } from '../../frontend/domain/voip_webhook'
import { renderVoipResourceModal } from '../../frontend/pages/voip'
import { ViperConnectApp } from '../../frontend/app'

describe('ViperChat call webhook configuration', () => {
  test('renders saved public fields but never credentials or server activation metadata', () => {
    const html = renderVoipResourceModal({ companies: [{ id: 'company', viperchatWebhook: {
      enabled: true, baseUrl: 'https://chat.example', sourceInstanceId: '<central>',
      apiAccessToken: 'secret-must-not-render', hasApiAccessToken: true, activatedAt: 'private-activation',
    } }] }, 'companies', 'company')
    expect(html).toContain('name="viperchatWebhook.enabled" checked')
    expect(html).toContain('https://chat.example')
    expect(html).toContain('&lt;central&gt;')
    expect(html).toContain('Token configurado')
    expect(html).toContain('somente chamadas com ramais vinculados a ela')
    expect(html).not.toContain('field--switch')
    expect(html).toContain('class="voip-check wide"><input type="checkbox" name="viperchatWebhook.enabled"')
    expect(html).not.toContain('secret-must-not-render')
    expect(html).not.toContain('private-activation')
    expect(renderVoipWebhookFields()).toContain('name="viperchatWebhook.apiAccessToken" value=""')
  })
  test('does not configure or display legacy webhook credentials in the line editor', () => {
    const html = renderVoipResourceModal({ companies: [{ id: 'company' }], accounts: [{ id: 'line', companyId: 'company', viperchatWebhook: {
      enabled: true, apiAccessToken: 'legacy-secret', baseUrl: 'https://legacy.example',
    } }] }, 'accounts', 'line')
    expect(html).not.toContain('name="viperchatWebhook.')
    expect(html).not.toContain('legacy-secret')
    expect(html).not.toContain('https://legacy.example')
  })
  test('serializes only contract fields, preserves blank token and supports explicit removal', () => {
    const form = new FormData()
    form.set('viperchatWebhook.enabled', 'on')
    form.set('viperchatWebhook.accountId', ' 1 ')
    form.set('viperchatWebhook.apiAccessToken', '  ')
    form.set('viperchatWebhook.activatedAt', 'untrusted')
    expect(voipWebhookPayload(form)).toEqual({ enabled: true, artifactsDelivery: 'legacy', accountId: '1', serviceId: '', baseUrl: '', sourceInstanceId: '' })
    form.set('viperchatWebhook.artifactsDelivery', 'webhook')
    form.set('viperchatWebhook.endpointUrl', 'https://chat.example/api/v1/accounts/1/voip/services/206/events')
    expect(voipWebhookPayload(form).artifactsDelivery).toBe('webhook')
    expect(renderVoipWebhookFields({ artifactsDelivery: 'webhook' })).toContain('value="webhook" selected')
    form.set('viperchatWebhook.apiAccessToken', 'replacement')
    expect(voipWebhookPayload(form).apiAccessToken).toBe('replacement')
    form.delete('viperchatWebhook.enabled')
    form.set('viperchatWebhook.clearApiAccessToken', 'on')
    expect(voipWebhookPayload(form)).toMatchObject({ enabled: false, clearApiAccessToken: true })
  })
  test('submits webhook configuration only for companies, never for line writes', () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    const form = new FormData()
    form.set('id', 'company')
    form.set('enabled', 'on')
    form.set('viperchatWebhook.enabled', 'on')
    form.set('viperchatWebhook.accountId', '1')
    form.set('viperchatWebhook.apiAccessToken', 'write-only-token')
    expect(app.voipResourcePayload('companies', form).viperchatWebhook).toMatchObject({ enabled: true, accountId: '1', apiAccessToken: 'write-only-token' })
    expect(app.voipResourcePayload('accounts', form)).not.toHaveProperty('viperchatWebhook')
  })
  test('company mode derives destination from the complete URL, ignoring manually injected IDs', () => {
    const form = new FormData()
    form.set('viperchatWebhook.artifactsDelivery', 'webhook')
    form.set('viperchatWebhook.endpointUrl', ' https://chat.example/prefix/api/v1/accounts/12/voip/services/87/events ')
    form.set('viperchatWebhook.accountId', '999')
    form.set('viperchatWebhook.serviceId', '999')
    form.set('viperchatWebhook.baseUrl', 'https://wrong.example')
    expect(voipWebhookPayload(form)).toMatchObject({ baseUrl: 'https://chat.example/prefix', accountId: '12', serviceId: '87' })
    expect(voipWebhookPayload(form)).not.toHaveProperty('endpointUrl')
    form.set('viperchatWebhook.artifactsDelivery', 'legacy')
    expect(voipWebhookPayload(form)).toMatchObject({ baseUrl: 'https://wrong.example', accountId: '999', serviceId: '999' })
  })
  test.each([
    '', 'https://chat.example', 'https://chat.example/api/v1/accounts/0/voip/services/87/events',
    'https://chat.example/api/v1/accounts/12/voip/services/0/events',
    'https://chat.example/api/v1/accounts/12/voip/services/87/other',
    'http://chat.example/api/v1/accounts/12/voip/services/87/events',
    'https://user:password@chat.example/api/v1/accounts/12/voip/services/87/events',
    'https://chat.example/api/v1/accounts/12/voip/services/87/events?token=secret',
    'https://chat.example/api/v1/accounts/12/voip/services/87/events#fragment',
  ])('rejects malformed or unsafe webhook endpoint %s', url => {
    expect(() => parseVoipWebhookUrl(url)).toThrow('URL completa')
  })
  test('supports loopback dev and reconstructs an existing saved endpoint without exposing credentials', () => {
    expect(parseVoipWebhookUrl('http://127.0.0.1:3000/api/v1/accounts/1/voip/services/206/events'))
      .toEqual({ baseUrl: 'http://127.0.0.1:3000', accountId: '1', serviceId: '206' })
    const html = renderVoipWebhookFields({ artifactsDelivery: 'webhook', baseUrl: 'https://chat.example/', accountId: '12', serviceId: '87' })
    expect(html).toContain('value="https://chat.example/api/v1/accounts/12/voip/services/87/events"')
    expect(html).toContain('data-voip-webhook-mode="legacy" hidden')
    expect(html).toContain('data-voip-webhook-mode="webhook" >')
  })
  test('switches modes in place, disabling hidden fields without losing drafts or typed credentials', () => {
    const fields: Record<string, any> = {
      artifactsDelivery: { value: 'webhook' },
      baseUrl: { value: 'https://chat.example' }, accountId: { value: '1' }, serviceId: { value: '206' },
      apiAccessToken: { value: 'unsaved-token' },
      endpointUrl: { value: '', setCustomValidity: jest.fn() },
    }
    const groups: Record<string, any> = Object.fromEntries(['webhook', 'legacy'].map(mode => [mode, {
      hidden: false, querySelectorAll: () => mode === 'webhook' ? [fields.endpointUrl] : [fields.baseUrl, fields.accountId, fields.serviceId],
    }]))
    const form = {
      elements: { namedItem: (name: string) => fields[name.replace('viperchatWebhook.', '')] },
      querySelector: (selector: string) => groups[selector.includes('="webhook"') ? 'webhook' : 'legacy'],
    } as unknown as HTMLFormElement
    syncVoipWebhookFields(form)
    expect(fields.endpointUrl.value).toBe('https://chat.example/api/v1/accounts/1/voip/services/206/events')
    expect(groups.legacy.hidden).toBe(true)
    expect(fields.accountId.disabled).toBe(true)
    fields.endpointUrl.value = 'invalid'
    syncVoipWebhookFields(form)
    expect(fields.endpointUrl.setCustomValidity).toHaveBeenLastCalledWith(expect.stringContaining('URL completa'))
    fields.artifactsDelivery.value = 'legacy'
    syncVoipWebhookFields(form)
    expect(fields.endpointUrl.disabled).toBe(true)
    expect(fields.accountId.disabled).toBe(false)
    expect(fields.endpointUrl.setCustomValidity).toHaveBeenLastCalledWith('')
    expect(fields.apiAccessToken.value).toBe('unsaved-token')
    expect(fields.accountId.value).toBe('1')
  })
  test('webhook artifact mode makes legacy line posting visibly inactive without clearing saved settings', () => {
    const html = renderVoipResourceModal({ companies: [{ id: 'company', viperchatWebhook: { enabled: true, artifactsDelivery: 'webhook' } }], accounts: [{ id: 'line', companyId: 'company', chatwootRecording: { enabled: true, inboxId: '42', hasApiAccessToken: true } }] }, 'accounts', 'line')
    expect(html).toContain('Envio legado inativo')
    expect(html).toContain('habilitado (não efetivo)')
    expect(html).toContain('name="chatwootRecordingInactive"')
    expect(html).not.toContain('name="chatwootRecordingEnabled"')
    const app = Object.create(ViperConnectApp.prototype) as any
    const form = new FormData()
    form.set('chatwootRecordingInactive', 'true')
    const payload = app.voipResourcePayload('accounts', form)
    for (const key of ['chatwootRecordingEnabled', 'chatwootBaseUrl', 'chatwootAccountId', 'chatwootInboxId', 'chatwootApiAccessToken', 'chatwootPrivateNote']) expect(payload).not.toHaveProperty(key)
  })
  test('legacy artifact mode retains editable line integration and never leaks another company mode', () => {
    const html = renderVoipResourceModal({ companies: [{ id: 'company', viperchatWebhook: { artifactsDelivery: 'legacy' } }, { id: 'another', viperchatWebhook: { artifactsDelivery: 'webhook' } }], accounts: [{ id: 'line', companyId: 'company', chatwootRecording: { enabled: true } }] }, 'accounts', 'line')
    expect(html).toContain('name="chatwootRecordingEnabled" type="checkbox" checked')
    expect(html).not.toContain('chatwootRecordingInactive')
  })
})
