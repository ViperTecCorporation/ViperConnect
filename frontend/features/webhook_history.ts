import { escapeHtml } from '../core/html.js'
export interface WebhookHistorySnapshot {
  id: string; archived_at: string; reason: string; server: string
  webhooks: { id: string; destination: string; has_credentials: boolean; events: string[] }[]
}
export function renderWebhookHistory(snapshots: WebhookHistorySnapshot[], loading: boolean, error: string): string {
  return `<section class="section"><h2>Restaurar webhooks anteriores</h2>
    <p>Histórico exclusivo do administrador. A restauração mantém os IDs e deixa os webhooks desativados. Revise o destino antes de ativá-los; mensagens antigas não serão reenviadas.</p>
    <button class="btn" type="button" data-action="load-webhook-history">Atualizar histórico</button>
    ${loading ? '<p>Carregando histórico…</p>' : ''}${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
    ${!loading && !error && !snapshots.length ? '<p>Nenhum histórico disponível para esta sessão.</p>' : ''}
    ${snapshots.map(snapshot => `<form class="stack section" data-form="restore-webhook-history">
      <input type="hidden" name="snapshot_id" value="${escapeHtml(snapshot.id)}">
      <p>${escapeHtml(snapshot.archived_at)} · ${escapeHtml(snapshot.server)} · ${escapeHtml(({ updated: 'Alteração de configuração', removed: 'Remoção da sessão', restored: 'Antes de uma restauração' } as Record<string, string>)[snapshot.reason] || snapshot.reason)}</p>
      ${snapshot.webhooks.map(hook => `<label><input type="checkbox" name="webhook_ids" value="${escapeHtml(hook.id)}"> ${escapeHtml(hook.id)} — ${escapeHtml(hook.destination || 'Destino sem prévia')}<small> · ${escapeHtml(hook.events.join(', '))}${hook.has_credentials ? ' · Credenciais preservadas (ocultas)' : ''}</small></label>`).join('')}
      <label><input type="checkbox" name="replace_existing"> Autorizar substituição dos webhooks atuais com os mesmos IDs</label>
      <button class="btn" type="submit">Restaurar selecionados como desativados</button>
    </form>`).join('')}</section>`
}
