import { escapeHtml } from '../core/html.js'
import type { SessionConfig } from '../domain/types.js'
import { sessionPhone } from '../domain/session.js'

export interface SessionDestination {
  id: string; name: string; url: string; server: string; enabled: boolean
  session_ids: string[]; auto_include_new_sessions: boolean; events: string[]
  heartbeat_interval_seconds: number; has_bearer_token: boolean; has_signing_secret: boolean
}
const events = ['connected', 'disconnected', 'unlinked', 'removed', 'unavailable', 'heartbeat']

export function sessionDestinationPayload(data: FormData): Record<string, unknown> {
  return {
    name: `${data.get('name') || ''}`, url: `${data.get('url') || ''}`, server: `${data.get('server') || ''}`,
    enabled: data.has('enabled'), auto_include_new_sessions: data.has('auto_include_new_sessions'),
    session_ids: data.getAll('session_ids').map(String), events: data.getAll('events').map(String),
    heartbeat_interval_seconds: Number(data.get('heartbeat_interval_seconds') || 300),
    ...(data.get('bearer_token') ? { bearer_token: `${data.get('bearer_token')}` } : {}),
    ...(data.has('clear_bearer_token') ? { bearer_token: '' } : {}),
    ...(data.get('signing_secret') ? { signing_secret: `${data.get('signing_secret')}` } : {}),
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
      <fieldset class="stack"><legend>Eventos</legend>${events.map(name => `<label><input type="checkbox" name="events" value="session.${name}" ${(editing ? editing.events.includes(`session.${name}`) : name !== 'heartbeat') ? 'checked' : ''}> session.${name}</label>`).join('')}</fieldset>
      <label class="field">Intervalo heartbeat (segundos)<input type="number" min="60" max="86400" name="heartbeat_interval_seconds" value="${editing?.heartbeat_interval_seconds || 300}"></label>
      <label class="field">Bearer token (opcional; vazio preserva)<input type="password" autocomplete="new-password" name="bearer_token"></label>
      <label><input type="checkbox" name="clear_bearer_token"> Remover Bearer token</label>
      <label class="field">Segredo HMAC (mínimo 32 caracteres; vazio preserva)<input type="password" autocomplete="new-password" minlength="32" name="signing_secret" ${editing ? '' : 'required'}></label>
      <p>Segredos nunca são devolvidos pela API. Editar cancela entregas pendentes da configuração anterior. Excluir um destino não remove sessões.</p>
      <button class="btn btn--primary" type="submit">Salvar destino</button><button class="btn" type="button" data-action="edit-session-webhook">Novo / cancelar</button>
    </form></section>`
}
