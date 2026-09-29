import { escapeHtml as esc } from '../core/html.js'

export interface AccountEmailStatus { email: string | null; verified: boolean; confirmed: boolean }
export function renderAccountEmail(status?: AccountEmailStatus): string {
  return `<div class="section__heading"><div><h3>E-mail da conta WhatsApp</h3><p class="muted">Exclusivo do aparelho principal. Não é o e-mail comercial público.</p></div></div>
    <form data-form="profile-email-get"><button class="btn" type="submit">Consultar situação atual</button></form>
    <p role="status" class="muted">${status ? `${esc(status.email || 'Nenhum e-mail cadastrado')} · ${status.confirmed ? 'Confirmado' : status.verified ? 'Verificado; falta confirmar' : 'Não verificado'}` : 'Consulte para visualizar o e-mail e a situação da conta.'}</p>
    <form class="stack" data-form="profile-email-set"><label class="field"><span class="field-label">E-mail da conta</span><input type="email" name="email" maxlength="320" required autocomplete="email" value="${esc(status?.email || '')}"></label><div class="form-actions"><button class="btn" type="submit">Salvar e-mail</button></div></form>
    <div class="stack"><p class="field-help">Após salvar, solicite o código. Verifique os seis dígitos recebidos e confirme a vinculação. Aguarde antes de solicitar outro código.</p>
    <form data-form="profile-email-request_code"><button class="btn" type="submit">Solicitar código por e-mail</button></form>
    <form class="stack" data-form="profile-email-verify"><label class="field"><span class="field-label">Código recebido</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="000000"></label><div class="form-actions"><button class="btn" type="submit">Verificar código</button></div></form>
    <form data-form="profile-email-confirm"><button class="btn btn--primary" type="submit">Confirmar vinculação do e-mail</button></form></div>`.replace(/<\/form>/g, '<p data-email-feedback role="status" aria-live="polite" hidden></p></form>')
}

export function accountEmailRequest(kind: string, data: FormData) {
  const operation = kind.slice('email-'.length)
  if (operation === 'get') return { method: 'GET' }
  if (!['set', 'request_code', 'verify', 'confirm'].includes(operation)) throw new Error('Ação de e-mail inválida.')
  const value = { operation, ...(operation === 'set' ? { email: String(data.get('email') || '').trim() } : {}),
    ...(operation === 'verify' ? { code: String(data.get('code') || '').trim() } : {}) }
  return { method: 'PUT', body: JSON.stringify({ value }) }
}
