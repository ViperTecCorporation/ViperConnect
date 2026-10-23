import { escapeHtml as e } from '../core/html.js?v=4.0.38-9a2d1afb';
import { renderModal } from '../components/modal.js?v=4.0.38-9a2d1afb';
const statuses = { pending: 'Pendente', published: 'Na fila', delivering: 'Em entrega', dead: 'Falha definitiva', delivered: 'Entregue', skipped: 'Ignorado' };
const technicalError = (value = '') => /^http_(?:[1-5]\d\d|5xx)$/i.test(value) ? value.toUpperCase()
    : ['timeout', 'network_error', 'invalid_receipt', 'invalid_response', 'destination_changed', 'destination_changed_or_disabled', 'destination_unavailable', 'max_attempts', 'invalid_payload', 'delivery_failed'].includes(value) ? value : value ? 'delivery_error' : '—';
const date = (value) => {
    const parsed = new Date(typeof value === 'number' ? value : `${value || ''}`);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('pt-BR') : '—';
};
export const replayWebhookPayload = (ids, requestId) => {
    const eventIds = [...new Set(ids)];
    if (!eventIds.length || eventIds.length > 20 || eventIds.some(id => !/^[a-f0-9]{64}$/.test(id))
        || !/^[a-f0-9-]{36}$/i.test(requestId))
        throw new Error('invalid_webhook_replay');
    return { eventIds, confirm: true, requestId };
};
export const renderWebhookDiagnostics = (modal) => {
    const value = modal.value || {};
    const items = value.items || [];
    const safeId = (id) => /^[a-f0-9]{64}$/.test(id);
    const summary = Object.entries(statuses).map(([key, label]) => `<span>${label}: <strong>${Number(value.counts?.[key]) || 0}</strong></span>`).join(' · ');
    const confirmation = modal.confirmIds?.length ? `<section class="card stack" role="alertdialog" aria-label="Confirmar reprocessamento"><h3>Reprocessar ${modal.confirmIds.length} evento(s)?</h3><p>Somente os eventos selecionados desta empresa serão reenfileirados para o mesmo destino original. Conteúdo, IDs e tentativas serão preservados. Não altera configurações nem reenvia eventos entregues.</p><div class="row-actions"><button class="btn btn--danger" type="button" data-action="confirm-voip-webhook-replay" ${modal.loading ? 'disabled' : ''}>Confirmar reprocessamento</button><button class="btn btn--ghost" type="button" data-action="cancel-voip-webhook-replay">Cancelar</button></div></section>` : '';
    return renderModal('voip-webhook-diagnostics', 'Entregas ao ViperChat', `<div class="stack"><p class="muted">Diagnóstico administrativo da empresa. Sem conteúdo das chamadas, telefones, áudio ou credenciais.</p><p role="status">${summary}</p>${modal.error ? `<p class="form-error" role="alert">${e(modal.error)}</p>` : ''}${confirmation}<div class="row-actions"><button class="btn btn--ghost" type="button" data-action="refresh-voip-webhook-diagnostics" ${modal.loading ? 'disabled' : ''}>${modal.loading ? 'Atualizando…' : 'Atualizar'}</button></div><div class="stack">${items.map(item => `<article class="card stack"><div><strong>${e(statuses[item.status] || 'Desconhecido')}</strong> · ${Number(item.attempts) || 0} tentativa(s)</div><code style="overflow-wrap:anywhere;word-break:break-all">${safeId(item.eventId) ? e(item.eventId) : 'ID indisponível'}</code><div>Motivo técnico: ${e(technicalError(item.errorCode))}</div><small class="muted">Criado: ${e(date(item.createdAt))} · Próxima tentativa: ${e(date(item.nextAttemptAt))}</small>${item.replayAllowed === true && item.destinationMatches === true && ['dead', 'pending'].includes(item.status) && safeId(item.eventId) ? `<div><button class="btn btn--ghost" type="button" data-action="prepare-voip-webhook-replay" data-event-id="${e(item.eventId)}" ${modal.loading ? 'disabled' : ''}>Reprocessar evento</button></div>` : '<small class="muted">Reprocessamento indisponível neste estado ou destino.</small>'}</article>`).join('') || '<p>Nenhuma entrega encontrada.</p>'}</div>${value.hasMore ? '<p class="muted">Exibindo as 50 entregas mais recentes. Atualize após o processamento para consultar novamente.</p>' : ''}</div>`, { subtitle: 'Telefonia · Empresa', wide: true });
};
