import { escapeHtml } from '../core/html.js'
import type { SessionConfig } from '../domain/types.js'
import { sessionPhone } from '../domain/session.js'
import { renderInfoTooltip } from '../components/form_controls.js'

export interface SessionDestination {
  id: string; name: string; url: string; server: string; enabled: boolean
  session_ids: string[]; auto_include_new_sessions: boolean; events: string[]
  heartbeat_interval_seconds: number; has_bearer_token: boolean; has_signing_secret: boolean
}
const events = {
  connected: 'A conexão foi aberta pelo provider ou a observação local de conexão foi retomada. Envia event=session.connected e state.current=connected. Não garante que toda mensagem será entregue.',
  disconnected: 'A conexão foi fechada, sem confirmação de desvinculação. Envia event=session.disconnected e state.current=disconnected. connection.reason/code indicam a causa quando conhecida; reconnect_expected indica expectativa, não garantia de reconexão.',
  unlinked: 'O provider informou logout/desvinculação. Envia event=session.unlinked, state.current=unlinked e connection.is_logout=true. É necessário parear novamente; não significa que a sessão foi excluída da UnoAPI.',
  removed: 'A configuração da sessão foi removida da UnoAPI. Envia event=session.removed e state.current=removed aos destinos vinculados antes da remoção. Não significa apenas uma queda de conexão.',
  unavailable: 'Uma sessão antes conectada ficou mais de 120 segundos sem observação do worker. Envia event=session.unavailable, state.current=unavailable e connection.reason=worker_observation_expired. Não comprova desconexão no WhatsApp; pode indicar falha do worker.',
  heartbeat: 'Envia periodicamente event=session.heartbeat e state.current=connected enquanto o worker considera a sessão conectada, respeitando o intervalo configurado. Atualiza last_observed_at, não last_verified_at. Não envia presença ao WhatsApp nem comprova uma resposta remota.',
}

export function sessionDestinationPayload(data: FormData): Record<string, unknown> {
  return {
    name: `${data.get('name') || ''}`, url: `${data.get('url') || ''}`, server: `${data.get('server') || ''}`,
    enabled: data.has('enabled'), auto_include_new_sessions: data.has('auto_include_new_sessions'),
    session_ids: data.getAll('session_ids').map(String), events: data.getAll('events').map(String),
    heartbeat_interval_seconds: Number(data.get('heartbeat_interval_seconds') || 300),
    ...(data.get('bearer_token') ? { bearer_token: `${data.get('bearer_token')}` } : {}),
    ...(data.has('clear_bearer_token') ? { bearer_token: '' } : {}),
    ...(data.get('signing_secret') ? { signing_secret: `${data.get('signing_secret')}` } : {}),
    ...(data.has('clear_signing_secret') ? { signing_secret: '' } : {}),
  }
}

export function renderSessionWebhooks(destinations: SessionDestination[], sessions: SessionConfig[], editingId = '', error = '', selectedPhone = ''): string {
  const editing = destinations.find(d => d.id === editingId)
  const e = escapeHtml
  return `<section class="page-header"><div><h1>Webhooks de sessões</h1><p>Integrações de status independentes dos webhooks de mensagens. Requer token administrativo.</p></div>
    <button class="btn" data-action="refresh-session-webhooks">Atualizar</button></section>
    ${error ? `<p role="alert">${e(error)}</p>` : ''}
    ${selectedPhone ? `<section class="section"><h2>Sessão ${e(selectedPhone)}</h2><p>Destinos vinculados: ${destinations.filter(d => d.session_ids.includes(selectedPhone)).map(d => e(d.name)).join(', ') || 'Nenhum'}</p></section>` : ''}
    <section class="section"><h2>Destinos</h2>${destinations.map(d => `<div class="actions"><strong>${e(d.name)}</strong>
      <span>${e(d.server)} · ${d.session_ids.length} sessões · ${d.enabled ? 'Ativo' : 'Desativado'}</span>
      <button class="btn" data-action="edit-session-webhook" data-id="${e(d.id)}">Editar</button>
      <button class="btn" data-action="delete-session-webhook" data-id="${e(d.id)}">Excluir</button></div>`).join('') || '<p>Nenhum destino configurado.</p>'}</section>
    <section class="section"><h2>${editing ? 'Editar destino' : 'Novo destino'}</h2>
    <form class="stack" data-form="session-destination"><input type="hidden" name="id" value="${e(editing?.id || '')}">
      <label class="field">Nome<input name="name" maxlength="100" required value="${e(editing?.name || '')}"></label>
      <label class="field">URL HTTP(S)<input type="url" name="url" required value="${e(editing?.url || '')}"></label>
      <label class="field">Servidor<input name="server" required value="${e(editing?.server || 'server_1')}"></label>
      <p>Selecione apenas sessões desse servidor. Inclusão futura abrange novas sessões Zapo desse servidor, inclusive outras integrações: use servidores distintos para isolar clientes.</p>
      <label><input type="checkbox" name="enabled" ${editing?.enabled !== false ? 'checked' : ''}> Ativo</label>
      <label><input type="checkbox" name="auto_include_new_sessions" ${editing?.auto_include_new_sessions ? 'checked' : ''}> Vincular automaticamente novas sessões</label>
      <fieldset class="stack"><legend>Sessões atuais (não são incluídas pela opção acima)</legend>
        <button type="button" class="btn" data-action="select-current-session-webhooks">Selecionar todas deste servidor</button>
        ${sessions.filter(s => s.provider === 'zapo').map(s => {
          const phone = sessionPhone(s)
          return `<label><input type="checkbox" name="session_ids" data-server="${e(s.server || 'server_1')}" value="${e(phone)}" ${editing?.session_ids.includes(phone) ? 'checked' : ''}> ${e(s.label || phone)} (${e(phone)})</label>`
        }).join('')}
      </fieldset>
      <fieldset class="stack"><legend>Eventos</legend>${Object.entries(events).map(([name, description]) => `<div class="switch-field"><label><input type="checkbox" name="events" value="session.${name}" ${(editing ? editing.events.includes(`session.${name}`) : name !== 'heartbeat') ? 'checked' : ''}> session.${name}</label>${renderInfoTooltip(description)}</div>`).join('')}
        <div class="actions"><span>Dados enviados e resposta esperada</span>${renderInfoTooltip('Todos enviam JSON com schema_version, event_id, event, occurred_at, destination_id, session (id, label, provider, server), state (previous, current, changed_at, sequence), connection e last_verified_at/last_observed_at. Dados desconhecidos podem ser null. O destino deve responder HTTP 2xx após aceitar o evento. Podem ocorrer repetições: deduplique por destination_id + event_id e aplique apenas state.sequence superior.')}</div>
      </fieldset>
      <label class="field">Intervalo heartbeat (segundos)<input type="number" min="60" max="86400" name="heartbeat_interval_seconds" value="${editing?.heartbeat_interval_seconds || 300}"></label>
      <label class="field">Bearer token (opcional; vazio preserva)<input type="password" autocomplete="new-password" name="bearer_token"></label>
      <label><input type="checkbox" name="clear_bearer_token"> Remover Bearer token</label>
      <label class="field">Segredo HMAC (opcional; mínimo 32 caracteres quando informado; vazio preserva ao editar)<input type="password" autocomplete="new-password" minlength="32" maxlength="4096" name="signing_secret"></label>
      ${editing ? `<p>Assinatura HMAC: ${editing.has_signing_secret ? 'ativada' : 'desativada'}.</p><label><input type="checkbox" name="clear_signing_secret"> Remover assinatura HMAC</label>` : ''}
      <p>Sem segredo HMAC, o webhook é enviado sem assinatura. Bearer token é independente e opcional.</p>
      <p>Segredos nunca são devolvidos pela API. Editar cancela entregas pendentes da configuração anterior. Excluir um destino não remove sessões.</p>
      <button class="btn btn--primary" type="submit">Salvar destino</button><button class="btn" type="button" data-action="edit-session-webhook">Novo / cancelar</button>
    </form></section>`
}
