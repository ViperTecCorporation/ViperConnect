import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { renderInfoTooltip, renderSecretField, renderSwitchField } from '../components/form_controls.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
export const booleanSessionFields = [
    ['autoConnect', 'Conectar automaticamente', 'Reconecta esta sessão quando o worker for iniciado.'],
    ['ignoreGroupMessages', 'Ignorar mensagens de grupos', 'Não encaminha mensagens recebidas em grupos aos webhooks.'],
    ['ignoreNewsletterMessages', 'Ignorar newsletters', 'Descarta mensagens recebidas em canais e newsletters.'],
    ['ignoreHistoryMessages', 'Ignorar histórico de mensagens', 'Não encaminha mensagens antigas durante sincronizações de histórico.'],
    ['readOnReceipt', 'Ler ao receber', 'Marca mensagens recebidas como lidas automaticamente.'],
    ['readOnReply', 'Ler ao responder', 'Marca a conversa como lida quando a API envia uma resposta.'],
    ['markOnlineOnConnect', 'Marcar online ao conectar', 'Publica presença online logo após conectar a sessão.'],
    ['sendProfilePicture', 'Enviar foto de perfil no webhook', 'Inclui fotos atualizadas nos webhooks respeitando o intervalo de cache.'],
    ['sendConnectionStatus', 'Enviar status da conexão', 'Envia eventos de conexão e desconexão para a aplicação.'],
    ['notifyFailedMessages', 'Notificar mensagens com falha', 'Emite status failed quando o provedor rejeita uma ação de mensagem.'],
    ['composingMessage', 'Enviar “digitando”', 'Publica presença de digitação antes do envio.'],
    ['sendReactionAsReply', 'Enviar reação como resposta', 'Representa reações recebidas também como eventos de resposta.'],
    ['ignoreOwnMessages', 'Ignorar mensagens próprias', 'Descarta mensagens enviadas pelo próprio aparelho ou API.'],
    ['ignoreYourselfMessages', 'Ignorar mensagens para si mesmo', 'Descarta conversas cujo destinatário é a própria sessão.'],
    ['ignoreBroadcastStatuses', 'Ignorar Status', 'Não encaminha publicações de Status do WhatsApp.'],
    ['ignoreBroadcastMessages', 'Ignorar listas de transmissão', 'Não encaminha mensagens de listas de transmissão.'],
];
export const renderSessionConfig = (session) => `
  <form class="stack" data-form="session-config">
    <section class="section">
      <div class="section__heading">
        <div><h3>${t('Identificação e conexão')}</h3><p class="muted">${t('Configuração exclusiva desta sessão. O motor padrão é Zapo e não é selecionável no front.')}</p></div>
      </div>
      <div class="form-grid">
        <label class="field">
          <span>${t('Nome da sessão')}</span>
          <input name="label" value="${escapeHtml(session.label || '')}">
        </label>
        <label class="field">
          <span>${t('Telefone')}</span>
          <input value="${escapeHtml(session.phone || session.id || '')}" disabled>
        </label>
        <div class="field">
          <span class="field-label"><label for="connection-type">${t('Tipo de conexão')}</label> ${renderInfoTooltip(t('O método só pode ser alterado depois de desconectar a sessão.'))}</span>
          <input name="connectionType" type="hidden" value="${session.connectionType === 'pairing_code' ? 'pairing_code' : 'qrcode'}">
          <select id="connection-type" disabled aria-describedby="connection-type-hint">
            <option value="qrcode" ${session.connectionType !== 'pairing_code' ? 'selected' : ''}>QR Code</option>
            <option value="pairing_code" ${session.connectionType === 'pairing_code' ? 'selected' : ''}>${t('Código de pareamento')}</option>
          </select>
          <small id="connection-type-hint">${t('Para trocar o método, execute deregister e registre a sessão novamente.')}</small>
        </div>
        <label class="field field--connection-peer">
          <span class="field-label">${t('Servidor')}</span>
          <input name="server" value="${escapeHtml(session.server || 'server_1')}">
          <small aria-hidden="true">&nbsp;</small>
        </label>
        <label class="field field--wide">
          <span>Proxy</span>
          <input name="proxyUrl" value="${escapeHtml(session.proxyUrl || '')}" placeholder="${t('socks5://usuario:senha@host:porta')}">
        </label>
        ${renderSecretField('authToken', t('Token da sessão'), session.authToken || '')}
      </div>
    </section>

    <section class="section">
      <div class="section__heading"><div><h3>${t('Mensagens e comportamento')}</h3><p class="muted">${t('Leitura, histórico, presença e eventos enviados à aplicação.')}</p></div></div>
      <div class="switch-grid">
        ${booleanSessionFields.map(([name, label, description]) => renderSwitchField(name, t(label), t(description), session[name] === true)).join('')}
      </div>
      <div class="form-grid">
        <div class="field">
          <span class="field-label">
            <label for="history-max-age-days">${t('Janela do histórico (dias)')}</label>
            ${renderInfoTooltip(t('Define a idade máxima das mensagens de histórico encaminhadas aos webhooks. Só é aplicado quando “Ignorar histórico de mensagens” está desativado; o WhatsApp pode limitar o histórico disponível.'))}
          </span>
          <input id="history-max-age-days" name="historyMaxAgeDays" type="number" min="1" max="3650" value="${escapeHtml(session.historyMaxAgeDays || 30)}">
        </div>
        <div class="field field--wide">
          <span class="field-label">
            <label for="reject-calls">${t('Mensagem ao rejeitar chamadas')}</label>
            ${renderInfoTooltip(t('Esta mensagem é enviada ao contato quando a chamada é rejeitada. Para desabilitar o recurso, deixe este campo em branco.'))}
          </span>
          <textarea id="reject-calls" name="rejectCalls" rows="3">${escapeHtml(session.rejectCalls || '')}</textarea>
        </div>
        <div class="field field--wide">
          <span class="field-label">
            <label for="reject-calls-webhook">${t('Mensagem de chamada recebida/rejeitada no webhook')}</label>
            ${renderInfoTooltip(t('Esta mensagem é enviada à aplicação cadastrada no webhook quando uma chamada é recebida ou rejeitada.'))}
          </span>
          <textarea id="reject-calls-webhook" name="rejectCallsWebhook" rows="3">${escapeHtml(session.rejectCallsWebhook || '')}</textarea>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section__heading"><div><h3>${t('Áudio e IA')}</h3><p class="muted">${t('Credenciais permanecem vinculadas somente à sessão.')}</p></div></div>
      <div class="form-grid">
        ${renderSecretField('openaiApiKey', 'OpenAI API key', session.openaiApiKey || '')}
        <label class="field"><span>${t('Modelo OpenAI')}</span><input name="openaiApiTranscribeModel" value="${escapeHtml(session.openaiApiTranscribeModel || 'whisper-1')}"></label>
        ${renderSecretField('groqApiKey', 'Groq API key', session.groqApiKey || '')}
        <label class="field"><span>${t('Modelo Groq')}</span><input name="groqApiTranscribeModel" value="${escapeHtml(session.groqApiTranscribeModel || 'whisper-large-v3')}"></label>
        <label class="field field--wide"><span>${t('URL base Groq')}</span><input name="groqApiBaseUrl" value="${escapeHtml(session.groqApiBaseUrl || 'https://api.groq.com/openai/v1')}"></label>
      </div>
    </section>

    <section class="section">
      <div class="section__heading"><div><h3>${t('Limites por sessão')}</h3><p class="muted">${t('Use zero nos limites global ou por destinatário para desativá-los.')}</p></div></div>
      <div class="form-grid form-grid--three">
        <div class="field">
          <span class="field-label">
            <label for="rate-limit-global">${t('Global por minuto')}</label>
            ${renderInfoTooltip(t('Quantidade máxima de envios desta sessão em uma janela de 60 segundos. Ao exceder, os novos envios são reagendados. Use zero para desativar este limite.'))}
          </span>
          <input id="rate-limit-global" name="rateLimitGlobalPerMinute" type="number" min="0" value="${escapeHtml(session.rateLimitGlobalPerMinute || 0)}">
        </div>
        <div class="field">
          <span class="field-label">
            <label for="rate-limit-recipient">${t('Por destinatário/minuto')}</label>
            ${renderInfoTooltip(t('Quantidade máxima de envios ao mesmo destinatário em uma janela de 60 segundos. Ao exceder, os novos envios são reagendados. Use zero para desativar este limite.'))}
          </span>
          <input id="rate-limit-recipient" name="rateLimitPerToPerMinute" type="number" min="0" value="${escapeHtml(session.rateLimitPerToPerMinute || 0)}">
        </div>
        <div class="field">
          <span class="field-label">
            <label for="rate-limit-block">${t('Bloqueio (segundos)')}</label>
            ${renderInfoTooltip(t('Tempo de espera antes de reprocessar um envio que excedeu um dos limites. Este campo não desativa os limites; com zero, o atraso padrão é de 60 segundos.'))}
          </span>
          <input id="rate-limit-block" name="rateLimitBlockSeconds" type="number" min="0" value="${escapeHtml(session.rateLimitBlockSeconds || 60)}">
        </div>
      </div>
    </section>

    <div class="form-actions">
      <button class="btn" type="submit">${icon('save')}${t('Salvar alterações')}</button>
    </div>
  </form>
`;
const numberValue = (data, key, fallback) => {
    const value = Number(data.get(key));
    return Number.isFinite(value) ? value : fallback;
};
export const sessionConfigPayload = (data) => {
    const payload = {
        label: `${data.get('label') || ''}`.trim(),
        connectionType: `${data.get('connectionType') || 'qrcode'}`,
        server: `${data.get('server') || 'server_1'}`.trim(),
        proxyUrl: `${data.get('proxyUrl') || ''}`.trim(),
        authToken: `${data.get('authToken') || ''}`,
        historyMaxAgeDays: Math.max(1, numberValue(data, 'historyMaxAgeDays', 30)),
        rejectCalls: `${data.get('rejectCalls') || ''}`,
        rejectCallsWebhook: `${data.get('rejectCallsWebhook') || ''}`,
        openaiApiKey: `${data.get('openaiApiKey') || ''}`,
        openaiApiTranscribeModel: `${data.get('openaiApiTranscribeModel') || 'whisper-1'}`,
        groqApiKey: `${data.get('groqApiKey') || ''}`,
        groqApiTranscribeModel: `${data.get('groqApiTranscribeModel') || 'whisper-large-v3'}`,
        groqApiBaseUrl: `${data.get('groqApiBaseUrl') || 'https://api.groq.com/openai/v1'}`,
        rateLimitGlobalPerMinute: Math.max(0, numberValue(data, 'rateLimitGlobalPerMinute', 0)),
        rateLimitPerToPerMinute: Math.max(0, numberValue(data, 'rateLimitPerToPerMinute', 0)),
        rateLimitBlockSeconds: Math.max(0, numberValue(data, 'rateLimitBlockSeconds', 60)),
    };
    booleanSessionFields.forEach(([name]) => {
        payload[name] = data.has(name);
    });
    return payload;
};
