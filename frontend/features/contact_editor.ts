import { renderModal } from '../components/modal.js'
import { escapeHtml } from '../core/html.js'
import { t } from '../core/i18n.js'
import type { ContactDirectoryItem } from '../domain/types.js'
import type { ApiClient } from '../core/api.js'

export const renderContactEditor = (contact?: ContactDirectoryItem): string => renderModal('contact-editor', t(contact ? 'Editar nome do contato' : 'Adicionar contato'), `
  <form class="stack" data-form="contact-name">
    <label class="field"><span>${t('Nome')}</span><input name="full_name" required maxlength="256" value="${escapeHtml(contact?.display_name || contact?.push_name || '')}" placeholder="${t('Nome do contato')}" autocomplete="off" aria-describedby="contact-name-help"></label>
    ${contact ? `<p class="muted">${escapeHtml(contact.phone_number || contact.user_id)}</p>` : `<label class="field"><span>${t('Telefone com código do país e DDD')}</span><input name="phone_number" type="tel" required maxlength="32" placeholder="+55 66 99999-9999" autocomplete="tel" aria-describedby="contact-phone-help"><small id="contact-phone-help" class="field-help">${t('Informe o país, DDD e número. Aceita +5566999999999 ou 5566999999999.')}</small></label>`}
    <div class="stack"><p id="contact-name-help" class="muted">${t('O nome salvo tem prioridade sobre o nome de perfil e será enviado à agenda do WhatsApp.')}</p>
    ${contact ? '' : `<p class="muted">${t('O número será verificado no WhatsApp antes do cadastro. Se já existir na agenda, o nome será atualizado.')}</p>`}</div>
    <div class="form-actions"><button type="button" class="btn btn--ghost" data-close-modal>${t('Cancelar')}</button><button type="submit" class="btn">${t('Salvar')}</button></div>
  </form>
`)

export async function saveContactName(api: ApiClient, phone: string, contact: Pick<ContactDirectoryItem, 'phone_number'> & { user_id?: string }, value: string): Promise<void> {
  const name = value.trim()
  const raw = `${contact.phone_number || ''}`.trim()
  const number = raw.replace(/[\s()+.-]/g, '')
  if (!name || name.length > 256) throw new Error(t('Informe um nome válido para o contato.'))
  if (!/^\+?[\d\s().-]+$/.test(raw) || !/^[1-9]\d{6,14}$/.test(number)
    || (number.startsWith('55') && !/^55[1-9]\d\d{8,9}$/.test(number))) {
    throw new Error(t('Informe um telefone com código do país, DDD e número. Exemplo: +5566999999999 ou 5566999999999.'))
  }
  const result = await api.request<{ success: boolean }>(`/${encodeURIComponent(phone)}/contacts/import`, {
    method: 'POST', body: JSON.stringify({ phone_number: number, user_id: contact.user_id, full_name: name }),
  })
  if (result.success !== true) throw new Error(t('Não foi possível salvar o nome do contato.'))
}
