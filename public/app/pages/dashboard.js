import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { renderStatus } from '../components/status.js?v=4.0.30-038921da';
import { filterSessions, isLegacySession, isOnlineStatus, sessionLabel, sessionPhone } from '../domain/session.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
export const renderDashboard = ({ sessions, query, status, loading, refreshIn, visibleLimit }) => {
    const filtered = filterSessions(sessions, query, status);
    const visible = filtered.slice(0, visibleLimit);
    const online = sessions.filter((session) => isOnlineStatus(session.status)).length;
    const connecting = sessions.filter((session) => `${session.status}`.toLowerCase() === 'connecting').length;
    const offline = Math.max(0, sessions.length - online - connecting);
    return `
    <header class="page-header">
      <div><span class="eyebrow">${t('Operação')}</span><h1>${t('Visão geral')}</h1><p class="muted">${t('Sessões e serviços em tempo real.')}</p></div>
      <div class="actions">
        <a class="btn btn--icon btn--ghost" href="https://github.com/ViperTecCorporation/ViperConnect" target="_blank" rel="noopener" aria-label="GitHub">${icon('github')}</a>
        <button class="btn" type="button" data-action="new-session">${icon('plus')}${t('Nova sessão')}</button>
      </div>
    </header>

    <div class="health-bar" aria-label="${t('Saúde dos serviços')}">
      <span>${renderStatus('online')} API</span>
      <span>${renderStatus('online')} Redis</span>
      <span>${renderStatus('online')} RabbitMQ</span>
    </div>

    <section class="stats" aria-label="${t('Resumo das sessões')}">
      <article class="stat-card"><span>${t('Online')}</span><strong>${online}</strong><small>${t('de {total} sessões', { total: sessions.length })}</small></article>
      <article class="stat-card"><span>${t('Conectando')}</span><strong>${connecting}</strong><small>${t('aguardando pareamento')}</small></article>
      <article class="stat-card"><span>${t('Offline')}</span><strong>${offline}</strong><small>${t('requerem atenção')}</small></article>
    </section>

    <section class="section sessions-section">
      <div class="section__heading">
        <div><h2>${t('Sessões')}</h2><p class="muted" aria-live="polite">${loading ? t('Atualizando…') : `${t('Atualização automática em')} <span data-refresh-countdown>${refreshIn}s</span>`}</p></div>
        <div class="actions"><span class="auto-refresh">${renderStatus('online')} ${t('Automático')}</span><button class="btn btn--ghost" type="button" data-action="refresh">${icon('refresh')}${t('Atualizar agora')}</button></div>
      </div>
      <div class="filters">
        <label class="search-field">${icon('search')}<input data-filter="query" value="${escapeHtml(query)}" placeholder="${t('Buscar nome ou telefone')}" aria-label="${t('Buscar sessão')}"></label>
        <label class="field field--compact"><span class="sr-only">Status</span><select data-filter="status">
          <option value="all" ${status === 'all' ? 'selected' : ''}>${t('Todos os status')}</option>
          <option value="online" ${status === 'online' ? 'selected' : ''}>${t('Online')}</option>
          <option value="connecting" ${status === 'connecting' ? 'selected' : ''}>${t('Conectando')}</option>
          <option value="offline" ${status === 'offline' ? 'selected' : ''}>${t('Offline')}</option>
        </select></label>
      </div>
      <div class="table-wrap">
        <table class="session-table">
          <thead><tr><th>${t('Sessão')}</th><th>Status</th><th>${t('Worker')}</th><th class="table-actions">${t('Ações')}</th></tr></thead>
          <tbody>
            ${visible.length
        ? visible
            .map((session) => {
            const phone = sessionPhone(session);
            const onlineSession = isOnlineStatus(session.status);
            const legacySession = isLegacySession(session);
            return `<tr>
                <td><div class="session-identity"><span class="session-identity__icon">${icon('whatsapp', 'WhatsApp')}</span><span><strong>${escapeHtml(sessionLabel(session))}</strong><small>${escapeHtml(phone)}</small></span></div></td>
                <td>${renderStatus(session.status)}</td>
                <td>${escapeHtml(session.server || 'server_1')}</td>
                <td class="table-actions"><div class="row-actions">
                  <button class="btn btn--ghost" type="button" data-action="manage-session" data-phone="${escapeHtml(phone)}">${icon('settings')}${t('Gerenciar')}</button>
                  ${legacySession
                ? `<span class="legacy-label">${t('Baileys desativada')}</span>`
                : onlineSession
                    ? `<button class="btn btn--icon btn--ghost" type="button" data-action="test-message" data-phone="${escapeHtml(phone)}" aria-label="${t('Testar mensagem')}">${icon('send')}</button>`
                    : `<button class="btn" type="button" data-action="connect-session" data-phone="${escapeHtml(phone)}">${icon('link')}${t('Conectar')}</button>`}
                </div></td>
              </tr>`;
        })
            .join('')
        : `<tr><td colspan="4"><div class="empty-state">${t('Nenhuma sessão encontrada.')}</div></td></tr>`}
          </tbody>
        </table>
      </div>
      ${filtered.length > visible.length
        ? `<div class="load-more"><button class="btn" type="button" data-action="load-more-sessions">${t('Carregar mais')} <span>${t('{visible} de {total}', { visible: visible.length, total: filtered.length })}</span></button></div>`
        : ''}
    </section>
  `;
};
