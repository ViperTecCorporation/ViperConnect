import { setLocale } from '../../frontend/core/i18n'
import {
  filterQueuesBySession,
  filterQueuesByMetric,
  queueDescriptionKey,
  queueFlowLabelKey,
  queueTooltip,
  queueNeedsAttention,
  renderQueuePurgeModal,
  renderQueueInspectorPage,
  renderQueuesPage,
} from '../../frontend/pages/queues'

const queues = [
  { name: 'unoapi.incoming.server_1.zapo', messages: 0, messages_ready: 0, messages_unacknowledged: 0, consumers: 4, state: 'running' },
  { name: 'unoapi.incoming.server_1.baileys', messages: 2, messages_ready: 2, messages_unacknowledged: 0, consumers: 0, state: 'running' },
  { name: 'unoapi.outgoing.dead', messages: 3, messages_ready: 3, messages_unacknowledged: 0, consumers: 0, state: 'running' },
]

describe('RabbitMQ queues page', () => {
  afterEach(() => setLocale('pt-BR'))

  test('describes known queue domains', () => {
    expect(queueTooltip('unoapi.outgoing.dead')).toContain('esgotou')
    expect(queueDescriptionKey('unoapi.media')).toContain('mídias')
  })
  test('explains scheduled media cleanup without treating retention as a sending backlog', () => {
    const description = queueTooltip('unoapi.media.delayed')
    expect(description).toContain('DATA_TTL')
    expect(description).toContain('30 dias')
    expect(description).toContain('não é uma fila de envio')
    expect(description).toContain('Purgar descarta')
    expect(queueTooltip('unoapi.media.dead')).toContain('esgotou as tentativas')
    expect(queueTooltip('unoapi.incoming.server_1.zapo.delayed')).not.toContain('DATA_TTL')
    setLocale('en')
    expect(queueTooltip('unoapi.media.delayed')).toContain('scheduled media deletion')
    expect(queueTooltip('unoapi.media.delayed')).toContain('30 days')
  })

  test('distinguishes failed API sends from failed inbound WhatsApp events', () => {
    expect(queueFlowLabelKey('unoapi.incoming.server_1.zapo.dead')).toBe('API → WhatsApp')
    expect(queueFlowLabelKey('unoapi.listener.server_1.zapo.dead')).toBe('WhatsApp → Webhooks')
    expect(queueTooltip('unoapi.incoming.server_1.zapo.dead')).toContain('comandos de envio')
    expect(queueTooltip('unoapi.listener.server_1.zapo.dead')).toContain('eventos recebidos')
    expect(queueTooltip('unoapi.listener.server_1.zapo.dead')).toContain('esgotou as tentativas')
  })

  test('marks stopped queues or unattended backlogs in red', () => {
    expect(queueNeedsAttention(queues[0])).toBe(false)
    expect(queueNeedsAttention(queues[1])).toBe(true)
  })
  test.each(['unoapi.media.delayed', 'unoapi.incoming.server_1.zapo.delayed', 'unoapi.history.server_1.zapo.delayed'])('does not flag normal waiting backlog %s', name => {
    const queue = { ...queues[1], name, messages_ready: 16000 }
    expect(queueNeedsAttention(queue)).toBe(false)
    expect(queueNeedsAttention({ ...queue, state: 'down' })).toBe(true)
  })
  test('keeps active orphaned queues and dead letters actionable', () => {
    expect(queueNeedsAttention(queues[1])).toBe(true)
    expect(queueNeedsAttention({ ...queues[1], consumers: 1 })).toBe(false)
    expect(queueNeedsAttention({ ...queues[2], consumers: 1 })).toBe(true)
    expect(queueNeedsAttention({ ...queues[2], messages_ready: 0 })).toBe(false)
  })
  test.each([
    ['unoapi.history.server_1.zapo', 'sincronização'],
    ['unoapi.outgoing.history', 'webhooks do histórico'],
    ['unoapi.transcribe.history', 'áudios do histórico'],
    ['unoapi.session.events', 'heartbeat'],
    ['unoapi.video.stage', 'armazena temporariamente'],
    ['unoapi.video.transcode', 'converte vídeos'],
    ['unoapi.webhook.status.failed', 'webhook de falhas'],
    ['unoapi.incoming.server_1.zapo', 'gerenciamento de grupos'],
    ['unoapi.commander', 'configuração de webhooks'],
    ['unoapi.timer', 'envios de texto'],
    ['unoapi.blacklist.add', 'persistentes'],
  ])('describes %s in both languages, including retry/dead variants', (name, description) => {
    setLocale('pt-BR')
    const pt = queueDescriptionKey(name)
    expect(pt).toContain(description)
    expect(queueDescriptionKey(`${name}.delayed`)).toBe(pt)
    expect(queueDescriptionKey(`${name}.dead`)).toBe(pt)
    setLocale('en')
    expect(queueTooltip(name)).not.toContain(pt)
    expect(queueTooltip(`${name}.dead`)).toContain('exhausted')
  })

  test('filters queues from each summary card', () => {
    expect(filterQueuesByMetric(queues, 'ready').map((queue) => queue.name)).toEqual([
      'unoapi.incoming.server_1.baileys',
      'unoapi.outgoing.dead',
    ])
    expect(filterQueuesByMetric(queues, 'dead').map((queue) => queue.name)).toEqual([
      'unoapi.outgoing.dead',
    ])
    expect(filterQueuesByMetric(queues, 'consumers').map((queue) => queue.name)).toEqual([
      'unoapi.incoming.server_1.zapo',
    ])
  })

  test('filters engine-specific queues by the selected session', () => {
    expect(filterQueuesBySession(queues, { phone: '5566', server: 'server_1', provider: 'zapo' }).map((queue) => queue.name)).toEqual([
      'unoapi.incoming.server_1.zapo',
    ])
  })

  test('does not mix global, legacy or another provider queues into a session filter', () => {
    const mixed = [
      ...queues,
      { name: 'unoapi.listener.server_1.dead', messages: 1, messages_ready: 1, messages_unacknowledged: 0, consumers: 0 },
      { name: 'unoapi.listener.server_2.zapo', messages: 1, messages_ready: 1, messages_unacknowledged: 0, consumers: 0 },
    ]
    expect(filterQueuesBySession(mixed, { phone: '5566', server: 'server_1', provider: 'baileys' }).map((queue) => queue.name)).toEqual([
      'unoapi.incoming.server_1.baileys',
    ])
  })

  test('renders session filter, queue tooltips and green/red state icons', () => {
    const html = renderQueuesPage({
      queues,
      sessions: [{ phone: '5566', label: 'Comercial', server: 'server_1', provider: 'zapo' }],
      sessionPhoneFilter: '',
      query: '',
      loading: false,
      refreshIn: 30,
      visibleLimit: 20,
      selectedQueue: '',
      messages: [],
      messagesLoading: false,
      messageLimit: 20,
      messageOrder: 'oldest',
      metricFilter: 'all',
      error: '',
    })
    expect(html).toContain('Acompanhamento e inspeção das filas do ViperConnect')
    expect(html).toContain('data-filter="queues-session"')
    expect(html).toContain('data-action="toggle-tooltip"')
    expect(html).toContain('queue-state--healthy')
    expect(html).toContain('queue-state--danger')
    expect(html).toContain('data-action="open-queue-purge"')
    expect(html).not.toContain('data-action="back-to-queues"')
    expect(html.match(/data-action="filter-queues-metric"/g)).toHaveLength(3)
  })

  test('opens inspection as a dedicated page with a back button', () => {
    const html = renderQueueInspectorPage({
      queues,
      sessions: [],
      sessionPhoneFilter: '',
      query: '',
      loading: false,
      refreshIn: 30,
      visibleLimit: 20,
      selectedQueue: 'unoapi.outgoing.dead',
      messages: [{ exchange: '', routing_key: '5566', redelivered: true, message_count: 2, properties: {}, payload: { id: 1 } }],
      messagesLoading: false,
      messageLimit: 20,
      messageOrder: 'oldest',
      metricFilter: 'all',
      error: '',
    })
    expect(html).toContain('data-action="back-to-queues"')
    expect(html).toContain('Voltar para filas')
    expect(html).toContain('data-action="load-more-queue-messages"')
    expect(html).not.toContain('Filas do RabbitMQ')
    expect(html).not.toContain('data-action="inspect-queue"')
  })

  test('explains that reverse order applies only to the loaded sample', () => {
    const html = renderQueuesPage({
      queues,
      sessions: [],
      sessionPhoneFilter: '',
      query: '',
      loading: false,
      refreshIn: 30,
      visibleLimit: 20,
      selectedQueue: 'unoapi.outgoing.dead',
      messages: [{ exchange: '', routing_key: '5566', redelivered: true, message_count: 2, properties: {}, payload: { id: 1 } }],
      messagesLoading: false,
      messageLimit: 20,
      messageOrder: 'sample_newest',
      metricFilter: 'all',
      error: '',
    })
    expect(html).toContain('não possui timestamp')
    expect(html).toContain('Mais novas da amostra')
  })

  test('renders purge confirmation for one, many or all ready messages', () => {
    const html = renderQueuePurgeModal('unoapi.outgoing.dead')
    expect(html).toContain('value="1"')
    expect(html).toContain('value="50"')
    expect(html).toContain('value="all"')
    expect(html).toContain('Digite o nome da fila para confirmar')
  })

  test('renders the panel in English', () => {
    setLocale('en')
    expect(renderQueuePurgeModal('unoapi.outgoing')).toContain('Clear queue messages')
  })
})
