import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { renderModal } from '../components/modal.js?v=4.0.30-038921da';
import { renderStatus } from '../components/status.js?v=4.0.30-038921da';
import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { renderInfoTooltip, renderSecretField, renderSwitchField } from '../components/form_controls.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
const webhookDestination = (webhook) => `${webhook.urlAbsolute || webhook.url || ''}`.trim();
const isEnabled = (webhook) => webhook.enabled !== false && webhook.disabled !== true && !!webhookDestination(webhook);
export const renderWebhooks = (webhooks) => `
  <div class="section__heading">
    <div><h2>${t('Webhooks')}</h2><p class="muted">${t('Destinos vinculados exclusivamente a esta sessão.')}</p></div>
    <button class="btn" type="button" data-action="new-webhook">${icon('plus')}${t('Adicionar webhook')}</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Status</th><th>${t('Destino')}</th><th class="table-actions">${t('Ação')}</th></tr></thead>
      <tbody>
        ${webhooks.length
    ? webhooks
        .map((webhook, index) => `
          <tr>
            <td>${renderStatus(isEnabled(webhook) ? 'online' : 'offline')}</td>
            <td class="destination">${escapeHtml(webhookDestination(webhook) || t('Destino não configurado'))}</td>
            <td class="table-actions"><button class="btn btn--ghost" type="button" data-action="edit-webhook" data-webhook-index="${index}">${icon('edit')}${t('Editar')}</button></td>
          </tr>
        `)
        .join('')
    : `<tr><td colspan="3"><div class="empty-state">${t('Nenhum webhook configurado.')}</div></td></tr>`}
      </tbody>
    </table>
  </div>
`;
const webhookSwitches = [
    ['enabled', 'Ativa/Inativa Webhook', 'Habilita o envio de eventos para este destino.', true],
    ['sendNewMessages', 'Novas mensagens', 'Envia o evento principal quando uma mensagem é criada.', false],
    ['sendIncomingMessages', 'Mensagens recebidas', 'Inclui mensagens recebidas pelo WhatsApp.', true],
    ['sendOutgoingMessages', 'Mensagens enviadas', 'Inclui mensagens enviadas pela API ou pelo aparelho.', true],
    ['sendUpdateMessages', 'Atualizações de mensagens', 'Inclui delivered, read, failed, edição e exclusão.', true],
    ['sendGroupMessages', 'Mensagens de grupos', 'Inclui mensagens e eventos originados em grupos.', true],
    ['sendNewsletterMessages', 'Mensagens de newsletter', 'Inclui mensagens de canais e newsletters.', false],
    ['sendTranscribeAudio', 'Transcrição de áudio', 'Inclui a transcrição quando o recurso estiver habilitado.', false],
    ['typebot', 'Payload Typebot', 'Adapta o payload deste destino para a integração Typebot.', false],
];
export const renderWebhookModal = (webhook, index) => renderModal('webhook-editor', index >= 0 ? t('Editar webhook') : t('Novo webhook'), `
    <form class="stack" data-form="webhook" data-webhook-index="${index}">
      <div class="form-grid">
        <label class="field"><span>ID</span><input name="id" value="${escapeHtml(webhook.id || 'default')}" required></label>
        <label class="field"><span>${t('Destino')}</span><input name="urlAbsolute" type="url" value="${escapeHtml(webhookDestination(webhook))}" placeholder="https://app.example.com/webhook" required></label>
        <label class="field"><span>Header</span><input name="header" value="${escapeHtml(webhook.header || 'Authorization')}"></label>
        ${renderSecretField('token', 'Token', webhook.token || '')}
        <label class="field"><span>Timeout (ms)</span><input name="timeoutMs" type="number" min="1000" value="${escapeHtml(webhook.timeoutMs || 360000)}"></label>
        <div class="field">
          <span class="field-label">
            <label for="webhook-outgoing-blacklist">${t('Blacklist na saída (segundos)')}</label>
            ${renderInfoTooltip(t('Após uma mensagem de saída, impede temporariamente que os eventos seguintes do mesmo destinatário sejam enviados a este webhook. O bloqueio vale somente para esta sessão e este webhook. Use zero ou deixe em branco para desativar.'))}
          </span>
          <input id="webhook-outgoing-blacklist" name="addToBlackListOnOutgoingMessageWithTtl" type="number" min="0" value="${escapeHtml(webhook.addToBlackListOnOutgoingMessageWithTtl || '')}">
        </div>
      </div>
      <div class="switch-grid">
        ${webhookSwitches
    .map(([name, label, description, defaultValue]) => {
    const value = name === 'enabled' ? webhook.enabled !== false && webhook.disabled !== true : webhook[name];
    return renderSwitchField(name, t(label), t(description), value ?? defaultValue);
})
    .join('')}
      </div>
      <div class="form-actions">
        ${index >= 0 ? `<button class="btn btn--danger btn--ghost" type="button" data-action="delete-webhook" data-webhook-index="${index}">${icon('trash')}${t('Remover')}</button>` : ''}
        <button class="btn" type="submit">${icon('save')}${t('Salvar webhook')}</button>
      </div>
    </form>
  `, { subtitle: t('Configuração da sessão'), wide: true });
const numericValue = (data, name, fallback) => {
    const value = Number(data.get(name));
    return Number.isFinite(value) ? value : fallback;
};
export const webhookPayload = (data) => ({
    id: `${data.get('id') || 'default'}`.trim(),
    url: '',
    urlAbsolute: `${data.get('urlAbsolute') || ''}`.trim(),
    enabled: data.has('enabled'),
    token: `${data.get('token') || ''}`,
    header: `${data.get('header') || 'Authorization'}`.trim(),
    timeoutMs: Math.max(1000, numericValue(data, 'timeoutMs', 360000)),
    sendNewMessages: data.has('sendNewMessages'),
    sendIncomingMessages: data.has('sendIncomingMessages'),
    sendOutgoingMessages: data.has('sendOutgoingMessages'),
    sendUpdateMessages: data.has('sendUpdateMessages'),
    sendGroupMessages: data.has('sendGroupMessages'),
    sendNewsletterMessages: data.has('sendNewsletterMessages'),
    sendTranscribeAudio: data.has('sendTranscribeAudio'),
    typebot: data.has('typebot'),
    addToBlackListOnOutgoingMessageWithTtl: Math.max(0, numericValue(data, 'addToBlackListOnOutgoingMessageWithTtl', 0)),
});
