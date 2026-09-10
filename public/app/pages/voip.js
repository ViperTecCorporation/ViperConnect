import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { renderModal } from '../components/modal.js?v=4.0.30-038921da';
import { renderStatus } from '../components/status.js?v=4.0.30-038921da';
import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
const labels = {
    companies: 'Empresas',
    accounts: 'Linhas Zapo',
    lineGroups: 'Grupos de linhas',
    extensionGroups: 'Grupos de ramais',
    sessions: 'Sessões Zapo',
    extensions: 'Ramais',
};
const tabs = [
    ['overview', 'Visão geral'],
    ['lines', 'Linhas'],
    ['extensions', 'Ramais'],
    ['routing', 'Roteamento avançado'],
    ['calls', 'Chamadas e gravações'],
    ['companies', 'Empresas'],
    ['settings', 'Configurações'],
];
const asItems = (value) => Array.isArray(value) ? value : [];
const checked = (value) => value !== false ? 'checked' : '';
const selected = (current, value) => `${current ?? ''}` === `${value ?? ''}` ? 'selected' : '';
const selectedMany = (current, value) => Array.isArray(current) && current.map(String).includes(String(value)) ? 'selected' : '';
const normalizeSearch = (value) => `${value ?? ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
const matchesSearch = (query, ...values) => {
    const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
    if (!terms.length)
        return true;
    const haystack = normalizeSearch(values.flatMap(value => Array.isArray(value) ? value : [value]).join(' '));
    return terms.every(term => haystack.includes(term));
};
const quantity = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;
const maxConcurrentCalls = (value, fallback = 2) => {
    const parsed = Number(value);
    return Math.min(32, Math.max(2, Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback));
};
const legacySlotCalls = (value) => {
    const parsed = Number(value);
    return Math.max(1, Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1);
};
const options = (items, current, multiple = false) => items.map(item => {
    const label = item.label || item.displayName || item.username || item.phoneNumber || item.id;
    return `<option value="${escapeHtml(`${item.id}`)}" ${multiple ? selectedMany(current, item.id) : selected(current, item.id)}>${escapeHtml(`${label}`)}</option>`;
}).join('');
const badge = (text, tone = 'muted') => `<span class="voip-badge voip-badge--${tone}">${escapeHtml(text)}</span>`;
const formatBytes = (value) => {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const amount = bytes / (1024 ** index);
    return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
};
const recordingExtension = (item) => {
    const mime = `${item.recordingMime || item.mime || ''}`.toLowerCase();
    if (mime.includes('mpeg') || mime.includes('mp3'))
        return 'mp3';
    if (mime.includes('gsm'))
        return 'gsm';
    if (mime.includes('wav') || mime.includes('wave'))
        return 'wav';
    const key = `${item.recordingKey || item.recordingUrl || ''}`.toLowerCase().split('?')[0];
    const match = key.match(/\.(mp3|wav|gsm)$/);
    return match?.[1] || 'mp3';
};
const lineConcurrency = (state, account) => {
    const session = asItems(state.sessions).find(item => item.accountId === account.id || item.unoSession === account.phoneNumber);
    const discovered = (state.zapoLines || []).find(item => item.accountId === account.id || item.session === account.phoneNumber);
    const legacyTotal = asItems(account.slots)
        .filter(item => item.enabled !== false)
        .reduce((total, item) => total + legacySlotCalls(item.maxActiveCalls), 0);
    return maxConcurrentCalls(account.maxConcurrentCalls ?? session?.maxConcurrentCalls ?? discovered?.maxConcurrentCalls, legacyTotal || 2);
};
const sectionHeading = (title, description, action = '') => `
  <div class="section__heading"><div><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(description)}</p></div>${action}</div>`;
const tabSearch = (query, placeholder) => `<div class="filters voip-search" role="search">
  <label class="field"><span>Buscar</span><input type="search" data-filter="voip-query" value="${escapeHtml(query)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></label>
</div>`;
const emptyRow = (columns, text) => `<tr><td colspan="${columns}"><div class="empty-state">${escapeHtml(text)}</div></td></tr>`;
const editButton = (resource, id) => `<button class="btn btn--ghost" type="button" data-action="edit-voip-resource" data-resource="${resource}" data-id="${escapeHtml(id)}">${icon('edit')}Editar</button>`;
const resourceGrid = (state, resource, columns, extraActions, filteredItems) => {
    const items = filteredItems ?? asItems(state[resource]);
    return `<section class="section">
    ${sectionHeading(labels[resource], `Gerencie ${labels[resource].toLowerCase()} sem editar JSON.`, `<button class="btn" type="button" data-action="new-voip-resource" data-resource="${resource}">${icon('plus')}Adicionar</button>`)}
    <div class="table-wrap"><table><thead><tr>${columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('')}<th class="table-actions">Ações</th></tr></thead><tbody>
      ${items.length ? items.map(item => `<tr>${columns.map(([, render]) => `<td>${render(item)}</td>`).join('')}<td class="table-actions"><div class="row-actions">${extraActions?.(item) || ''}${editButton(resource, `${item.id}`)}</div></td></tr>`).join('') : emptyRow(columns.length + 1, `Nenhum item em ${labels[resource].toLowerCase()}.`)}
    </tbody></table></div>
  </section>`;
};
const companyName = (state, id) => asItems(state.companies).find(item => item.id === id)?.label || id || '—';
const includesAnyId = (values, candidates) => Array.isArray(values)
    && values.some(value => candidates.some(candidate => `${value ?? ''}` === `${candidate ?? ''}`));
const extensionLinkedToGroup = (extension, group) => includesAnyId(extension.extensionGroupIds, [group.id]) || includesAnyId(group.extensionIds, [extension.id]);
const sessionLinkedToLineGroup = (session, group) => {
    const sessionIds = [session.id, session.unoSession, session.accountId].filter(Boolean);
    return includesAnyId([
        ...(session.lineGroupIds || []),
        ...(session.inboundLineGroupIds || []),
        ...(session.outboundLineGroupIds || []),
    ], [group.id])
        || includesAnyId(group.inboundSessionIds, sessionIds)
        || includesAnyId(group.outboundPrioritySessionIds, sessionIds);
};
const extensionTransportTerms = (type) => {
    if (!type || type === 'both')
        return 'both sip sip/rtp webrtc';
    if (type === 'sip')
        return 'sip sip/rtp';
    return `${type}`;
};
const automaticLineForExtension = (state, extension) => (state.zapoLines || []).find(line => `${line.automatic?.extensionId || ''}` === `${extension.id || ''}`
    || (`${line.automatic?.username || ''}` && `${line.automatic?.username}` === `${extension.username || ''}`));
const isAutomaticExtension = (state, extension) => extension.provisioningSource === 'zapo_auto' || Boolean(automaticLineForExtension(state, extension));
const automaticExtensionOffline = (state, extension) => {
    const automatic = automaticLineForExtension(state, extension)?.automatic;
    return automatic?.status === 'offline' || (!automatic && extension.status === 'offline');
};
const activeRegistrations = (state) => [
    ...asItems(state.registrations?.webrtc).map(item => ({ ...item, transport: 'webrtc' })),
    ...asItems(state.registrations?.sipRtp).map(item => ({ ...item, transport: 'sip_rtp' })),
];
const registrationsForExtension = (state, extension) => activeRegistrations(state).filter(registration => `${registration.id || ''}` === `${extension.id || ''}`
    || `${registration.username || ''}` === `${extension.username || ''}`);
const registrationTransport = (registration) => registration.transport === 'sip_rtp' ? 'SIP/RTP' : 'WebRTC';
const registrationContact = (registration) => {
    if (typeof registration.contact === 'string' && registration.contact.trim())
        return registration.contact;
    const address = registration.peer?.address || registration.peer?.host;
    const port = registration.peer?.port;
    return address ? `${address}${port ? `:${port}` : ''}` : '—';
};
const registrationStatus = (state, extension) => {
    const registrations = registrationsForExtension(state, extension);
    if (!registrations.length)
        return `<div class="stack stack--compact">${badge('Sem registro')}<span class="muted">Nenhum endpoint conectado</span></div>`;
    const transports = [...new Set(registrations.map(registrationTransport))].join(' + ');
    return `<div class="stack stack--compact">${badge('Registrado', 'success')}<span class="muted">${quantity(registrations.length, 'conexão', 'conexões')} · ${escapeHtml(transports)}</span></div>`;
};
const renderOverview = (state) => {
    const lines = state.zapoLines || [];
    const online = lines.filter(item => item.connected).length;
    const automatic = lines.filter(item => item.automatic).length;
    return `<section class="stats">
      <article class="stat-card"><span>Linhas conectadas</span><strong>${online}</strong><small>de ${lines.length} descobertas/configuradas</small></article>
      <article class="stat-card"><span>Ramais automáticos</span><strong>${automatic}</strong><small>provisionados pelas sessões Zapo</small></article>
      <article class="stat-card"><span>Chamadas ativas</span><strong>${state.calls?.length || 0}</strong><small>isoladas por sessão e call ID</small></article>
      <article class="stat-card"><span>Ramais</span><strong>${state.extensions?.length || 0}</strong><small>SIP/WebRTC e SIP/RTP</small></article>
    </section>
    <section class="section">${sectionHeading('Estado operacional', 'Resumo das linhas e ramais registrados.')}
      <div class="voip-overview-grid">
        <article class="card stack"><h3>Provisionamento automático</h3><strong class="voip-large-number">${automatic}</strong><p class="muted">Empresa, linha, sessão e ramal são conciliados automaticamente.</p></article>
        <article class="card stack"><h3>Registros de ramal</h3><strong class="voip-large-number">${state.registrations?.total || 0}</strong><p class="muted">Endpoints SIP e WebRTC conectados neste momento.</p></article>
      </div>
    </section>`;
};
const automaticRegistrationStatus = (line) => {
    const automatic = line.automatic;
    if (!automatic)
        return '<span class="muted">Provisionando…</span>';
    const transports = automatic.transports?.length
        ? automatic.transports.map(item => item === 'sip' ? 'SIP' : 'WebRTC').join(' + ')
        : 'Sem transporte';
    const free = automatic.freeRegistrationCount || 0;
    const busy = automatic.busyRegistrationCount || 0;
    return `<div class="stack stack--compact"><span>${quantity(free, 'livre', 'livres')} · ${quantity(busy, 'ocupado', 'ocupados')} · ${automatic.registrationCount || 0} total</span><span class="muted">${escapeHtml(transports)}</span></div>`;
};
const renderLines = (state, query = '') => {
    const lines = (state.zapoLines || []).filter(line => matchesSearch(query, line.session, line.sourceId, line.workerId, line.serverId, line.companyId, line.companyLabel, line.accountId, line.sessionId, line.connected ? 'online conectada' : 'offline desconectada', line.automatic?.username, line.automatic?.status, line.automatic?.transports, line.automatic?.basicInboundEnabled === false ? 'básico desativado' : 'básico ativo', (line.advancedRoutingConfigured ?? line.routingConfigured) ? 'avançado' : 'sem avançado'));
    return `<section class="section">${sectionHeading('Linhas Zapo', 'Empresa, linha, sessão e ramal são provisionados automaticamente pela bridge.')}
    <div class="table-wrap"><table><thead><tr><th>Sessão</th><th>Status</th><th>Empresa</th><th>Ramal automático</th><th>Registros</th><th>Atendimento</th><th>Concorrência</th><th class="table-actions">Ações</th></tr></thead><tbody>
      ${lines.length ? lines.map(line => `<tr>
        <td><strong>${escapeHtml(line.session)}</strong><br><span class="muted">${escapeHtml(line.workerId || line.serverId || 'Bridge Zapo')}</span></td>
        <td>${renderStatus(line.connected ? 'online' : 'offline')}</td>
        <td>${escapeHtml(line.companyLabel || line.companyId || 'Empresa padrão')}</td>
        <td>${line.automatic ? `<strong>${escapeHtml(line.automatic.username)}</strong><br>${badge(line.automatic.status === 'active' ? 'Automático ativo' : 'Automático offline', line.automatic.status === 'active' ? 'success' : 'muted')}` : '<span class="muted">Provisionando…</span>'}</td>
        <td>${automaticRegistrationStatus(line)}</td>
        <td><div class="stack stack--compact">${line.automatic?.basicInboundEnabled === false ? badge('Básico desativado', 'muted') : badge('Básico ativo', 'success')}${(line.advancedRoutingConfigured ?? line.routingConfigured) ? badge('Avançado', 'success') : badge('Sem avançado')}</div></td>
        <td>${maxConcurrentCalls(line.maxConcurrentCalls)}</td>
        <td class="table-actions"><div class="row-actions">
          ${editButton('accounts', line.accountId || line.session)}
        </div></td>
      </tr>`).join('') : emptyRow(8, query ? 'Nenhuma linha encontrada para a busca.' : 'Nenhuma sessão Zapo foi descoberta.')}
    </tbody></table></div>
  </section>`;
};
const renderActiveRegistrations = (state, query = '') => {
    const registrations = activeRegistrations(state).filter(registration => {
        const extension = asItems(state.extensions).find(item => `${item.id || ''}` === `${registration.id || ''}`
            || `${item.username || ''}` === `${registration.username || ''}`);
        return matchesSearch(query, registration.id, registration.registrationId, registration.username, registration.extensionLabel, registration.displayName, registrationTransport(registration), registrationContact(registration), registration.userAgent, extension?.displayName, extension?.username, companyName(state, extension?.companyId));
    });
    return `<section class="section">${sectionHeading('Registros ativos', 'Endpoints SIP e WebRTC conectados neste momento.')}
    <div class="table-wrap"><table><thead><tr><th>Ramal</th><th>Transporte</th><th>Contato</th><th>Cliente</th><th>Expira em</th><th class="table-actions">Ações</th></tr></thead><tbody>
      ${registrations.length ? registrations.map(registration => `<tr>
        <td><strong>${escapeHtml(registration.extensionLabel || registration.displayName || registration.username || registration.id || '—')}</strong><br><span class="muted">${escapeHtml(registration.username || registration.id || '—')}</span></td>
        <td>${badge(registrationTransport(registration), 'success')}</td>
        <td><code>${escapeHtml(registrationContact(registration))}</code></td>
        <td>${escapeHtml(registration.userAgent || '—')}</td>
        <td>${Number.isFinite(Number(registration.expiresIn)) ? `${Math.max(0, Number(registration.expiresIn))}s` : '—'}</td>
        <td class="table-actions"><button class="btn btn--danger" type="button" data-action="drop-voip-registration" data-extension-id="${escapeHtml(`${registration.id || registration.username || ''}`)}" data-registration-id="${escapeHtml(`${registration.registrationId || ''}`)}" data-registration-type="${registration.transport}">${icon('trash')}Desconectar</button></td>
      </tr>`).join('') : emptyRow(6, query ? 'Nenhum registro encontrado para a busca.' : 'Nenhum ramal registrado neste momento.')}
    </tbody></table></div>
  </section>`;
};
const transferAudioActions = (item, urls) => {
    if (!item.transferAudioSource)
        return '';
    const id = `${item.id || ''}`;
    const player = urls[id] ? `<audio class="voip-audio" data-transfer-player="${escapeHtml(id)}" controls preload="metadata" src="${escapeHtml(urls[id])}"></audio>` : '';
    return `${player}<button class="btn btn--ghost" type="button" data-action="play-voip-transfer-audio" data-id="${escapeHtml(id)}">${icon('phone')}Ouvir áudio de espera</button>`;
};
const renderExtensions = (state, transferAudioUrls, showOfflineAutomatic = false, query = '') => {
    const extensions = asItems(state.extensions);
    const extensionsAllowedByVisibility = extensions.filter(item => showOfflineAutomatic || !isAutomaticExtension(state, item) || !automaticExtensionOffline(state, item));
    const hiddenOffline = extensions.length - extensionsAllowedByVisibility.length;
    const visibleExtensions = extensionsAllowedByVisibility.filter(item => {
        const automatic = isAutomaticExtension(state, item);
        const groups = asItems(state.extensionGroups).filter(group => extensionLinkedToGroup(item, group));
        const registrations = registrationsForExtension(state, item);
        return matchesSearch(query, item.id, item.username, item.displayName, extensionTransportTerms(item.type), companyName(state, item.companyId), automatic ? 'automático' : 'avançado', item.enabled ? 'ativo' : 'inativo', item.extensionGroupIds, groups.map(group => group.label || group.id), registrations.flatMap(registration => [registrationTransport(registration), registrationContact(registration), registration.userAgent]), registrations.length ? 'registrado' : 'sem registro');
    });
    const visibleExtensionIds = new Set(visibleExtensions.map(item => `${item.id}`));
    const visibleExtensionGroups = asItems(state.extensionGroups).filter(group => matchesSearch(query, group.id, group.label, companyName(state, group.companyId), group.enabled ? 'ativo' : 'inativo', group.extensionIds, extensions.filter(extension => extensionLinkedToGroup(extension, group)).flatMap(extension => [extension.displayName, extension.username])) || extensions.some(extension => visibleExtensionIds.has(`${extension.id}`) && extensionLinkedToGroup(extension, group)));
    const toggleLabel = showOfflineAutomatic ? 'Ocultar automáticos offline' : `Mostrar automáticos offline${hiddenOffline ? ` (${hiddenOffline})` : ''}`;
    const grid = `<section class="section">
    ${sectionHeading('Ramais', 'Ramais automáticos e avançados no mesmo cadastro.', `<div class="row-actions"><button class="btn btn--ghost" type="button" data-action="toggle-voip-offline-automatic">${escapeHtml(toggleLabel)}</button><button class="btn" type="button" data-action="new-voip-resource" data-resource="extensions">${icon('plus')}Adicionar avançado</button></div>`)}
    <div class="table-wrap"><table><thead><tr><th>Ramal</th><th>Empresa</th><th>Tipo</th><th>Grupos</th><th>Configuração</th><th>Registro</th><th class="table-actions">Ações</th></tr></thead><tbody>
      ${visibleExtensions.length ? visibleExtensions.map(item => {
        const automatic = isAutomaticExtension(state, item);
        return `<tr><td><strong>${escapeHtml(item.displayName || item.id)}</strong><br><span class="muted">${escapeHtml(item.username || item.id)}</span><br>${badge(automatic ? 'Automático' : 'Avançado', automatic ? 'success' : 'muted')}</td><td>${escapeHtml(`${companyName(state, item.companyId)}`)}</td><td>${escapeHtml(item.type || 'both')}</td><td>${item.extensionGroupIds?.length || 0}</td><td>${item.enabled ? badge('Ativo', 'success') : badge('Inativo')}</td><td>${registrationStatus(state, item)}</td><td class="table-actions"><div class="row-actions"><button class="btn btn--ghost" type="button" data-action="show-voip-credentials" data-id="${escapeHtml(`${item.id}`)}">${icon('eye')}Credenciais</button>${automatic ? '' : editButton('extensions', `${item.id}`)}</div></td></tr>`;
    }).join('') : emptyRow(7, query ? 'Nenhum ramal encontrado para a busca.' : hiddenOffline ? 'Os ramais automáticos offline estão ocultos.' : 'Nenhum ramal configurado.')}
    </tbody></table></div>
  </section>`;
    return grid + renderActiveRegistrations(state, query) + resourceGrid(state, 'extensionGroups', [
        ['Grupo', item => `<strong>${escapeHtml(item.label || item.id)}</strong>`],
        ['Empresa', item => escapeHtml(`${companyName(state, item.companyId)}`)],
        ['Ramais', item => `${item.extensionIds?.length || 0}`],
        ['Áudio de transferência', item => item.transferAudioSource ? badge(item.transferAudioFilename || 'Configurado', 'success') : badge('Não configurado')],
        ['Status', item => item.enabled ? badge('Ativo', 'success') : badge('Inativo')],
    ], item => transferAudioActions(item, transferAudioUrls), visibleExtensionGroups);
};
const renderRouterSimulator = (state, result) => {
    const locks = asItems(state.router?.locks);
    return `<section class="section">
  ${sectionHeading('Simulador de roteamento', 'Valide entrada e saída usando a mesma regra aplicada às chamadas reais.')}
  <div class="voip-overview-grid">
    <form class="card form-grid" data-form="voip-router-inbound"><h3 class="wide">Entrada</h3>${selectField('sessionId', 'Sessão de roteamento', asItems(state.sessions), '', true)}<button class="btn" type="submit">Simular entrada</button></form>
    <form class="card form-grid" data-form="voip-router-outbound"><h3 class="wide">Saída</h3>${selectField('extensionId', 'Ramal', asItems(state.extensions), '', true)}${field('target', 'Destino', '', 'text', true)}<button class="btn" type="submit">Simular saída</button></form>
  </div>
  ${result ? `<div class="card stack"><h3>Resultado</h3><pre class="code-block"><code>${escapeHtml(JSON.stringify(result, null, 2))}</code></pre></div>` : ''}
  <div class="table-wrap"><table><thead><tr><th>Reserva</th><th>Escopo</th><th>Dono</th><th>Destino</th><th class="table-actions">Ações</th></tr></thead><tbody>${locks.length ? locks.map(lock => `<tr><td><code>${escapeHtml(lock.id || '—')}</code></td><td>${escapeHtml(lock.scope || '—')}</td><td>${escapeHtml(lock.extensionId || lock.owner || '—')}</td><td>${escapeHtml(lock.targetNumber || lock.accountId || '—')}</td><td class="table-actions"><button class="btn btn--danger" type="button" data-action="release-voip-router-lock" data-lock-id="${escapeHtml(lock.id || '')}">${icon('trash')}Liberar</button></td></tr>`).join('') : emptyRow(5, 'Nenhuma reserva ativa.')}</tbody></table></div>
</section>`;
};
const renderRouting = (state, routerResult, query = '') => {
    const lineGroups = asItems(state.lineGroups).filter(item => matchesSearch(query, item.id, item.label, companyName(state, item.companyId), item.inboundSessionIds, item.outboundPrioritySessionIds, item.targetExtensionGroupIds, asItems(state.sessions).filter(session => sessionLinkedToLineGroup(session, item)).flatMap(session => [session.label, session.unoSession, session.accountId]), asItems(state.extensionGroups).filter(group => item.targetExtensionGroupIds?.includes(group.id)).map(group => group.label || group.id)));
    const sessions = asItems(state.sessions).filter(item => matchesSearch(query, item.id, item.label, item.unoSession, item.accountId, companyName(state, item.companyId), item.lineGroupIds, item.inboundLineGroupIds, item.outboundLineGroupIds, item.routing?.basicInboundEnabled === false ? 'básico desativado' : 'básico ativo', asItems(state.lineGroups).filter(group => sessionLinkedToLineGroup(item, group)).map(group => group.label || group.id)));
    return resourceGrid(state, 'lineGroups', [
        ['Grupo', item => `<strong>${escapeHtml(item.label || item.id)}</strong>`],
        ['Empresa', item => escapeHtml(`${companyName(state, item.companyId)}`)],
        ['Entrada', item => quantity(item.inboundSessionIds?.length || 0, 'linha', 'linhas')],
        ['Saída', item => quantity(item.outboundPrioritySessionIds?.length || 0, 'linha', 'linhas')],
        ['Destinos', item => quantity(item.targetExtensionGroupIds?.length || 0, 'grupo', 'grupos')],
    ], undefined, lineGroups) + resourceGrid(state, 'sessions', [
        ['Sessão', item => `<strong>${escapeHtml(item.label || item.id)}</strong><br><span class="muted">${escapeHtml(item.unoSession || item.id)}</span>`],
        ['Empresa', item => escapeHtml(`${companyName(state, item.companyId)}`)],
        ['Conta', item => escapeHtml(item.accountId || '—')],
        ['Grupos', item => `${item.lineGroupIds?.length || 0}`],
    ], undefined, sessions) + renderRouterSimulator(state, routerResult);
};
const recordingCell = (item, urls) => {
    if (item.recordingStatus !== 'available')
        return escapeHtml(`${item.recordingStatus || '—'}`);
    const id = `${item.id || item.callId}`;
    const player = urls[id] ? `<audio class="voip-audio" data-recording-player="${escapeHtml(id)}" controls preload="metadata" src="${escapeHtml(urls[id])}"></audio>` : '';
    return `<div class="voip-recording-actions">${player}<div class="row-actions"><button class="btn btn--ghost" type="button" data-action="play-voip-recording" data-record-id="${escapeHtml(id)}">${icon('phone')}Reproduzir</button><button class="btn btn--ghost" type="button" data-action="download-voip-recording" data-record-id="${escapeHtml(id)}" data-call-id="${escapeHtml(`${item.callId || id}`)}" data-recording-extension="${recordingExtension(item)}">Baixar</button></div></div>`;
};
const contactLabel = (nameValue, numberValue, fallback = '—') => {
    const name = `${nameValue || ''}`.trim();
    const number = `${numberValue || ''}`.trim();
    if (name && number && name !== number)
        return `${name} · ${number}`;
    return name || number || fallback;
};
const historyTable = (state, urls) => {
    const items = state.history?.items || [];
    return `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Contato</th><th>Linha</th><th>Ramal</th><th>Direção</th><th>Status</th><th>Duração</th><th>Gravação</th></tr></thead><tbody>
    ${items.length ? items.map(item => {
        const contact = contactLabel(item.remoteName, item.remoteNumber);
        return `<tr><td>${escapeHtml(`${item.startedAt || '—'}`)}</td><td>${escapeHtml(contact)}</td><td>${escapeHtml(`${item.accountLabel || item.accountId || item.phoneNumber || '—'}`)}</td><td>${escapeHtml(`${item.extensionLabel || item.extensionUsername || '—'}`)}</td><td>${escapeHtml(`${item.direction || '—'}`)}</td><td>${escapeHtml(`${item.status || '—'}`)}</td><td>${item.durationSeconds ?? item.recordingDurationSeconds ?? '—'}s</td><td>${recordingCell(item, urls)}</td></tr>`;
    }).join('') : emptyRow(8, 'Nenhuma chamada no período.')}
  </tbody></table></div>`;
};
const historyControls = (state) => {
    const history = state.history || {};
    const page = Math.max(1, Number(history.page || 1));
    const totalPages = Math.max(1, Number(history.totalPages || 1));
    const total = Math.max(0, Number(history.total || 0));
    return `<form class="filters" data-form="voip-history-filter">
    <label class="field"><span>Buscar</span><input name="search" value="${escapeHtml(`${history.search || ''}`)}" placeholder="Nome, número, ramal ou status"></label>
    <label class="field"><span>Início</span><input name="startDate" type="date" value="${escapeHtml(`${history.startDate || ''}`)}"></label>
    <label class="field"><span>Fim</span><input name="endDate" type="date" value="${escapeHtml(`${history.endDate || ''}`)}"></label>
    <button class="btn" type="submit">Filtrar</button><button class="btn btn--ghost" type="button" data-action="reset-voip-history">Limpar</button>
  </form><div class="section__heading"><p class="muted">${quantity(total, 'registro', 'registros')} · página ${page} de ${totalPages}</p><div class="row-actions"><button class="btn btn--ghost" type="button" data-action="voip-history-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Anterior</button><button class="btn btn--ghost" type="button" data-action="voip-history-page" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Próxima</button></div></div>`;
};
const renderCalls = (state, urls) => `<section class="section">${sectionHeading('Nova chamada', 'Origine pela sessão Zapo e conecte ao ramal selecionado.')}
  <form class="filters" data-form="voip-call"><label class="field"><span>Sessão</span><select name="session" required><option value="">Selecione</option>${(state.zapoLines || []).filter(item => item.connected).map(item => `<option value="${escapeHtml(item.session)}">${escapeHtml(item.session)} · ${escapeHtml(item.companyLabel || 'Empresa padrão')}</option>`).join('')}</select></label><label class="field"><span>Ramal</span><select name="extensionId" required><option value="">Selecione</option>${options(asItems(state.extensions))}</select></label><label class="field"><span>Destino</span><input name="peerJid" placeholder="5566999999999" required></label><button class="btn" type="submit">${icon('phone')}Ligar</button></form></section>
  <section class="section">${sectionHeading('Chamadas em andamento', 'Transferência e encerramento das chamadas ativas.')}<div class="table-wrap"><table><thead><tr><th>Call ID</th><th>Sessão</th><th>Direção</th><th>Contato</th><th class="table-actions">Ações</th></tr></thead><tbody>${state.calls?.length ? state.calls.map(call => {
    const contact = contactLabel(call.callerName, call.callerPn, call.peerJid || '—');
    return `<tr><td><code>${escapeHtml(call.callId)}</code></td><td>${escapeHtml(call.session)}</td><td>${escapeHtml(call.direction)}</td><td>${escapeHtml(contact)}</td><td class="table-actions"><form class="row-actions" data-form="voip-transfer"><input type="hidden" name="callId" value="${escapeHtml(call.callId)}"><select name="targetExtensionId" required><option value="">Transferir para</option>${options(asItems(state.extensions))}</select><button class="btn btn--ghost" type="submit">Transferir</button><button class="btn btn--danger" type="button" data-action="end-voip-call" data-session="${escapeHtml(call.session)}" data-call-id="${escapeHtml(call.callId)}">Encerrar</button></form></td></tr>`;
}).join('') : emptyRow(5, 'Nenhuma chamada ativa.')}</tbody></table></div></section>
  <section class="section">${sectionHeading('Histórico e gravações', 'Pesquise as chamadas, reproduza no próprio grid ou baixe a gravação.', `<button class="btn btn--ghost" type="button" data-action="edit-voip-recording-settings">${icon('settings')}Configurar gravações</button>`)}${historyControls(state)}${historyTable(state, urls)}</section>
  <section class="section">${sectionHeading('Armazenamento de gravações por linha', 'Uso agregado dos arquivos armazenados.')}<div class="table-wrap"><table><thead><tr><th>Linha</th><th>Empresa</th><th>Arquivos</th><th>Tamanho</th></tr></thead><tbody>${asItems(state.recordingSummary?.accounts).map(item => `<tr><td>${escapeHtml(item.accountLabel || item.phoneNumber || item.accountId || '—')}</td><td>${escapeHtml(item.companyLabel || '—')}</td><td>${item.count || 0}</td><td>${formatBytes(item.sizeBytes)}</td></tr>`).join('') || emptyRow(4, 'Nenhuma gravação armazenada.')}</tbody></table></div></section>`;
const renderSettings = (state) => `<section class="section">${sectionHeading('Configurações da telefonia', 'Parâmetros operacionais e estado do serviço.')}
  <div class="settings-grid"><article class="card stack"><h3>Gravações</h3><p class="muted">Formato: ${escapeHtml(`${state.recording?.format || '—'}`)} · destino: ${escapeHtml(`${state.recording?.provider || '—'}`)}</p><button class="btn" type="button" data-action="edit-voip-recording-settings">${icon('settings')}Configurar gravações</button></article></div>
  </section>`;
export const renderVoipPage = (state, loading, error = '', renderOptions = {}) => {
    const tab = renderOptions.tab || 'overview';
    const query = renderOptions.query || '';
    const search = tab === 'lines'
        ? tabSearch(query, 'Sessão, empresa, ramal, worker ou status')
        : tab === 'extensions'
            ? tabSearch(query, 'Ramal, usuário, empresa, grupo, transporte ou registro')
            : tab === 'routing'
                ? tabSearch(query, 'Sessão, grupo, linha, empresa ou destino')
                : '';
    const body = tab === 'overview' ? renderOverview(state)
        : tab === 'lines' ? renderLines(state, query)
            : tab === 'extensions' ? renderExtensions(state, renderOptions.transferAudioUrls || {}, renderOptions.showOfflineAutomaticExtensions, query)
                : tab === 'routing' ? renderRouting(state, renderOptions.routerResult, query)
                    : tab === 'calls' ? renderCalls(state, renderOptions.recordingUrls || {})
                        : tab === 'companies' ? resourceGrid(state, 'companies', [['Empresa', item => `<strong>${escapeHtml(item.label || item.id)}</strong><br><span class="muted">${escapeHtml(item.id)}</span>`], ['Fuso horário', item => escapeHtml(item.timeZone || '—')], ['IA pós-chamada', item => item.aiSummary?.enabled ? badge('Ativa', 'success') : badge('Inativa')], ['Status', item => item.enabled ? badge('Ativa', 'success') : badge('Inativa')]])
                            : renderSettings(state);
    return `<header class="page-header"><div><span class="eyebrow">Telefonia</span><h1>Manager VoIP</h1><p class="muted">Linhas Zapo, empresas, roteamento, ramais, chamadas e gravações.</p></div><button class="btn btn--ghost" type="button" data-action="refresh-voip">${icon('refresh')}${loading ? 'Atualizando…' : 'Atualizar'}</button></header>
    ${error ? `<div class="form-error" role="alert">${escapeHtml(error)}</div>` : ''}
    <nav class="tabs" aria-label="Áreas da telefonia">${tabs.map(([value, label]) => `<button class="tab ${tab === value ? 'tab--active' : ''}" type="button" data-action="voip-tab" data-tab="${value}" aria-selected="${tab === value}">${escapeHtml(label)}</button>`).join('')}</nav>${search}${body}`;
};
const field = (name, label, value = '', type = 'text', required = false, readonly = false, attributes = '') => `<label class="field"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" value="${escapeHtml(`${value ?? ''}`)}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''} ${attributes}></label>`;
const switchField = (name, label, value) => `<label class="voip-check"><input name="${name}" type="checkbox" ${checked(value)}> ${escapeHtml(label)}</label>`;
const selectField = (name, label, items, current, required = false, multiple = false) => `<label class="field"><span>${escapeHtml(label)}</span><select name="${name}" ${required ? 'required' : ''} ${multiple ? 'multiple size="5"' : ''}>${multiple ? '' : '<option value="">Selecione</option>'}${options(items, current, multiple)}</select></label>`;
const textareaField = (name, label, value = '') => `<label class="field wide"><span>${escapeHtml(label)}</span><textarea name="${name}" rows="6">${escapeHtml(`${value ?? ''}`)}</textarea></label>`;
const configuredSecret = (configured) => configured ? '<p class="muted">Chave configurada. Deixe o campo vazio para manter.</p>' : '';
const sipEndpointModeField = (value) => {
    const current = value === 'trunk' ? 'trunk' : 'extension';
    return `<fieldset class="voip-sip-mode wide"><legend>Modo de conexão SIP</legend><label class="voip-sip-mode__option"><input name="sipEndpointMode" type="radio" value="extension" ${checked(current === 'extension')}><span><strong>Ramal tradicional</strong><small>Uma chamada por dispositivo ou registro SIP.</small></span></label><label class="voip-sip-mode__option"><input name="sipEndpointMode" type="radio" value="trunk" ${checked(current === 'trunk')}><span><strong>Tronco SIP/PBX</strong><small>Permite várias chamadas simultâneas no mesmo registro, respeitando o limite da linha.</small></span></label></fieldset>`;
};
export const renderVoipResourceModal = (state, resource, id = '') => {
    const item = asItems(state[resource]).find(value => `${value.id}` === id) || { enabled: true };
    const isNew = !id;
    const companies = asItems(state.companies);
    const accounts = asItems(state.accounts);
    const lineGroups = asItems(state.lineGroups);
    const extensionGroups = asItems(state.extensionGroups);
    const extensions = asItems(state.extensions);
    const managedAutomaticExtension = resource === 'extensions'
        && asItems(state.sessions).some(session => `${session.automaticExtensionId || ''}` === `${item.id || ''}`);
    const managedAutomaticAccount = resource === 'accounts'
        && asItems(state.sessions).some(session => `${session.accountId || ''}` === `${item.id || ''}` && session.automaticExtensionId);
    const managedAutomaticSession = resource === 'sessions' && Boolean(item.automaticExtensionId);
    const managedDefaultCompany = resource === 'companies' && `${item.id || ''}` === 'empresa-padrao';
    const managedAutomatic = managedAutomaticExtension || managedAutomaticAccount || managedAutomaticSession || managedDefaultCompany;
    const managedEnabled = item.enabled === false
        ? '<p class="muted">Estado gerenciado automaticamente pela sessão Zapo.</p>'
        : '<input type="hidden" name="enabled" value="true"><p class="muted">Ativo · estado gerenciado automaticamente pela sessão Zapo.</p>';
    let fields = `${field('id', 'ID', item.id, 'text', true, !isNew)}${managedAutomatic ? managedEnabled : switchField('enabled', 'Ativo', item.enabled)}`;
    if (resource === 'companies') {
        const ai = item.aiSummary || {};
        fields += `${field('label', 'Nome da empresa', item.label, 'text', true)}${field('timeZone', 'Fuso horário', item.timeZone || 'America/Cuiaba', 'text', true)}<h3 class="wide">IA pós-chamada</h3>${switchField('aiSummaryEnabled', 'Gerar transcrição e resumo', ai.enabled === true)}${switchField('aiIncludeTranscript', 'Incluir transcrição junto ao resumo', ai.includeTranscript !== false)}${field('aiTranscriptionBaseUrl', 'URL da transcrição', ai.transcriptionBaseUrl || 'https://api.groq.com/openai/v1')}${field('aiTranscriptionApiKey', 'Chave da transcrição (deixe vazio para manter)', '', 'password')}${configuredSecret(ai.hasTranscriptionApiKey)}${field('aiTranscriptionModel', 'Modelo de transcrição', ai.transcriptionModel || 'whisper-large-v3')}${field('aiTranscriptionLanguage', 'Idioma', ai.transcriptionLanguage || 'pt')}${field('aiSummaryBaseUrl', 'URL do resumo', ai.summaryBaseUrl || 'https://api.groq.com/openai/v1')}${field('aiSummaryApiKey', 'Chave do resumo (deixe vazio para manter)', '', 'password')}${configuredSecret(ai.hasSummaryApiKey)}${field('aiSummaryModel', 'Modelo de resumo', ai.summaryModel || 'openai/gpt-oss-20b')}${textareaField('aiSummaryPrompt', 'Prompt do resumo', ai.summaryPrompt)}`;
    }
    if (resource === 'accounts') {
        const companyField = managedAutomatic
            ? `<input type="hidden" name="companyId" value="${escapeHtml(`${item.companyId || ''}`)}">${field('_companyLabel', 'Empresa (gerenciada)', companyName(state, item.companyId), 'text', false, true)}`
            : selectField('companyId', 'Empresa', companies, item.companyId, true);
        fields += `${field('label', 'Nome da linha', item.label, 'text', true)}${companyField}${field('phoneNumber', 'Número da sessão Zapo', item.phoneNumber, 'text', true, managedAutomatic)}${field('maxConcurrentCalls', 'Chamadas simultâneas', lineConcurrency(state, item), 'number', true, false, 'min="2" max="32" step="1"')}<p class="muted wide">A linha usa a sessão Zapo conectada. Configure entre 2 e 32 chamadas simultâneas.</p><h3 class="wide">Gravações no Chatwoot</h3>${field('chatwootBaseUrl', 'URL do Chatwoot', item.chatwootRecording?.baseUrl)}${field('chatwootAccountId', 'ID da conta no Chatwoot', item.chatwootRecording?.accountId)}${field('chatwootInboxId', 'ID da caixa de entrada no Chatwoot', item.chatwootRecording?.inboxId)}${field('chatwootApiAccessToken', 'Token do Chatwoot (deixe vazio para manter)', '', 'password')}${configuredSecret(item.chatwootRecording?.hasApiAccessToken)}${switchField('chatwootRecordingEnabled', 'Enviar gravações ao Chatwoot', item.chatwootRecording?.enabled === true)}${switchField('chatwootPrivateNote', 'Enviar como nota privada', item.chatwootRecording?.privateNote !== false)}`;
    }
    if (resource === 'lineGroups')
        fields += `${field('label', 'Nome do grupo', item.label, 'text', true)}${selectField('companyId', 'Empresa', companies, item.companyId, true)}${selectField('inboundSessionIds', 'Linhas de entrada', accounts, item.inboundSessionIds, false, true)}${selectField('outboundPrioritySessionIds', 'Prioridade de saída', accounts, item.outboundPrioritySessionIds, false, true)}${selectField('targetExtensionGroupIds', 'Grupos de ramais de destino', extensionGroups, item.targetExtensionGroupIds, false, true)}`;
    if (resource === 'extensionGroups')
        fields += `${field('label', 'Nome do grupo', item.label, 'text', true)}${selectField('companyId', 'Empresa', companies, item.companyId, true)}${selectField('extensionIds', 'Ramais', extensions, item.extensionIds, false, true)}<label class="field wide"><span>Áudio ao transferir (MP3 ou WAV)</span><input name="transferAudioFile" type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,.mp3,.wav"><small class="muted">${item.transferAudioSource ? `Atual: ${escapeHtml(item.transferAudioFilename || 'arquivo configurado')}. Selecione outro apenas para substituir.` : 'Opcional. É usado enquanto o destino da transferência atende.'}</small></label>`;
    if (resource === 'sessions') {
        const companyField = managedAutomatic
            ? `<input type="hidden" name="companyId" value="${escapeHtml(`${item.companyId || ''}`)}">${field('_companyLabel', 'Empresa (gerenciada)', companyName(state, item.companyId), 'text', false, true)}`
            : selectField('companyId', 'Empresa', companies, item.companyId, true);
        const accountField = managedAutomatic
            ? field('accountId', 'Linha Zapo (gerenciada)', item.accountId, 'text', true, true)
            : selectField('accountId', 'Linha Zapo', accounts, item.accountId, true);
        fields += `${field('label', 'Nome', item.label, 'text', true)}${field('unoSession', 'Sessão Zapo', item.unoSession, 'text', true, managedAutomatic)}${companyField}${accountField}${selectField('lineGroupIds', 'Grupos de linhas', lineGroups, item.lineGroupIds, false, true)}${selectField('inboundLineGroupIds', 'Grupos de entrada', lineGroups, item.inboundLineGroupIds, false, true)}${selectField('outboundLineGroupIds', 'Grupos de saída', lineGroups, item.outboundLineGroupIds, false, true)}${selectField('extensions', 'Ramais diretos', extensions, item.routing?.extensions, false, true)}${field('ringTimeoutSeconds', 'Tempo de toque (segundos)', item.routing?.ringTimeoutSeconds || 20, 'number', true, false, 'min="1"')}${switchField('disableBasicInbound', 'Desativar atendimento básico', item.routing?.basicInboundEnabled === false)}<p class="muted wide">Exige ao menos um destino avançado válido. Se o último destino for removido, o atendimento básico será reativado.</p>`;
    }
    if (resource === 'extensions') {
        const distanceFields = extensionGroups.map((group, index) => field(`extensionGroupDistance:${group.id}`, `Prioridade · ${group.label || group.id}`, item.extensionGroupDistances?.[group.id] || index + 1, 'number', false, false, 'min="1"')).join('');
        const companyField = managedAutomatic
            ? `<input type="hidden" name="companyId" value="${escapeHtml(`${item.companyId || ''}`)}">${field('_companyLabel', 'Empresa (gerenciada)', companyName(state, item.companyId), 'text', false, true)}`
            : selectField('companyId', 'Empresa', companies, item.companyId, true);
        const typeField = managedAutomatic
            ? `<input type="hidden" name="type" value="both">${field('_typeLabel', 'Transportes (gerenciados)', 'SIP e WebRTC', 'text', false, true)}`
            : `<label class="field"><span>Tipo</span><select name="type"><option value="both" ${selected(item.type, 'both')}>SIP e WebRTC</option><option value="sip" ${selected(item.type, 'sip')}>SIP/RTP</option><option value="webrtc" ${selected(item.type, 'webrtc')}>WebRTC</option></select></label>`;
        fields += `${field('displayName', 'Nome do ramal', item.displayName, 'text', true)}${field('username', 'Usuário SIP', item.username, 'text', true, managedAutomatic)}${field('password', isNew ? 'Senha SIP' : 'Nova senha SIP (opcional)', '', 'password', isNew)}${companyField}${typeField}${sipEndpointModeField(item.sipEndpointMode)}${selectField('extensionGroupIds', 'Grupos', extensionGroups, item.extensionGroupIds, false, true)}${distanceFields ? `<h3 class="wide">Distância nos grupos</h3>${distanceFields}<p class="muted wide">Menor número significa maior prioridade de toque dentro dos grupos selecionados.</p>` : ''}`;
    }
    const content = `<form class="form-grid voip-editor-form" data-form="voip-resource-fields"><input type="hidden" name="resource" value="${resource}">${fields}<div class="form-actions wide">${!isNew && !managedAutomatic ? `<button class="btn btn--danger" type="button" data-action="delete-voip-resource" data-resource="${resource}" data-id="${escapeHtml(id)}">${icon('trash')}Excluir</button>` : ''}<button class="btn" type="submit">${icon('save')}Salvar</button></div></form>`;
    return renderModal('voip-resource', `${isNew ? 'Adicionar' : 'Editar'} ${labels[resource].toLowerCase()}`, content, { subtitle: 'Telefonia', wide: true });
};
export const renderVoipRecordingSettingsModal = (state) => {
    const value = state.recording || {};
    return renderModal('voip-recording-settings', 'Configurar gravações', `<form class="form-grid" data-form="voip-recording-settings">${switchField('enabled', 'Gravar chamadas', value.enabled)}<label class="field"><span>Destino</span><select name="provider"><option value="local" ${selected(value.provider, 'local')}>Disco local</option><option value="s3" ${selected(value.provider, 's3')}>S3 compatível</option></select></label><label class="field"><span>Formato</span><select name="format"><option value="mp3" ${selected(value.format, 'mp3')}>MP3</option><option value="wav" ${selected(value.format, 'wav')}>WAV</option><option value="gsm" ${selected(value.format, 'gsm')}>GSM</option></select></label>${field('localDir', 'Diretório local', value.localDir || '/home/u/app/data/recordings')}${field('retentionDays', 'Retenção em dias (0 não remove)', value.retentionDays || 0, 'number', false, false, 'min="0"')}${switchField('stereo', 'Gravar em estéreo', value.stereo)}${switchField('deleteLocalAfterUpload', 'Remover arquivo local após enviar ao S3', value.deleteLocalAfterUpload !== false)}${field('s3Endpoint', 'Endpoint S3', value.s3Endpoint)}${field('s3Region', 'Região S3', value.s3Region || 'auto')}${field('s3Bucket', 'Bucket', value.s3Bucket)}${field('s3AccessKeyId', 'Access key', value.s3AccessKeyId)}${field('s3SecretAccessKey', 'Secret key (deixe vazio para manter)', '', 'password')}${configuredSecret(value.hasS3SecretAccessKey)}${switchField('s3ForcePathStyle', 'Forçar path style no S3', value.s3ForcePathStyle !== false)}${field('s3PublicBaseUrl', 'URL pública opcional', value.s3PublicBaseUrl)}${field('s3PresignTtlSeconds', 'Validade da URL assinada (segundos)', value.s3PresignTtlSeconds || 3600, 'number', true, false, 'min="60"')}<div class="form-actions wide"><button class="btn" type="submit">${icon('save')}Salvar</button></div></form>`, { subtitle: 'Telefonia', wide: true });
};
export const renderVoipCredentialsModal = (value) => {
    const rows = [
        ['Usuário', value.username],
        ['Senha', value.password],
        ['URI SIP', value.sipUri],
        ['WebSocket público', value.webrtc?.ws_url],
        ['WebSocket local', value.webrtc?.lan_ws_url],
        ['Domínio SIP', value.webrtc?.sip_domain],
    ].filter(([, item]) => item);
    return renderModal('voip-credentials', 'Credenciais do ramal', `<div class="stack"><p class="muted">Use os mesmos dados em um telefone SIP ou cliente WebRTC. Somente administradores podem revelar a senha.</p><dl class="details-list">${rows.map(([label, item]) => `<div><dt>${escapeHtml(`${label}`)}</dt><dd><code>${escapeHtml(`${item}`)}</code> <button class="btn btn--icon btn--ghost" type="button" data-action="copy-value" data-value="${escapeHtml(`${item}`)}" aria-label="Copiar ${escapeHtml(`${label}`)}">${icon('copy')}</button></dd></div>`).join('')}</dl><form class="form-grid" data-form="voip-sip-mode"><input type="hidden" name="extensionId" value="${escapeHtml(`${value.extensionId || ''}`)}">${sipEndpointModeField(value.sipEndpointMode)}<div class="form-actions wide"><button class="btn" type="submit">${icon('save')}Salvar modo SIP</button></div></form></div>`, { subtitle: value.displayName || value.username || 'Telefonia', wide: true });
};
export const voipResourceItem = (state, resource, id) => asItems(state[resource]).find(item => `${item.id}` === id);
