import { renderDashboard } from '../../frontend/pages/dashboard'
import { DOCUMENTATION_ORIGIN, DOCUMENTATION_URL, renderDocumentationPage } from '../../frontend/pages/documentation'
import { renderSessionPage } from '../../frontend/pages/session'
import { setLocale } from '../../frontend/core/i18n'

describe('frontend pages', () => {
  afterEach(() => setLocale('pt-BR'))

  test('renders dashboard sessions with automatic refresh and management action', () => {
    const html = renderDashboard({
      sessions: [{ phone: '5566', label: 'Comercial', status: 'online', server: 'server_1' }],
      query: '',
      status: 'all',
      loading: false,
      refreshIn: 15,
      visibleLimit: 20,
    })

    expect(html).toContain('data-refresh-countdown')
    expect(html).toContain('data-action="manage-session"')
    expect(html).toContain('status--online')
    expect(html).toContain('aria-label="WhatsApp"')
  })

  test('renders a session as a page with back navigation and session-scoped tabs', () => {
    const html = renderSessionPage({
      session: { phone: '5566', label: 'Comercial', status: 'online', webhooks: [] },
      tab: 'contacts',
      contacts: [],
      contactsHasMore: false,
      contactCount: 0,
      contactsQuery: '',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(html).toContain('data-action="go-dashboard"')
    expect(html).toContain('data-tab="contacts"')
    expect(html).toContain('Contatos da sessão')
    expect(html).not.toContain('aria-modal="true"')
    expect(html.indexOf('data-tab="webhooks"')).toBeLessThan(html.indexOf('data-tab="contacts"'))
    expect(html.indexOf('data-tab="contacts"')).toBeLessThan(html.indexOf('data-tab="groups"'))
    expect(html).toContain('minlength="3"')
    expect(html).toContain('Nome, username, telefone de apresentação e LID canônico.')
  })

  test('asks for three characters before searching contacts', () => {
    const html = renderSessionPage({
      session: { phone: '5566', status: 'online', webhooks: [] },
      tab: 'contacts',
      contacts: [],
      contactsHasMore: false,
      contactCount: 0,
      contactsQuery: 'ma',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(html).toContain('Digite pelo menos 3 caracteres para pesquisar.')
    expect(html).toContain('aria-live="polite"')
  })

  test('embeds the public documentation in the API front', () => {
    const html = renderDocumentationPage()

    expect(html).toContain(`src="${DOCUMENTATION_URL}"`)
    expect(html).toContain('class="documentation-embed__frame"')
    expect(html).toContain('title="Documentação"')
    expect(DOCUMENTATION_ORIGIN).toBe('https://viperconnect.vipertec.net')
  })

  test('opens the English documentation when the Manager language is English', () => {
    setLocale('en')
    const html = renderDocumentationPage()

    expect(html).toContain('src="https://viperconnect.vipertec.net/en/"')
    expect(html).toContain('title="Documentation"')
  })

  test('offers only removal for a suppressed Baileys session', () => {
    const html = renderSessionPage({
      session: { phone: '5566', provider: 'baileys', status: 'offline' },
      tab: 'overview',
      contacts: [],
      contactsHasMore: false,
      contactCount: 0,
      contactsQuery: '',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(html).toContain('Remover sessão legada')
    expect(html).not.toContain('data-action="test-message"')
    expect(html).not.toContain('data-action="session-tab"')
  })

  test('shows the number of cached contacts in the session overview', () => {
    const html = renderSessionPage({
      session: { phone: '5566', status: 'online', webhooks: [] },
      tab: 'overview',
      contacts: [],
      contactsHasMore: false,
      contactCount: 8976,
      contactsQuery: '',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(html).toContain('<strong>8.976</strong>')
    expect(html).toContain('armazenados no cache Zapo')
  })

  test('renders session WhatsApp integration identifiers with copy actions', () => {
    const html = renderSessionPage({
      session: {
        phone: '5566996269251',
        display_phone_number: '5566996269251',
        phone_number_id: '109876543210987',
        business_account_id: '123456789012345',
        status: 'online',
        webhooks: [],
      },
      tab: 'overview',
      contacts: [],
      contactsHasMore: false,
      contactCount: 0,
      contactsQuery: '',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(html).toContain('Integração WhatsApp')
    expect(html).toContain('123456789012345')
    expect(html).toContain('109876543210987')
    expect(html).toContain('data-action="copy-value"')
    expect(html).toContain('Não são IDs reais fornecidos pela Meta.')
  })

  test('translates the WhatsApp integration compatibility notice', () => {
    setLocale('en')
    const html = renderSessionPage({
      session: {
        phone: '5566996269251',
        phone_number_id: '109876543210987',
        business_account_id: '123456789012345',
      },
      tab: 'overview',
      contacts: [],
      contactsHasMore: false,
      contactCount: 0,
      contactsQuery: '',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(html).toContain('WhatsApp integration')
    expect(html).toContain('They are not real IDs provided by Meta.')
  })

  test('limits the session list to twenty items and offers load more', () => {
    const html = renderDashboard({
      sessions: Array.from({ length: 21 }, (_, index) => ({
        phone: `${5500000000000 + index}`,
        label: `Sessão ${index}`,
      })),
      query: '',
      status: 'all',
      loading: false,
      refreshIn: 15,
      visibleLimit: 20,
    })

    expect(html.match(/data-action="manage-session"/g) || []).toHaveLength(20)
    expect(html).toContain('data-action="load-more-sessions"')
  })

  test('renders dashboard and session navigation in English', () => {
    setLocale('en')
    const dashboard = renderDashboard({
      sessions: [],
      query: '',
      status: 'all',
      loading: false,
      refreshIn: 15,
      visibleLimit: 20,
    })
    const session = renderSessionPage({
      session: { phone: '5566', label: 'Sales', status: 'online', webhooks: [] },
      tab: 'contacts',
      contacts: [],
      contactsHasMore: false,
      contactCount: 0,
      contactsQuery: '',
      groups: [],
      groupsHasMore: false,
      groupsQuery: '',
      loadingSection: false,
      sectionError: '',
    })

    expect(dashboard).toContain('Overview')
    expect(dashboard).toContain('Automatic refresh of sessions in')
    expect(session).toContain('Session contacts')
    expect(session).toContain('Back to Dashboard')
  })
})
