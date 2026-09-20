import { escapeHtml as e } from '../core/html.js?v=4.0.32-1ab9d8f1';
import { historyControls, historyTable } from './voip.js?v=4.0.32-1ab9d8f1';
import { scopedHistoryItems } from '../domain/voip_history.js?v=4.0.32-1ab9d8f1';
export const scopedExtensions = (state) => {
    if (!state.capabilities?.automaticExtensions)
        return [];
    const ids = new Set((state.zapoLines || []).filter(line => line.session && line.automatic?.extensionId).map(line => line.automatic.extensionId));
    return (state.extensions || []).filter(extension => ids.has(extension.id));
};
export const scopedRegistrations = (state) => {
    if (!state.capabilities?.extensionRegistrations)
        return [];
    const ids = new Set(scopedExtensions(state).map(extension => extension.id));
    return [
        ...(state.registrations?.webrtc || []).map((row) => ({ ...row, transport: 'webrtc' })),
        ...(state.registrations?.sipRtp || []).map((row) => ({ ...row, transport: 'sip_rtp' })),
    ].filter(row => typeof row.id === 'string' && ids.has(row.id) && typeof row.registrationId === 'string' && row.registrationId);
};
export const canDisconnectScopedRegistration = (state) => state.capabilities?.extensionRegistrations === true && state.capabilities.disconnectRegistration !== false;
const renderAutomaticResources = (state) => {
    const extensions = scopedExtensions(state);
    const registrations = scopedRegistrations(state);
    return `${(state.capabilities?.automaticLines ?? state.capabilities?.lines) ? `<section class="section"><h2>Minhas linhas</h2><div class="table-wrap"><table><thead><tr><th>Sessão</th><th>Conexão</th><th>Ramal automático</th></tr></thead><tbody>
    ${(state.zapoLines || []).map(line => `<tr><td>${e(line.session)}</td><td>${line.connected ? 'Conectada' : 'Desconectada'}</td><td>${e(line.automatic?.username || line.automatic?.extensionId || 'Aguardando provisionamento')}</td></tr>`).join('') || '<tr><td colspan="3">Nenhuma linha atribuída.</td></tr>'}
    </tbody></table></div></section>` : ''}
    ${state.capabilities?.automaticExtensions ? `<section class="section"><h2>Meus ramais automáticos</h2><div class="table-wrap"><table><thead><tr><th>Ramal</th><th>Sessão</th><th>Status</th><th>Ações</th></tr></thead><tbody>
    ${extensions.map(extension => `<tr><td>${e(extension.displayName || extension.username || extension.id)}</td><td>${(state.zapoLines || []).filter(line => line.automatic?.extensionId === extension.id).map(line => e(line.session)).join(', ')}</td><td>${extension.enabled === false ? 'Desativado' : 'Ativo'}</td><td>${state.capabilities?.extensionCredentials ? `<button class="btn btn--ghost" type="button" data-action="show-voip-credentials" data-id="${e(extension.id)}">Ver credenciais</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">Nenhum ramal automático disponível.</td></tr>'}
    </tbody></table></div></section>` : ''}
    ${state.capabilities?.extensionRegistrations ? `<section class="section"><h2>Meus registros ativos</h2><div class="table-wrap"><table><thead><tr><th>Ramal</th><th>Transporte</th><th>Cliente</th><th>Ações</th></tr></thead><tbody>
    ${registrations.map(row => `<tr><td>${e(row.displayName || row.username || row.id)}</td><td>${row.transport === 'webrtc' ? 'WebRTC' : 'SIP/RTP'}</td><td>${e(row.userAgent || '—')}</td><td>${canDisconnectScopedRegistration(state) ? `<button class="btn btn--danger" type="button" data-action="drop-voip-registration" data-extension-id="${e(row.id)}" data-registration-id="${e(row.registrationId)}" data-registration-type="${row.transport}">Desconectar</button>` : 'Somente consulta'}</td></tr>`).join('') || '<tr><td colspan="4">Nenhum registro ativo.</td></tr>'}
    </tbody></table></div></section>` : ''}`;
};
export const renderScopedVoip = (state, loading, error, urls = {}, phones = (state.zapoLines || []).map(line => line.session)) => `
  <header class="page-header"><div><h1>Telefonia</h1><p>Linhas, ramais automáticos e chamadas das suas sessões atribuídas.</p></div><button class="btn" data-action="refresh-voip">${loading ? 'Atualizando…' : 'Atualizar'}</button></header>
  ${error ? `<p class="form-error" role="alert">${e(error)}</p>` : ''}
  ${renderAutomaticResources(state)}
  ${state.capabilities?.history === true ? `<section class="section"><h2>Chamadas e gravações</h2>${historyControls(state)}${historyTable({ ...state, history: { ...state.history, items: scopedHistoryItems(state, phones) } }, urls, true)}</section>` : ''}
  ${state.capabilities?.activeCalls ? `<section class="section"><h2>Chamadas em andamento</h2><div class="table-wrap"><table><thead><tr><th>Chamada</th><th>Sessão</th><th>Direção</th><th>Contato</th><th>Ações</th></tr></thead><tbody>
  ${state.calls.map(call => `<tr><td>${e(call.callId)}</td><td>${e(call.session)}</td><td>${e(call.direction)}</td><td>${e(call.callerName || call.callerPn || call.peerJid || '—')}</td><td><div class="row-actions">
    ${state.capabilities?.callCommands ? [['accept', 'Aceitar'], ['reject', 'Rejeitar'], ['end', 'Encerrar'], ['mute', 'Silenciar'], ['unmute', 'Ativar áudio']]
    .filter(([command]) => call.direction === 'incoming' || !['accept', 'reject'].includes(command))
    .map(([command, label]) => `<button class="btn btn--ghost" data-action="scoped-voip-command" data-command="${command}" data-session="${e(call.session)}" data-call-id="${e(call.callId)}">${label}</button>`).join('') : ''}
    </div></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma chamada ativa.</td></tr>'}
  </tbody></table></div></section>` : '<p>Chamadas indisponíveis até confirmar as permissões do servidor.</p>'}`;
