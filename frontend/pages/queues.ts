import { renderInfoTooltip } from '../components/form_controls.js'
import { icon } from '../components/icons.js'
import { renderModal } from '../components/modal.js'
import { escapeHtml } from '../core/html.js'
import { formatNumber, t, type TranslationKey } from '../core/i18n.js'
import { sessionLabel, sessionPhone } from '../domain/session.js'
import type { RabbitQueueInfo, RabbitQueueMessage, SessionConfig } from '../domain/types.js'
import { parseRabbitQueueName, rabbitQueueScopeLabels } from '../domain/rabbit_queue.js'

export const queueDescriptionKey = (name: string): TranslationKey => {
  const queue = parseRabbitQueueName(name)
  const variants: Record<string, TranslationKey> = {
    'outgoing.history': 'Entrega às aplicações os webhooks do histórico, separados dos eventos em tempo real.',
    'transcribe.history': 'Transcreve áudios do histórico em uma fila separada das mensagens em tempo real.',
    'session.events': 'Entrega webhooks de conexão, desconexão, desvinculação, remoção, indisponibilidade e heartbeat das sessões.',
    'video.stage': 'Obtém e armazena temporariamente o vídeo para preparação, sem bloquear a fila da sessão.',
    'video.transcode': 'Prepara e converte vídeos quando necessário antes de encaminhar o envio à sessão.',
    'webhook.status': 'Encaminha avisos de status de mensagem com falha ao webhook de falhas configurado.',
  }
  const variantDescription = variants[`${queue.family}.${queue.variant}`]
  if (variantDescription) return variantDescription
  const descriptions: Record<string, TranslationKey> = {
    outgoing: 'Entrega eventos e webhooks do ViperConnect às aplicações cadastradas.',
    incoming: 'Recebe comandos de envio, atualização de status, gerenciamento de grupos e operações do provider nas sessões do WhatsApp.',
    history: 'Processa eventos de sincronização do histórico em fila separada dos eventos em tempo real.',
    listener: 'Transporta eventos recebidos do WhatsApp para o processamento da UnoAPI.',
    media: 'Executa a exclusão programada de mídias no armazenamento S3; não é uma fila de envio ao WhatsApp.',
    transcribe: 'Processa transcrição de mensagens de áudio.',
    bind: 'Vincula sessões às filas do servidor e motor responsáveis.',
    reload: 'Transporta solicitações de conexão e recarga das sessões.',
    logout: 'Transporta solicitações de desconexão e logout das sessões.',
    bulk: 'Processa etapas de envios em lote e seus relatórios.',
    timer: 'Executa envios de texto agendados, verificando se o temporizador ainda é válido.',
    broadcast: 'Distribui eventos internos entre processos do ViperConnect.',
    notification: 'Processa notificações auxiliares e avisos de falha.',
    blacklist: 'Atualiza a blacklist dos webhooks, com bloqueios temporários ou persistentes conforme o TTL.',
    commander: 'Processa comandos por templates para lotes, relatórios e configuração de webhooks.',
  }
  return descriptions[queue.family] || 'Fila interna do ViperConnect gerenciada pelo RabbitMQ.'
}

export const queueFlowLabelKey = (name: string): TranslationKey | '' => {
  const labels: Record<string, TranslationKey> = {
    incoming: 'API → WhatsApp',
    listener: 'WhatsApp → Webhooks',
    outgoing: 'ViperConnect → Aplicações',
    bind: 'Sessão → Worker',
    reload: 'API → Reconexão',
    logout: 'API → Desconexão',
  }
  return labels[parseRabbitQueueName(name).family] || ''
}

export const queueTooltip = (name: string): string => {
  const queue = parseRabbitQueueName(name)
  const details = [t(queueDescriptionKey(name))]
  if (queue.lifecycle === 'dead') details.push(t('Esta variação esgotou as tentativas e aguarda análise ou remoção.'))
  if (queue.lifecycle === 'delayed') {
    details.push(t(queue.family === 'media'
      ? 'Aguarda DATA_TTL para encaminhar a tarefa de exclusão à fila media. O padrão do código é 30 dias; o ambiente pode usar outro prazo. Muitos itens e zero consumidores nesta fila de espera não comprovam falha de envio. Também pode conter retentativas de limpeza. Purgar descarta os agendamentos e pode deixar arquivos sem limpeza.'
      : 'Esta variação aguarda o tempo configurado para nova tentativa ou execução.'))
  }
  if (queue.legacy) details.push(t('Fila legada sem motor explícito; não recebe novas sessões no padrão atual.'))
  if (queue.invalidServer) details.push(t('Fila com servidor indefinido; indica publicação antiga ou configuração incompleta.'))
  return details.join(' ')
}

export const queueNeedsAttention = (queue: RabbitQueueInfo): boolean => {
  if (`${queue.state || 'running'}` !== 'running') return true
  const lifecycle = parseRabbitQueueName(queue.name).lifecycle
  if (lifecycle === 'delayed') return false // Waiting queues expire into the active queue without consumers.
  if (lifecycle === 'dead') return queue.messages_ready > 0 || queue.messages_unacknowledged > 0
  return queue.messages_ready > 0 && queue.consumers === 0
}

export const filterQueuesBySession = (
  queues: RabbitQueueInfo[],
  session?: SessionConfig,
): RabbitQueueInfo[] => {
  if (!session) return queues
  const server = `${session.server || 'server_1'}`
  const provider = `${session.provider || 'zapo'}`
  return queues.filter((queue) => {
    const identity = parseRabbitQueueName(queue.name)
    return identity.server === server && identity.provider === provider
  })
}

export type QueueMetricFilter = 'all' | 'ready' | 'dead' | 'consumers'

export const filterQueuesByMetric = (
  queues: RabbitQueueInfo[],
  filter: QueueMetricFilter,
): RabbitQueueInfo[] => {
  if (filter === 'ready') return queues.filter((queue) => queue.messages_ready > 0)
  if (filter === 'dead') return queues.filter((queue) => queue.name.endsWith('.dead'))
  if (filter === 'consumers') return queues.filter((queue) => queue.consumers > 0)
  return queues
}

const renderMessages = (
  messages: RabbitQueueMessage[],
  order: 'oldest' | 'sample_newest',
): string => {
  if (!messages.length) return `<div class="empty-state">${t('Nenhuma mensagem encontrada na amostra.')}</div>`
  const ordered = order === 'sample_newest' ? [...messages].reverse() : messages
  return `<div class="queue-messages">${ordered.map((message, index) => `
    <article class="queue-message">
      <div class="queue-message__header">
        <strong>${t('Mensagem {index}', { index: index + 1 })}</strong>
        <span class="muted">${escapeHtml(message.routing_key || message.exchange || '-')} · ${message.redelivered ? t('Reentregue') : t('Nova')}</span>
      </div>
      <pre>${escapeHtml(JSON.stringify(message.payload, null, 2))}</pre>
    </article>`).join('')}</div>`
}

export const renderQueuePurgeModal = (queue: string): string =>
  renderModal('queue-purge', t('Limpar mensagens da fila'), `
    <form class="stack" data-form="queue-purge">
      <input type="hidden" name="queue" value="${escapeHtml(queue)}">
      <p>${t('A limpeza remove mensagens prontas e não afeta itens já entregues a consumidores.')}</p>
      <label class="field"><span>${t('Quantidade')}</span><select name="count"><option value="1">${t('Uma mensagem')}</option><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="all">${t('Todas as mensagens prontas')}</option></select></label>
      <label class="field"><span>${t('Digite o nome da fila para confirmar')}</span><input name="confirm" autocomplete="off" placeholder="${escapeHtml(queue)}" required></label>
      <div class="form-actions"><button class="btn btn--danger" type="submit">${icon('trash')}${t('Limpar definitivamente')}</button></div>
    </form>
  `, { subtitle: queue })

interface QueuePageOptions {
  queues: RabbitQueueInfo[]
  sessions: SessionConfig[]
  sessionPhoneFilter: string
  query: string
  loading: boolean
  refreshIn: number
  visibleLimit: number
  selectedQueue: string
  messages: RabbitQueueMessage[]
  messagesLoading: boolean
  messageLimit: number
  messageOrder: 'oldest' | 'sample_newest'
  metricFilter: QueueMetricFilter
  error: string
}

export const renderQueueInspectorPage = (options: QueuePageOptions): string => {
  const selectedQueue = options.queues.find((queue) => queue.name === options.selectedQueue)
  const canLoadMoreMessages = !!selectedQueue
    && options.messageLimit < 200
    && selectedQueue.messages_ready > options.messages.length

  return `
    <section class="page-header">
      <div>
        <button class="btn btn--ghost page-back" type="button" data-action="back-to-queues">${icon('arrowLeft')}${t('Voltar para filas')}</button>
        <span class="eyebrow">RabbitMQ · ${t('Inspeção')}</span>
        <h1>${escapeHtml(options.selectedQueue)}</h1>
        <p class="muted">${t('A amostra é lida e recolocada na fila; nenhuma mensagem é removida.')}</p>
      </div>
      <button class="btn btn--danger btn--ghost" type="button" data-action="open-queue-purge" data-queue="${escapeHtml(options.selectedQueue)}">${icon('trash')}${t('Limpar mensagens')}</button>
    </section>
    <section class="stats">
      <article class="stat-card"><span>${t('Mensagens prontas')}</span><strong>${formatNumber(selectedQueue?.messages_ready || 0)}</strong><small>${t('aguardando processamento')}</small></article>
      <article class="stat-card"><span>${t('Em processamento')}</span><strong>${formatNumber(selectedQueue?.messages_unacknowledged || 0)}</strong><small>unacked</small></article>
      <article class="stat-card"><span>${t('Consumidores')}</span><strong>${formatNumber(selectedQueue?.consumers || 0)}</strong><small>${t('processos ativos')}</small></article>
    </section>
    <section class="section queue-inspector">
      ${options.error ? `<p class="form-error">${escapeHtml(options.error)}</p>` : ''}
      <div class="queue-inspector-controls">
        <span class="muted">${t('{loaded} carregadas de {ready} prontas', { loaded: options.messages.length, ready: selectedQueue?.messages_ready || 0 })}</span>
        <label class="field"><span>${t('Ordem')}</span><select data-filter="queue-message-order">
          <option value="oldest" ${options.messageOrder === 'oldest' ? 'selected' : ''}>${t('Ordem da fila')}</option>
          <option value="sample_newest" ${options.messageOrder === 'sample_newest' ? 'selected' : ''}>${t('Mais novas da amostra')}</option>
        </select></label>
      </div>
      ${options.messageOrder === 'sample_newest' ? `<p class="hint">${t('A fila não possui timestamp. Esta opção apenas inverte as mensagens já carregadas e não representa necessariamente as mais recentes da fila inteira.')}</p>` : ''}
      ${options.messagesLoading ? `<div class="loading-state">${t('Carregando mensagens…')}</div>` : renderMessages(options.messages, options.messageOrder)}
      ${canLoadMoreMessages ? `<div class="load-more"><button class="btn btn--ghost" type="button" data-action="load-more-queue-messages">${t('Carregar mais')} <span>${Math.min(200, options.messageLimit + 20)}</span></button></div>` : ''}
    </section>
  `
}

export const renderQueuesPage = (options: QueuePageOptions): string => {
  if (options.selectedQueue) return renderQueueInspectorPage(options)

  const session = options.sessions.find((item) => sessionPhone(item) === options.sessionPhoneFilter)
  const scoped = filterQueuesBySession(options.queues, session)
    .filter((queue) => queue.name.toLowerCase().includes(options.query.trim().toLowerCase()))
  const filtered = filterQueuesByMetric(scoped, options.metricFilter)
  const visible = filtered.slice(0, options.visibleLimit)
  const ready = scoped.reduce((total, queue) => total + queue.messages_ready, 0)
  const dead = scoped.filter((queue) => queue.name.endsWith('.dead')).reduce((total, queue) => total + queue.messages_ready, 0)
  const consumers = scoped.reduce((total, queue) => total + queue.consumers, 0)
  return `
    <section class="page-header">
      <div><span class="eyebrow">RabbitMQ</span><h1>${t('Filas')}</h1><p class="muted">${t('Acompanhamento e inspeção das filas do ViperConnect')}</p></div>
      <button class="btn btn--ghost" type="button" data-action="refresh-queues">${icon('refresh')}${t('Atualizar agora')}</button>
    </section>
    <section class="stats">
      <button class="stat-card stat-card--button ${options.metricFilter === 'ready' ? 'stat-card--active' : ''}" type="button" data-action="filter-queues-metric" data-metric="ready"><span>${t('Mensagens prontas')}</span><strong>${formatNumber(ready)}</strong><small>${t('Clique para filtrar filas com backlog')}</small></button>
      <button class="stat-card stat-card--button ${options.metricFilter === 'dead' ? 'stat-card--active' : ''}" type="button" data-action="filter-queues-metric" data-metric="dead"><span>Dead-letter</span><strong>${formatNumber(dead)}</strong><small>${t('Clique para filtrar filas de falha')}</small></button>
      <button class="stat-card stat-card--button ${options.metricFilter === 'consumers' ? 'stat-card--active' : ''}" type="button" data-action="filter-queues-metric" data-metric="consumers"><span>${t('Consumidores')}</span><strong>${formatNumber(consumers)}</strong><small>${t('Clique para filtrar filas em consumo')}</small></button>
    </section>
    <section class="section">
      <div class="section__heading">
        <div><h2>${t('Filas do RabbitMQ')}</h2><p class="muted">${options.loading ? t('Atualizando…') : `${t('Atualização automática em')} <span data-refresh-countdown>${options.refreshIn}s</span>`}</p></div>
      </div>
      <div class="filters queue-filters">
        <label class="search-field">${icon('search')}<input data-filter="queues-query" value="${escapeHtml(options.query)}" placeholder="${t('Buscar fila')}" aria-label="${t('Buscar fila')}"></label>
        <label class="field"><span>${t('Filtrar por sessão')}</span><select data-filter="queues-session">
          <option value="">${t('Todas as sessões')}</option>
          ${options.sessions.map((item) => `<option value="${escapeHtml(sessionPhone(item))}" ${sessionPhone(item) === options.sessionPhoneFilter ? 'selected' : ''}>${escapeHtml(sessionLabel(item))} · ${escapeHtml(sessionPhone(item))}</option>`).join('')}
        </select></label>
      </div>
      ${session ? `<p class="hint">${t('Mostrando somente filas do motor e servidor da sessão. Os totais da fila são compartilhados; a inspeção filtra a amostra pelo telefone selecionado.')}</p>` : ''}
      ${options.error ? `<p class="form-error">${escapeHtml(options.error)}</p>` : ''}
      <div class="table-wrap">
        <table class="queue-table">
          <thead><tr><th>${t('Fila')}</th><th>${t('Prontas')}</th><th>${t('Em processamento')}</th><th>${t('Consumidores')}</th><th>${t('Estado')}</th><th class="table-actions">${t('Ações')}</th></tr></thead>
          <tbody>${visible.length ? visible.map((queue) => {
            const attention = queueNeedsAttention(queue)
            const flowLabel = queueFlowLabelKey(queue.name)
            return `<tr class="${queue.name === options.selectedQueue ? 'row--selected' : ''}">
              <td><div class="queue-name"><strong>${escapeHtml(queue.name)}</strong>${renderInfoTooltip(queueTooltip(queue.name))}</div><div class="queue-scope">${flowLabel ? `<span>${t(flowLabel)}</span>` : ''}${rabbitQueueScopeLabels(queue.name).map((label) => `<span>${t(label as TranslationKey)}</span>`).join('')}</div></td>
              <td>${formatNumber(queue.messages_ready)}</td>
              <td>${formatNumber(queue.messages_unacknowledged)}</td>
              <td>${formatNumber(queue.consumers)}</td>
              <td><span class="queue-state queue-state--${attention ? 'danger' : 'healthy'}"><span></span>${attention ? t('Atenção') : t('Normal')}</span></td>
              <td class="table-actions"><div class="row-actions">
                <button class="btn btn--ghost" type="button" data-action="inspect-queue" data-queue="${escapeHtml(queue.name)}">${icon('search')}${t('Inspecionar')}</button>
                <button class="btn btn--icon btn--ghost" type="button" data-action="open-queue-purge" data-queue="${escapeHtml(queue.name)}" aria-label="${t('Limpar fila')}">${icon('trash')}</button>
              </div></td>
            </tr>`
          }).join('') : `<tr><td colspan="6"><div class="empty-state">${t('Nenhuma fila encontrada.')}</div></td></tr>`}</tbody>
        </table>
      </div>
      ${filtered.length > visible.length ? `<div class="load-more"><button class="btn btn--ghost" type="button" data-action="load-more-queues">${t('Carregar mais')} <span>${visible.length}/${filtered.length}</span></button></div>` : ''}
    </section>
  `
}
