import { renderAvatar } from '../../frontend/components/avatar'
import { icon } from '../../frontend/components/icons'
import { renderLayout, renderLogin } from '../../frontend/components/layout'
import { renderModal } from '../../frontend/components/modal'
import { renderStatus, statusTone } from '../../frontend/components/status'
import { setLocale } from '../../frontend/core/i18n'
import { renderContactCards, renderGroupCards } from '../../frontend/features/entities'

describe('frontend components', () => {
  afterEach(() => setLocale('pt-BR'))

  test('renders known and fallback icons accessibly', () => {
    expect(icon('github')).toContain('<svg')
    expect(icon('github', 'GitHub')).toContain('aria-label="GitHub"')
  })

  test('renders status semantics with green online tone', () => {
    expect(statusTone('online')).toBe('online')
    expect(statusTone('connecting')).toBe('warning')
    expect(renderStatus('online')).toContain('status--online')
  })

  test('renders pictures when available and a fallback otherwise', () => {
    expect(renderAvatar('https://cdn.example/picture.jpg', 'Maria')).toContain('<img')
    expect(renderAvatar('', 'Maria')).toContain('aria-label="Maria"')
    expect(renderAvatar('', 'Sessão', 'session')).toContain('M20.5 11.7')
  })

  test('renders the responsive shell, login and modal contracts', () => {
    const layout = renderLayout({
      content: '<p>Conteúdo</p>',
      collapsed: true,
      mobileOpen: false,
      versionStatus: {
        installed_version: '4.0.0-beta7',
        latest_version: '4.0.0-beta8',
        update_available: true,
        status: 'update_available',
        checked_at: '2026-07-25T12:00:00.000Z',
        release_url: 'https://github.com/ViperTecCorporation/ViperConnect/tree/v4.0.0-beta8',
      },
    })
    expect(layout).toContain('app-shell--collapsed')
    const navigation = layout.match(/<nav class="sidebar__nav">([\s\S]*?)<\/nav>/)?.[1] || ''
    expect([...navigation.matchAll(/data-action="([^"]+)"/g)].map(match => match[1])).toEqual([
      'go-dashboard', 'open-queues', 'open-redis', 'open-voip', 'open-session-webhooks', 'open-documentation',
    ])
    expect(layout).toContain('v4.0.0-beta8 disponível')
    expect(layout).toContain('workspace__icon--update')
    expect(layout).toContain('<span>Português</span>')
    expect(layout.indexOf('v4.0.0-beta7')).toBeLessThan(layout.indexOf('data-action="toggle-sidebar"'))

    const login = renderLogin('Token inválido')
    expect(login).toContain('data-form="login"')
    expect(login).toContain('data-action="toggle-language"')
    expect(login).toContain('<strong>ViperConnect</strong>')
    expect(login).toContain('Informe o token configurado no ViperConnect.')
    expect(login).not.toContain('viperconnect_logo.svg')
    expect(renderModal('test', 'Teste', '<p>Corpo</p>')).toContain('aria-modal="true"')
  })

  test('shows a green check when the installed version is current', () => {
    const layout = renderLayout({
      content: '',
      collapsed: false,
      mobileOpen: false,
      versionStatus: {
        installed_version: '4.0.0-beta8',
        latest_version: '4.0.0-beta8',
        update_available: false,
        status: 'current',
        checked_at: '2026-07-25T12:00:00.000Z',
      },
    })

    expect(layout).toContain('workspace__icon--current')
    expect(layout).toContain('Versão mais atual')
    expect(layout).not.toContain('Viper Tec</strong><small>Produção')
  })

  test('keeps the main sidebar and marks embedded documentation as active', () => {
    const layout = renderLayout({
      content: '<iframe></iframe>',
      collapsed: false,
      mobileOpen: false,
      activeView: 'documentation',
      versionStatus: {
        installed_version: '4.0.0-beta9',
        latest_version: '4.0.0-beta9',
        update_available: false,
        status: 'current',
        checked_at: '2026-07-29T12:00:00.000Z',
      },
    })

    expect(layout).toContain('data-action="open-documentation"')
    expect(layout).toContain('nav-item nav-item--active')
    expect(layout).toContain('main main--documentation')
    expect(layout).not.toContain('href="/docs"')
  })

  test('renders contact and group cards with picture slots', () => {
    const contact = renderContactCards(
      [{ user_id: '1@lid', phone_number: '5566999999999', display_name: 'Maria', username: '@maria.vendas', last_updated_ms: 1 }],
      '5566000000000',
    )
    expect(contact).toContain('data-recipient="1@lid"')
    expect(contact).toContain('data-value="5566999999999"')
    expect(contact).toContain('class="entity-card__username">@maria.vendas</span>')

    const group = renderGroupCards([{ id: '1@g.us', subject: 'Equipe', participants_count: 4 }], '5566000000000')
    expect(group).toContain('4 participantes')
    expect(group).toContain('data-recipient="1@g.us"')
    expect(group).toContain('data-value="1@g.us"')
  })

  test('renders the complete shell and its language control in English', () => {
    setLocale('en')
    const layout = renderLayout({
      content: '<p>Content</p>',
      collapsed: false,
      mobileOpen: false,
      versionStatus: {
        installed_version: '4.0.0-beta8',
        latest_version: '4.0.0-beta8',
        update_available: false,
        status: 'current',
        checked_at: '2026-07-25T12:00:00.000Z',
      },
    })

    expect(layout).toContain('Main navigation')
    expect(layout).toContain('Documentation')
    expect(layout).toContain('data-action="toggle-language"')
    expect(layout).toContain('<span>English</span>')
    expect(renderLogin()).toContain('Enter the token configured in ViperConnect.')
    expect(renderLogin()).toContain('aria-label="Change language"')
    expect(renderModal('test', 'Test', '<p>Body</p>')).toContain('aria-label="Close"')
  })
})
