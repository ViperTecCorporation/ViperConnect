import type { SessionConfig } from '../domain/types.js'
import { escapeHtml } from '../core/html.js'

/** F6 entry point. Never implies an empty remote list without consulting the worker. */
export function renderMobileCompanions(session: SessionConfig, restricted: boolean): string {
  if (!session.mobilePrimaryDraftId) return ''
  return `<section class="section"><div class="section__heading"><div><h2>Dispositivos conectados</h2><p class="muted">Aparelhos e WhatsApp Web vinculados a este dispositivo principal.</p></div></div>
    <p>Estado do principal: ${escapeHtml(session.status || 'offline')}.</p>
    ${restricted ? '<p>O gerenciamento de vínculos está reservado ao administrador neste piloto.</p>' : `<p role="status">Integração F6 em desenvolvimento. A lista de vínculos ainda não foi consultada; isso não significa que não existam aparelhos vinculados.</p>
    <div class="action-grid"><button class="action-card" type="button" disabled><span><strong>Ler QR Code de uma imagem</strong><small>Print ou imagem do aparelho que deseja vincular</small></span></button>
    <button class="action-card" type="button" disabled><span><strong>Ler QR Code pela câmera</strong><small>Exigirá HTTPS e permissão da câmera</small></span></button>
    <button class="action-card" type="button" disabled><span><strong>Vincular por código</strong><small>Código solicitado no dispositivo secundário; não é o SMS de registro</small></span></button></div>
    <p>Listagem, vínculo e revogação serão liberados após conectar os comandos ao worker e garantir a persistência dos índices de segurança. Nenhuma câmera é ativada e nenhum vínculo é criado nesta etapa.</p>`}</section>`
}
