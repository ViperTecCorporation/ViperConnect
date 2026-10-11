import { renderSessionConfig, sessionConfigPayload } from '../../frontend/features/session_config'
import {
  renderConfirmDeregisterModal,
  renderConnectionModal,
  renderMessageModal,
  renderNewSessionModal,
} from '../../frontend/features/session_modals'
import { renderWebhookModal, renderWebhooks, webhookPayload } from '../../frontend/features/webhooks'
import { filterContacts, filterGroups } from '../../frontend/features/entities'
import { setLocale } from '../../frontend/core/i18n'

describe('frontend features', () => {
  afterEach(() => setLocale('pt-BR'))

  test('renders session config without provider selection', () => {
    const html = renderSessionConfig({ phone: '5566', label: 'Comercial', provider: 'baileys' })
    expect(html).toContain('data-form="session-config"')
    expect(html).not.toContain('name="provider"')
    expect(html).toContain('name="connectionType" type="hidden"')
    expect(html).toContain('execute deregister')
    expect(html).toContain('data-action="toggle-secret"')
    expect(html).toContain('data-action="copy-secret"')
    expect(html).toContain('data-action="toggle-tooltip"')
    expect(html).toContain('Só é aplicado quando “Ignorar histórico de mensagens” está desativado')
    expect(html).toContain('Para desabilitar o recurso, deixe este campo em branco.')
    expect(html).toContain('aplicação cadastrada no webhook')
    expect(html).toContain('Quantidade máxima de envios desta sessão')
    expect(html).toContain('Quantidade máxima de envios ao mesmo destinatário')
    expect(html).toContain('com zero, o atraso padrão é de 60 segundos')
  })

  test('renders call rejection help in English', () => {
    setLocale('en')
    const html = renderSessionConfig({ phone: '5566' })

    expect(html).toContain('To disable this feature, leave this field blank.')
    expect(html).toContain('application registered in the webhook')
    expect(html).toContain('It only applies when “Ignore message history” is disabled')
    expect(html).toContain('Maximum number of sends from this session')
    expect(html).toContain('Maximum number of sends to the same recipient')
    expect(html).toContain('when set to zero, the default delay is 60 seconds')
    expect(renderWebhookModal({}, -1)).toContain('Enable/Disable Webhook')
    expect(renderWebhookModal({}, -1)).toContain('The block only applies to this session and webhook.')
  })

  test('maps the full session form payload', () => {
    const data = new FormData()
    data.set('label', 'Comercial')
    data.set('connectionType', 'qrcode')
    data.set('zapoWebClientProfile', 'wa_personal')
    data.set('historyMaxAgeDays', '15')
    data.set('autoConnect', 'on')
    const payload = sessionConfigPayload(data)

    expect(payload).toMatchObject({
      label: 'Comercial',
      connectionType: 'qrcode',
      zapoWebClientProfile: 'wa_personal',
      historyMaxAgeDays: 15,
      autoConnect: true,
      ignoreGroupMessages: false,
    })
  })

  test('keeps webhook ID inside its editor instead of the listing', () => {
    const list = renderWebhooks([{ id: 'secret-id', urlAbsolute: 'https://example.test/hook', enabled: true }])
    const modal = renderWebhookModal({ id: 'secret-id' }, 0)

    expect(list).not.toContain('secret-id')
    expect(list).toContain('<th>Status</th><th>Destino</th>')
    expect(modal).toContain('value="secret-id"')
    expect(modal).toContain('Ativa/Inativa Webhook')
    expect(modal).toContain('O bloqueio vale somente para esta sessão e este webhook.')
    expect(modal).toContain('data-action="toggle-tooltip"')
  })

  test('maps webhook form settings', () => {
    const data = new FormData()
    data.set('id', 'default')
    data.set('urlAbsolute', 'https://example.test/hook')
    data.set('enabled', 'on')
    data.set('sendIncomingMessages', 'on')

    expect(webhookPayload(data)).toMatchObject({
      id: 'default',
      urlAbsolute: 'https://example.test/hook',
      enabled: true,
      sendIncomingMessages: true,
      sendOutgoingMessages: false,
    })
  })

  test('renders every contextual session modal', () => {
    const session = { phone: '5566', label: 'Comercial', connectionType: 'qrcode' as const }
    expect(renderNewSessionModal()).toContain('Motor Zapo')
    expect(renderNewSessionModal()).toContain('name="zapoWebClientProfile"')
    expect(renderNewSessionModal()).toContain('value="default"')
    expect(renderNewSessionModal()).toContain('value="wa_personal"')
    expect(renderNewSessionModal()).toContain('value="wa_business"')
    expect(renderMessageModal(session, '123@lid')).toContain('name="to" value="123@lid"')
    expect(renderConnectionModal(session)).toContain('Sessão 5566')
    expect(renderConfirmDeregisterModal(session)).toContain('confirm-deregister')
  })

  test('filters contacts and groups by their public identity fields', () => {
    const contacts = [
      { user_id: '123@lid', display_name: 'Maria Comercial', username: 'maria.vendas', last_updated_ms: 1 },
      { user_id: '456@lid', display_name: 'João', username: 'joao.financeiro', last_updated_ms: 2 },
    ]
    expect(filterContacts(contacts, 'ma')).toEqual(contacts)
    expect(filterContacts(contacts, 'comercial')).toHaveLength(1)
    expect(filterContacts(contacts, 'vendas')).toEqual([expect.objectContaining({ user_id: '123@lid' })])
    expect(
      filterGroups(
        [
          { id: 'group-1@g.us', subject: 'Financeiro' },
          { id: 'group-2@g.us', subject: 'Comercial' },
        ],
        'group-2',
      ),
    ).toEqual([expect.objectContaining({ subject: 'Comercial' })])
  })
})
