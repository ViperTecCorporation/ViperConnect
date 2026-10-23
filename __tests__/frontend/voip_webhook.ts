import { renderVoipWebhookFields, voipWebhookPayload } from '../../frontend/domain/voip_webhook'
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
