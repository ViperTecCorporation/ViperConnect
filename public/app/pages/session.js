import { icon } from '../components/icons.js?v=4.0.34-43ce0548';
import { renderStatus } from '../components/status.js?v=4.0.34-43ce0548';
import { escapeHtml } from '../core/html.js?v=4.0.34-43ce0548';
import { isLegacySession, isOnlineStatus, sessionLabel, sessionPhone } from '../domain/session.js?v=4.0.34-43ce0548';
import { CONTACT_SEARCH_MIN_LENGTH, renderContactCards, renderGroupCards } from '../features/entities.js?v=4.0.34-43ce0548';
import { renderSessionConfig } from '../features/session_config.js?v=4.0.34-43ce0548';
import { renderWebhooks } from '../features/webhooks.js?v=4.0.34-43ce0548';
import { formatNumber, t } from '../core/i18n.js?v=4.0.34-43ce0548';
import { renderMobileCompanions } from '../features/mobile_companions.js?v=4.0.34-43ce0548';
const tabs = [
    ['overview', 'Visão geral'],
    ['config', 'Configuração'],
    ['webhooks', 'Webhooks'],
    ['contacts', 'Contatos'],
    ['groups', 'Grupos'],
    ['messages', 'Mensagens'],
];
const renderIntegrationIdentifier = ({ label, value }) => `
  <div class="integration-identifier">
    <div>
      <span>${t(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value || '—')}</strong>
    </div>
    ${value ? `<button class="btn btn--icon btn--ghost" type="button" data-action="copy-value" data-value="${escapeHtml(value)}" data-copy-label="${escapeHtml(t(label))}" aria-label="${escapeHtml(t('Copiar {label}', { label: t(label) }))}">${icon('copy')}</button>` : ''}
  </div>
`;
const renderWhatsAppIntegration = (session) => {
    const phone = `${session.display_phone_number || session.phone || session.session_phone || sessionPhone(session)}`.replace(/\D/g, '');
    const identifiers = [
        { label: 'WhatsApp Account ID', value: `${session.business_account_id || ''}`.trim() },
        { label: 'Phone Number ID', value: `${session.phone_number_id || ''}`.trim() },
        { label: 'Número da sessão', value: phone },
        { label: 'URL base', value: globalThis.location?.origin || '' },
    ];
    if (!session.business_account_id && !session.phone_number_id)
        return '';
    return `
    <section class="section integration-card">
      <div class="section__heading">
        <div><h2>${t('Integração WhatsApp')}</h2><p class="muted">${t('Identificadores usados para conectar esta sessão a outras aplicações.')}</p></div>
      </div>
      <div class="integration-identifiers">
        ${identifiers.map(renderIntegrationIdentifier).join('')}
      </div>
      <p class="integration-note">${icon('info')}<span>${t('Na ViperConnect, estes são identificadores estáveis de compatibilidade com a WhatsApp Cloud API. Não são IDs reais fornecidos pela Meta.')}</span></p>
    </section>
  `;
};
const renderOverview = (session, contactCount) => `
  <section class="stats" aria-label="${t('Resumo da sessão')}">
    <article class="stat-card"><span>Status</span><strong class="stat-card__status">${renderStatus(session.status)}</strong><small>${escapeHtml(session.server || 'server_1')}</small></article>
    <article class="stat-card"><span>${t('Contatos')}</span><strong>${contactCount === undefined ? '—' : formatNumber(contactCount)}</strong><small>${t('armazenados no cache Zapo')}</small></article>
    <article class="stat-card"><span>${t('Webhooks')}</span><strong>${session.webhooks?.filter((item) => item.enabled !== false && item.disabled !== true).length || 0}</strong><small>${t('destinos ativos')}</small></article>
  </section>
  ${renderWhatsAppIntegration(session)}
  <section class="section">
    <div class="section__heading"><div><h2>${t('Ações da sessão')}</h2><p class="muted">${escapeHtml(t('Toda operação abaixo usa o telefone {phone}.', { phone: sessionPhone(session) }))}</p></div></div>
    <div class="action-grid">
      <button class="action-card" type="button" data-action="test-message" data-phone="${escapeHtml(sessionPhone(session))}">${icon('send')}<span><strong>${t('Testar mensagem')}</strong><small>${t('Enviar texto pela API')}</small></span></button>
      <button class="action-card" type="button" data-action="connect-session" data-phone="${escapeHtml(sessionPhone(session))}">${icon('link')}<span><strong>${session.mobilePrimaryDraftId ? t('Visão geral do dispositivo') : isOnlineStatus(session.status) ? t('Ver conexão') : t('Conectar')}</strong><small>${session.mobilePrimaryDraftId ? t('Credenciais salvas; conexão pela Zapo, sem QR Code') : t('QR Code ou código de pareamento')}</small></span></button>
      <button class="action-card action-card--danger" type="button" data-action="deregister-session" data-phone="${escapeHtml(sessionPhone(session))}">${icon('trash')}<span><strong>${t('Desconectar')}</strong><small>${session.mobilePrimaryDraftId ? t('Suspender conexão e remover webhooks; preservar credenciais') : t('Remover vínculo e exigir novo pareamento')}</small></span></button>
    </div>
  </section>
`;
const renderContacts = (session, contacts, hasMore, loading, error, query) => {
    const queryLength = query.trim().length;
    const awaitingMinimum = queryLength > 0 && queryLength < CONTACT_SEARCH_MIN_LENGTH;
    return `
  <section class="section">
    <div class="section__heading">
      <div><h2>${t('Contatos da sessão')}</h2><p class="muted">${t('Nome, username, telefone de apresentação e LID canônico.')}</p></div>
      <div class="actions">
        <button class="btn btn--primary" type="button" data-action="add-contact">${icon('plus')}${t('Adicionar contato')}</button>
        <button class="btn btn--ghost" type="button" data-action="reload-contacts">${icon('refresh')}${t('Atualizar')}</button>
      </div>
    </div>
    <label class="search-field entity-search">${icon('search')}<input data-filter="contacts-query" value="${escapeHtml(query)}" placeholder="${t('Pesquisar nome, telefone, username ou LID')}" aria-label="${t('Pesquisar contatos')}" minlength="${CONTACT_SEARCH_MIN_LENGTH}" autocomplete="off"></label>
    ${awaitingMinimum ? `<p class="entity-search-hint" aria-live="polite">${t('Digite pelo menos 3 caracteres para pesquisar.')}</p>` : ''}
    ${error ? `<div class="inline-error">${escapeHtml(error)}</div>` : ''}
    ${loading ? `<div class="loading-state">${t('Carregando contatos…')}</div>` : renderContactCards(contacts, sessionPhone(session))}
    ${hasMore && !loading ? `<div class="load-more"><button class="btn" type="button" data-action="load-more-contacts">${t('Carregar mais')}</button></div>` : ''}
  </section>
`;
};
const renderGroups = (session, groups, hasMore, loading, error, query) => `
  <section class="section">
    <div class="section__heading">
      <div><h2>${t('Grupos da sessão')}</h2><p class="muted">${t('Cache e imagens dos grupos sincronizados por esta sessão.')}</p></div>
      <button class="btn btn--ghost" type="button" data-action="reload-groups">${icon('refresh')}${t('Atualizar')}</button>
    </div>
    <label class="search-field entity-search">${icon('search')}<input data-filter="groups-query" value="${escapeHtml(query)}" placeholder="${t('Pesquisar nome ou ID do grupo')}" aria-label="${t('Pesquisar grupos')}"></label>
    ${error ? `<div class="inline-error">${escapeHtml(error)}</div>` : ''}
    ${loading ? `<div class="loading-state">${t('Carregando grupos…')}</div>` : renderGroupCards(groups, sessionPhone(session))}
    ${hasMore && !loading ? `<div class="load-more"><button class="btn" type="button" data-action="load-more-groups">${t('Carregar mais')}</button></div>` : ''}
  </section>
`;
const renderPanel = (options) => {
    if (options.tab === 'messages')
        return options.messagesHtml || '<section class="section">Carregando mensagens…</section>';
    if (options.tab === 'profile')
        return options.profileHtml || '<section class="section">Consultando perfil…</section>';
    if (options.tab === 'devices' && options.session.mobilePrimaryDraftId)
        return options.companionsHtml || renderMobileCompanions(options.session, !!options.restricted);
    if (options.tab === 'config')
        return renderSessionConfig(options.session, options.restricted);
    if (options.tab === 'contacts') {
        return renderContacts(options.session, options.contacts, options.contactsHasMore, options.loadingSection, options.sectionError, options.contactsQuery);
    }
    if (options.tab === 'webhooks')
        return `<section class="section"><p>Para eventos de conexão, desconexão e remoção, configure os destinos centralizados.</p><button class="btn" data-action="open-session-webhooks">Webhooks de sessões</button>${renderWebhooks(options.session.webhooks || [])}</section>${options.webhookHistoryHtml || ''}`;
    if (options.tab === 'groups') {
        return renderGroups(options.session, options.groups, options.groupsHasMore, options.loadingSection, options.sectionError, options.groupsQuery);
    }
    return renderOverview(options.session, options.contactCount) + (options.canManageUsers && !options.session.mobilePrimaryDraftId && !isLegacySession(options.session) ? `<section class="section"><h2>Backup e migração</h2><p class="muted">Transfira as credenciais desta sessão Zapo para outra instância. O backup suspende a origem; não use as duas instâncias simultaneamente.</p><button type="button" class="btn" data-action="transfer-open" data-id="${escapeHtml(sessionPhone(options.session))}">Backup e migração da sessão</button></section><section class="mobile-overview__danger"><div><h3>Excluir sessão desta instância</h3><p>Após validar o backup no destino, remova somente o cadastro e as credenciais locais, sem logout remoto.</p></div><button type="button" class="btn btn--danger" data-action="transfer-remove" data-id="${escapeHtml(sessionPhone(options.session))}">Excluir desta instância</button></section>` : '');
};
export const renderSessionPage = (options) => {
    const { session, tab } = options;
    const legacySession = isLegacySession(session);
    return `
    <header class="page-header session-header">
      <div class="session-header__title">
        <button class="btn btn--icon btn--ghost" type="button" data-action="go-dashboard" aria-label="${t('Voltar ao Dashboard')}">${icon('arrowLeft')}</button>
        <div><span class="eyebrow">${t('Sessão')} · ${escapeHtml(sessionPhone(session))}</span><h1>${escapeHtml(sessionLabel(session))}</h1><p class="muted">${renderStatus(session.status)} <span>${escapeHtml(session.server || 'server_1')}</span></p></div>
      </div>
      <div class="actions">
        ${options.canManageUsers ? `<button class="btn btn--ghost" type="button" data-action="open-users" data-phone="${escapeHtml(sessionPhone(session))}">Responsável / atribuir sessão</button>` : ''}
        ${legacySession
        ? ''
        : `<button class="btn" type="button" data-action="test-message" data-phone="${escapeHtml(sessionPhone(session))}">${icon('send')}${t('Testar mensagem')}</button>`}
      </div>
    </header>
    ${legacySession
        ? `<section class="section legacy-migration">
          <div>
            <span class="eyebrow">${t('Migração necessária')}</span>
            <h2>${t('Baileys está desativada nesta versão')}</h2>
            <p class="muted">${t('Remova a sessão para limpar suas chaves legadas do Redis. Depois, registre novamente o mesmo telefone para parear diretamente na Zapo.')}</p>
          </div>
          <button class="btn btn--danger" type="button" data-action="deregister-session" data-phone="${escapeHtml(sessionPhone(session))}">${icon('trash')}${t('Remover sessão legada')}</button>
        </section>`
        : `<nav class="tabs" aria-label="${t('Áreas da sessão')}">
          ${tabs.flatMap((entry, index) => index === 0 ? [entry, ...(session.mobilePrimaryDraftId ? [['devices', 'Dispositivos conectados']] : []), ['profile', 'Perfil']] : [entry]).map(([value, label]) => `<button class="tab ${tab === value ? 'tab--active' : ''}" type="button" data-action="session-tab" data-tab="${value}" aria-selected="${tab === value}">${escapeHtml(t(label))}</button>`).join('')}
        </nav>
        <div class="session-content">${renderPanel(options)}</div>`}
  `;
};
