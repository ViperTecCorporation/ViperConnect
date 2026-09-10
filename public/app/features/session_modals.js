import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { renderModal } from '../components/modal.js?v=4.0.30-038921da';
import { renderStatus } from '../components/status.js?v=4.0.30-038921da';
import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { sessionLabel, sessionPhone } from '../domain/session.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
export const renderNewSessionModal = () => renderModal('new-session', t('Nova sessão'), `
    <form class="stack" data-form="new-session">
      <p class="muted">${t('Novas sessões são registradas diretamente no motor Zapo.')}</p>
      <div class="form-grid">
        <label class="field"><span>${t('Telefone')}</span><input name="phone" inputmode="numeric" placeholder="${t('55 DDD número')}" required></label>
        <label class="field"><span>${t('Nome da sessão')}</span><input name="label" placeholder="${t('Ex.: Comercial · account 1')}"></label>
        <label class="field"><span>${t('Tipo de conexão')}</span><select name="connectionType"><option value="qrcode">QR Code</option><option value="pairing_code">${t('Código de pareamento')}</option></select></label>
      </div>
      <div class="form-actions"><button class="btn" type="submit">${icon('plus')}${t('Registrar sessão')}</button></div>
    </form>
  `, { subtitle: t('Motor Zapo') });
export const renderMessageModal = (session, recipient = '') => renderModal('message-test', t('Testar mensagem'), `
    <form class="stack" data-form="test-message">
      <input name="phone" type="hidden" value="${escapeHtml(sessionPhone(session))}">
      <label class="field"><span>${t('Destinatário')}</span><input name="to" value="${escapeHtml(recipient)}" placeholder="${t('Telefone, LID ou ID do grupo')}" required></label>
      <label class="field"><span>${t('Mensagem')}</span><textarea name="body" rows="5" required></textarea></label>
      <div class="form-actions"><button class="btn" type="submit">${icon('send')}${t('Enviar teste')}</button></div>
    </form>
  `, { subtitle: sessionLabel(session) });
export const renderConnectionModal = (session, broadcast, loading = false) => {
    const phone = sessionPhone(session);
    const qr = broadcast?.type === 'qrcode' && broadcast.content ? broadcast.content : '';
    const statusText = broadcast?.type === 'status' && broadcast.content
        ? broadcast.content
        : loading ? t('Solicitando pareamento…') : t('Aguardando evento da sessão');
    const method = session.connectionType === 'pairing_code' ? t('Código de pareamento') : 'QR Code';
    const pairingCode = broadcast?.type === 'qrcode' && broadcast.content && !broadcast.content.startsWith('data:image')
        ? broadcast.content
        : '';
    return renderModal('session-connection', t('Conectar sessão'), `
    <div class="connection-layout">
      <div class="qr-box">
        ${qr && !pairingCode
        ? `<img src="${escapeHtml(qr)}" alt="${escapeHtml(t('QR Code da sessão {phone}', { phone }))}">`
        : pairingCode
            ? `<div class="pairing-code"><span>${t('Código')}</span><strong>${escapeHtml(pairingCode)}</strong></div>`
            : `<div class="qr-placeholder">${icon('refresh')}<span>${t('Aguardando código')}</span></div>`}
      </div>
      <div class="stack">
        <div>${renderStatus(session.status)} <strong>${escapeHtml(sessionLabel(session))}</strong></div>
        <dl class="details-list">
          <div><dt>${t('Telefone')}</dt><dd>${escapeHtml(phone)}</dd></div>
          <div><dt>${t('Método da sessão')}</dt><dd>${escapeHtml(method)}</dd></div>
          <div><dt>${t('Servidor')}</dt><dd>${escapeHtml(session.server || 'server_1')}</dd></div>
        </dl>
        <p class="muted" aria-live="polite">${escapeHtml(statusText)}</p>
        <p class="hint">${t('O tipo de conexão permanece o mesmo enquanto a sessão não receber deregister.')}</p>
        <div class="form-actions">
          <button class="btn" type="button" data-action="request-connection" data-phone="${escapeHtml(phone)}">${icon('refresh')}${t('Gerar novo código')}</button>
        </div>
      </div>
    </div>
  `, { subtitle: t('Sessão {phone}', { phone }), wide: true });
};
export const renderConfirmDeregisterModal = (session) => renderModal('deregister-session', t('Desconectar sessão'), `
    <div class="stack">
      <p>${escapeHtml(t('Esta ação executa deregister em {session} e exigirá um novo pareamento.', { session: sessionLabel(session) }))}</p>
      <p class="form-error">${icon('warning')}${t('As credenciais nativas da sessão serão removidas.')}</p>
      <div class="form-actions">
        <button class="btn btn--danger" type="button" data-action="confirm-deregister" data-phone="${escapeHtml(sessionPhone(session))}">${icon('trash')}${t('Confirmar desconexão')}</button>
      </div>
    </div>
  `);
