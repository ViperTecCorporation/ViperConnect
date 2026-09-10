import { icon } from './icons.js?v=4.0.30-038921da';
import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { getLocale, t } from '../core/i18n.js?v=4.0.30-038921da';
const renderVersionStatus = (status) => {
    const installed = status.installed_version ? `v${status.installed_version.replace(/^v/i, '')}` : t('Versão');
    if (status.status === 'update_available') {
        const latest = `v${`${status.latest_version || ''}`.replace(/^v/i, '')}`;
        const iconContent = status.release_url
            ? `<a class="workspace__icon workspace__icon--update" href="${escapeHtml(status.release_url)}" target="_blank" rel="noopener" title="${escapeHtml(t('Abrir {version}', { version: latest }))}">${icon('arrowUp')}</a>`
            : `<span class="workspace__icon workspace__icon--update">${icon('arrowUp')}</span>`;
        return `${iconContent}<span class="workspace__copy"><strong>${escapeHtml(installed)}</strong><small>${escapeHtml(t('{version} disponível', { version: latest }))}</small></span>`;
    }
    if (status.status === 'current') {
        return `<span class="workspace__icon workspace__icon--current" title="${t('Versão mais atual')}">${icon('check')}</span><span class="workspace__copy"><strong>${escapeHtml(installed)}</strong><small>${t('Versão mais atual')}</small></span>`;
    }
    return `<span class="workspace__icon workspace__icon--unknown" title="${t('Verificação indisponível')}">${icon('refresh')}</span><span class="workspace__copy"><strong>${escapeHtml(installed)}</strong><small>${status.installed_version ? t('Não foi possível verificar') : t('Verificando atualização…')}</small></span>`;
};
export const renderLayout = ({ content, collapsed, mobileOpen, versionStatus, activeView = 'dashboard' }) => `
  <div class="app-shell ${collapsed ? 'app-shell--collapsed' : ''} ${mobileOpen ? 'app-shell--mobile-open' : ''}">
    <aside class="sidebar" aria-label="${t('Navegação principal')}">
      <div class="brand">
        <img class="brand__logo" src="/logos/viperconnect_icon.svg" alt="ViperConnect">
        <span class="brand__copy"><strong>ViperConnect</strong><small>WhatsApp Hub</small></span>
      </div>
      <nav class="sidebar__nav">
        <button class="nav-item ${activeView === 'dashboard' ? 'nav-item--active' : ''}" type="button" data-action="go-dashboard" title="Dashboard">
          ${icon('dashboard')}<span>Dashboard</span>
        </button>
        <button class="nav-item ${activeView === 'queues' ? 'nav-item--active' : ''}" type="button" data-action="open-queues" title="${t('Filas')}">
          ${icon('queue')}<span>${t('Filas')}</span>
        </button>
        <button class="nav-item ${activeView === 'redis' ? 'nav-item--active' : ''}" type="button" data-action="open-redis" title="Redis">
          ${icon('database')}<span>Redis</span>
        </button>
        <button class="nav-item ${activeView === 'voip' ? 'nav-item--active' : ''}" type="button" data-action="open-voip" title="${t('Telefonia')}">
          ${icon('phone')}<span>${t('Telefonia')}</span>
        </button>
        <button class="nav-item ${activeView === 'documentation' ? 'nav-item--active' : ''}" type="button" data-action="open-documentation" title="${t('Documentação')}">
          ${icon('docs')}<span>${t('Documentação')}</span>
        </button>
      </nav>
      <div class="sidebar__footer">
        <button class="nav-item" type="button" data-action="toggle-theme" title="${t('Alternar tema')}">
          ${icon('theme')}<span>${t('Tema')}</span>
        </button>
        <button class="nav-item" type="button" data-action="toggle-language" title="${t('Alterar idioma')}">
          ${icon('globe')}<span>${getLocale() === 'pt-BR' ? 'Português' : 'English'}</span>
        </button>
        <a class="nav-item" href="https://github.com/ViperTecCorporation/ViperConnect" target="_blank" rel="noopener" title="GitHub">
          ${icon('github')}<span>GitHub</span>
        </a>
        <button class="nav-item" type="button" data-action="logout" title="${t('Sair')}">
          ${icon('logout')}<span>${t('Sair')}</span>
        </button>
        <div class="workspace">
          ${renderVersionStatus(versionStatus)}
          <button class="btn btn--icon btn--ghost sidebar__toggle" type="button" data-action="toggle-sidebar" aria-label="${collapsed ? t('Expandir menu') : t('Recolher menu')}">
            ${icon(collapsed ? 'expand' : 'collapse')}
          </button>
        </div>
      </div>
    </aside>
    <div class="mobile-header">
      <div class="brand">
        <img class="brand__logo" src="/logos/viperconnect_icon.svg" alt="">
        <span class="brand__copy"><strong>ViperConnect</strong></span>
      </div>
      <div class="actions">
        <a class="btn btn--icon btn--ghost" href="https://github.com/ViperTecCorporation/ViperConnect" target="_blank" rel="noopener" aria-label="GitHub">${icon('github')}</a>
        <button class="btn btn--icon btn--ghost" type="button" data-action="toggle-mobile-menu" aria-label="${t('Abrir menu')}">${icon('menu')}</button>
      </div>
    </div>
    <main class="main ${activeView === 'documentation' ? 'main--documentation' : ''}">${content}</main>
  </div>
`;
export const renderLogin = (error = '') => `
  <main class="login-shell">
    <section class="login-panel">
      <div class="login-toolbar">
        <div class="login-brand" aria-label="ViperConnect">
          <img class="login-brand__icon" src="/logos/viperconnect_icon.svg" alt="">
          <strong>ViperConnect</strong>
        </div>
        <button class="btn btn--icon btn--ghost" type="button" data-action="toggle-language" aria-label="${t('Alterar idioma')}" title="${t('Alterar idioma')}">
          ${icon('globe')}
        </button>
      </div>
      <div>
        <span class="eyebrow">${t('Painel de gerenciamento')}</span>
        <h1>${t('Acesse suas sessões')}</h1>
        <p class="muted">${t('Informe o token configurado no ViperConnect.')}</p>
      </div>
      <form class="stack" data-form="login">
        <label class="field">
          <span>${t('Token de acesso')}</span>
          <input name="token" type="password" autocomplete="current-password" required autofocus>
        </label>
        ${error ? `<p class="form-error" role="alert">${error}</p>` : ''}
        <button class="btn btn--block" type="submit">${t('Entrar')}</button>
      </form>
    </section>
  </main>
`;
