import { escapeHtml as e } from '../core/html.js'

const endpointError = 'Cole a URL completa do webhook gerada pelo ViperChat, com a conta e o serviço. Use HTTPS, sem credenciais, parâmetros ou fragmento.'

export const parseVoipWebhookUrl = (value: string) => {
  try {
    const url = new URL(value.trim())
    const match = url.pathname.match(/^(.*)\/api\/v1\/accounts\/([1-9][0-9]*)\/voip\/services\/([1-9][0-9]*)\/events$/)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (!match || url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error(endpointError)
    return { baseUrl: `${url.origin}${match[1]}`, accountId: match[2], serviceId: match[3] }
  } catch {
    throw new Error(endpointError)
  }
}

const endpointFromConfig = (config: Record<string, any>) =>
  config.baseUrl && config.accountId && config.serviceId
    ? `${`${config.baseUrl}`.replace(/\/+$/, '')}/api/v1/accounts/${config.accountId}/voip/services/${config.serviceId}/events`
    : ''

/** Toggle controls without rerendering the modal or losing write-only credentials. */
export const syncVoipWebhookFields = (form: HTMLFormElement) => {
  const field = (key: string) => form.elements.namedItem(`viperchatWebhook.${key}`) as HTMLInputElement | HTMLSelectElement | null
  const webhook = field('artifactsDelivery')?.value === 'webhook'
  for (const mode of ['webhook', 'legacy']) {
    const group = form.querySelector<HTMLElement>(`[data-voip-webhook-mode="${mode}"]`)
    if (!group) continue
    const active = webhook === (mode === 'webhook')
    group.hidden = !active
    for (const input of Array.from(group.querySelectorAll<HTMLInputElement>('input'))) input.disabled = !active
  }
  const endpoint = field('endpointUrl') as HTMLInputElement | null
  if (!endpoint) return
  if (webhook && !endpoint.value) endpoint.value = endpointFromConfig(Object.fromEntries(
    ['baseUrl', 'accountId', 'serviceId'].map(key => [key, field(key)?.value || '']),
  ))
  endpoint.setCustomValidity('')
  if (webhook && endpoint.value) {
    try { parseVoipWebhookUrl(endpoint.value) } catch { endpoint.setCustomValidity(endpointError) }
  }
}

/** Write-only administrator credential. Never restore a secret into the DOM. */
export const renderVoipWebhookFields = (config: Record<string, any> = {}) => {
  const input = (key: string, label: string, extra = '') => `<label class="field"><span>${label}</span><input name="viperchatWebhook.${key}" value="${e(`${config[key] ?? ''}`)}" ${extra}></label>`
  const webhook = config.artifactsDelivery === 'webhook'
  return `<h3 class="wide">Eventos de chamadas no ViperChat</h3>
    <p class="hint wide">Integração desta empresa: somente chamadas com ramais vinculados a ela enviam eventos. Todos os seus ramais herdam esta configuração, sem repetir tokens por linha. Configure o serviço VoIP no ViperChat e copie a origem estável. A fila persistente usa retentativas; não envia áudio nem inicia chamadas.</p>
    <label class="voip-check wide"><input type="checkbox" name="viperchatWebhook.enabled" ${config.enabled === true ? 'checked' : ''}><span>Enviar eventos ao ViperChat</span></label>
    <label class="voip-check wide"><input type="checkbox" name="viperchatWebhook.nativeWakeEnabled" ${config.nativeWakeEnabled === true ? 'checked' : ''}><span>Permitir despertar do app para chamadas recebidas</span></label>
    <label class="field"><span>Validade da oferta nativa (segundos)</span><input type="number" name="viperchatWebhook.nativeWakeTimeoutSeconds" value="${e(`${config.nativeWakeTimeoutSeconds ?? 30}`)}" min="5" max="60" step="1" required><small class="muted">De 5 a 60 segundos; padrão 30. Novos registros do ramal não renovam esse prazo.</small></label>
    <p class="hint wide">Desativado por padrão. Exige eventos da empresa habilitados, receptor ViperChat compatível e dispositivos nativos autorizados. Apenas conserva uma oferta real para o ramal vinculado registrar e receber o INVITE; não ativa push, não atende a chamada e não altera o transporte de gravações.</p>
    <label class="field wide"><span>Envio de gravação e IA</span><select name="viperchatWebhook.artifactsDelivery"><option value="legacy" ${config.artifactsDelivery !== 'webhook' ? 'selected' : ''}>Integração legada por caixa de entrada</option><option value="webhook" ${config.artifactsDelivery === 'webhook' ? 'selected' : ''}>Webhook da empresa</option></select><small class="muted">Escolha somente um transporte. Webhook exige o envio da empresa habilitado e configuração válida; desativa o envio legado efetivo das linhas, preservando caixas, tokens e configurações salvas. Não envia pelos dois caminhos.</small></label>
    <div class="wide" data-voip-webhook-mode="webhook" ${webhook ? '' : 'hidden'}>
      <label class="field"><span>URL completa do webhook da empresa</span><input type="url" name="viperchatWebhook.endpointUrl" value="${e(endpointFromConfig(config))}" placeholder="https://chat.exemplo.com/api/v1/accounts/1/voip/services/123/events" required ${webhook ? '' : 'disabled'}><small class="muted">Cole a URL gerada no cadastro do serviço VoIP no ViperChat. A conta e o serviço são extraídos automaticamente; não preencha IDs manualmente.</small></label>
    </div>
    <div class="wide" data-voip-webhook-mode="legacy" ${webhook ? 'hidden' : ''}>
      ${input('baseUrl', 'URL base do ViperChat', `type="url" placeholder="https://chat.exemplo.com" ${webhook ? 'disabled' : ''}`)}
      ${input('accountId', 'ID da conta no ViperChat', `inputmode="numeric" pattern="[1-9][0-9]*" ${webhook ? 'disabled' : ''}`)}
      ${input('serviceId', 'ID do serviço VoIP no ViperChat', `inputmode="numeric" pattern="[1-9][0-9]*" ${webhook ? 'disabled' : ''}`)}
    </div>
    ${input('sourceInstanceId', 'Identificador estável da origem', 'maxlength="200"')}
    <label class="field"><span>api_access_token de administrador do ViperChat</span><input type="password" name="viperchatWebhook.apiAccessToken" value="" autocomplete="new-password"><small class="muted">${config.hasApiAccessToken ? 'Token configurado. ' : ''}Deixe vazio para manter; não use o token interno do serviço VoIP.</small></label>
    <label class="voip-check wide"><input type="checkbox" name="viperchatWebhook.clearApiAccessToken"><span>Remover o token salvo (desative o envio antes)</span></label>
    <p class="muted wide">Destino: URL base + /api/v1/accounts/{conta}/voip/services/{serviço}/events. HTTPS obrigatório; HTTP somente em loopback dev. Não altere a origem estável para reprocessar eventos.</p>`
}

export const voipWebhookPayload = (data: FormData): Record<string, unknown> => {
  const value = (key: string) => `${data.get(`viperchatWebhook.${key}`) || ''}`.trim()
  const nativeWakeTimeoutSeconds = Number(value('nativeWakeTimeoutSeconds') || '30')
  if (!Number.isInteger(nativeWakeTimeoutSeconds) || nativeWakeTimeoutSeconds < 5 || nativeWakeTimeoutSeconds > 60) {
    throw new Error('A validade da oferta nativa deve ser um inteiro entre 5 e 60 segundos.')
  }
  const webhook = value('artifactsDelivery') === 'webhook'
  const destination = webhook ? parseVoipWebhookUrl(value('endpointUrl'))
    : Object.fromEntries(['baseUrl', 'accountId', 'serviceId'].map(key => [key, value(key)]))
  return {
    enabled: data.has('viperchatWebhook.enabled'),
    nativeWakeEnabled: data.has('viperchatWebhook.nativeWakeEnabled'),
    nativeWakeTimeoutSeconds,
    artifactsDelivery: value('artifactsDelivery') === 'webhook' ? 'webhook' : 'legacy',
    ...destination,
    sourceInstanceId: value('sourceInstanceId'),
    ...(value('apiAccessToken') ? { apiAccessToken: value('apiAccessToken') } : {}),
    ...(data.has('viperchatWebhook.clearApiAccessToken') ? { clearApiAccessToken: true } : {}),
  }
}
