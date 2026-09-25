import { escapeHtml as e } from '../core/html.js'
import { icon } from '../components/icons.js'
import { renderStatus } from '../components/status.js'
import { isOnlineStatus, sessionPhone } from '../domain/session.js'
import type { SessionConfig } from '../domain/types.js'
import type { MobileDraft } from './mobile_devices.js'

// Match the persisted owner ID, not a phone guess: a draft can coexist with an
// unrelated companion session for the same number before registration/import.
export function mobileGridSession(device: MobileDraft, sessions: SessionConfig[]): SessionConfig | undefined {
  return sessions.find(session => session.mobilePrimaryDraftId === device.id)
}

export function renderMobileDeviceGrid(devices: MobileDraft[], sessions: SessionConfig[], query: string, status: string): string {
  const needle = query.trim().toLocaleLowerCase('pt-BR')
  const rows = devices.map(device => ({ device, session: mobileGridSession(device, sessions) })).filter(({ device, session }) => {
    const text = `${device.name} ${device.phone} ${session?.label || ''} ${session ? sessionPhone(session) : ''}`.toLocaleLowerCase('pt-BR')
    const state = session?.status || 'offline'
    return (!needle || text.includes(needle)) && (status === 'all' || status === state || (status === 'offline' && state === 'disconnected'))
  })
  return `<section class="section sessions-section"><div class="section__heading"><div><h2>Dispositivos principais <small>Experimental</small></h2><p class="muted">Gerencie os dispositivos principais separadamente das sessões vinculadas. Rascunhos sem sessão ainda não permitem gerenciar ou enviar mensagens.</p></div></div>
    <div class="filters"><label class="search-field">${icon('search')}<input data-filter="mobile-query" value="${e(query)}" placeholder="Buscar nome ou telefone" aria-label="Buscar dispositivo"></label>
    <label class="field field--compact"><span class="sr-only">Status do dispositivo</span><select data-filter="mobile-status">${[['all', 'Todos os status'], ['online', 'Online'], ['connecting', 'Conectando'], ['offline', 'Offline']].map(([value, label]) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <div class="table-wrap"><table class="session-table"><thead><tr><th>Dispositivo</th><th>Status</th><th>Worker</th><th class="table-actions">Ações</th></tr></thead><tbody>${rows.length ? rows.map(({ device, session }) => {
      const phone = session ? sessionPhone(session) : device.phone
      const usable = !!session && device.state !== 'deleting'
      return `<tr><td><div class="session-identity"><span class="session-identity__icon">${icon('whatsapp', 'WhatsApp')}</span><span><strong>${e(session?.label || device.name)}</strong><small>${e(phone)}</small><small>${device.platform === 'ios' ? 'iPhone' : 'Android'} · ${device.accountType === 'business' ? 'Business' : 'Pessoal'}</small></span></div></td>
        <td>${device.state === 'deleting' ? 'Exclusão em andamento' : session ? renderStatus(session.status) : 'Cadastro sem sessão'}</td><td>${e(session?.server || '—')}</td>
        <td class="table-actions"><div class="row-actions">
        <button class="btn btn--ghost" type="button" data-action="manage-session" data-phone="${e(phone)}" ${usable ? '' : 'disabled title="O dispositivo ainda não possui sessão disponível"'}>${icon('settings')}Gerenciar</button>
        <button class="btn btn--icon btn--ghost" type="button" data-action="test-message" data-phone="${e(phone)}" aria-label="Enviar mensagem" title="Enviar mensagem" ${usable && isOnlineStatus(session?.status) ? '' : 'disabled'}>${icon('send')}</button>
        <button class="btn btn--ghost" type="button" data-action="mobile-details" data-id="${e(device.id)}">Visão geral do dispositivo</button>
        <button class="btn btn--ghost" type="button" data-action="mobile-remove" data-id="${e(device.id)}">Excluir dispositivo</button>
        </div></td></tr>`
    }).join('') : '<tr><td colspan="4"><div class="empty-state">Nenhum dispositivo encontrado.</div></td></tr>'}</tbody></table></div></section>`
}
