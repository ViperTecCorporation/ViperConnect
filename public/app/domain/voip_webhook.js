import { escapeHtml as e } from '../core/html.js?v=4.0.38-ef5d1c11';
export const renderVoipWebhookFields = (config = {}) => {
    const input = (key, label, extra = '') => `<label class="field"><span>${label}</span><input name="viperchatWebhook.${key}" value="${e(`${config[key] ?? ''}`)}" ${extra}></label>`;
    return `<h3 class="wide">Eventos de chamadas no ViperChat</h3>
    <p class="hint wide">Integração desta empresa: somente chamadas com ramais vinculados a ela enviam eventos. Todos os seus ramais herdam esta configuração, sem repetir tokens por linha. Configure o serviço VoIP no ViperChat e copie a origem estável. A fila persistente usa retentativas; não envia áudio nem inicia chamadas.</p>
    <label class="voip-check wide"><input type="checkbox" name="viperchatWebhook.enabled" ${config.enabled === true ? 'checked' : ''}><span>Enviar eventos ao ViperChat</span></label>
    <label class="field wide"><span>Envio de gravação e IA</span><select name="viperchatWebhook.artifactsDelivery"><option value="legacy" ${config.artifactsDelivery !== 'webhook' ? 'selected' : ''}>Integração legada por caixa de entrada</option><option value="webhook" ${config.artifactsDelivery === 'webhook' ? 'selected' : ''}>Webhook da empresa</option></select><small class="muted">Escolha somente um transporte. Webhook exige o envio da empresa habilitado e configuração válida; desativa o envio legado efetivo das linhas, preservando caixas, tokens e configurações salvas. Não envia pelos dois caminhos.</small></label>
    ${input('baseUrl', 'URL base do ViperChat', 'type="url" placeholder="https://chat.exemplo.com"')}
    ${input('accountId', 'ID da conta no ViperChat', 'inputmode="numeric" pattern="[1-9][0-9]*"')}
    ${input('serviceId', 'ID do serviço VoIP no ViperChat', 'inputmode="numeric" pattern="[1-9][0-9]*"')}
    ${input('sourceInstanceId', 'Identificador estável da origem', 'maxlength="200"')}
    <label class="field"><span>api_access_token de administrador do ViperChat</span><input type="password" name="viperchatWebhook.apiAccessToken" value="" autocomplete="new-password"><small class="muted">${config.hasApiAccessToken ? 'Token configurado. ' : ''}Deixe vazio para manter; não use o token interno do serviço VoIP.</small></label>
    <label class="voip-check wide"><input type="checkbox" name="viperchatWebhook.clearApiAccessToken"><span>Remover o token salvo (desative o envio antes)</span></label>
    <p class="muted wide">Destino: URL base + /api/v1/accounts/{conta}/voip/services/{serviço}/events. HTTPS obrigatório; HTTP somente em loopback dev. Não altere a origem estável para reprocessar eventos.</p>`;
};
export const voipWebhookPayload = (data) => {
    const value = (key) => `${data.get(`viperchatWebhook.${key}`) || ''}`.trim();
    return {
        enabled: data.has('viperchatWebhook.enabled'),
        artifactsDelivery: value('artifactsDelivery') === 'webhook' ? 'webhook' : 'legacy',
        ...Object.fromEntries(['baseUrl', 'accountId', 'serviceId', 'sourceInstanceId'].map(key => [key, value(key)])),
        ...(value('apiAccessToken') ? { apiAccessToken: value('apiAccessToken') } : {}),
        ...(data.has('viperchatWebhook.clearApiAccessToken') ? { clearApiAccessToken: true } : {}),
    };
};
