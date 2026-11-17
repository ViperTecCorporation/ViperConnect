import { escapeHtml as e } from '../core/html.js?v=4.0.44-f63f46d2';
import { renderModal } from '../components/modal.js?v=4.0.44-f63f46d2';
import { t } from '../core/i18n.js?v=4.0.44-f63f46d2';
import { resourceBytes as bytes, resourcePercent as percent, resourceTime as time, renderResourceChart } from './resource_charts.js?v=4.0.44-f63f46d2';
import { ResourceControlPanel } from './resource_control.js?v=4.0.44-f63f46d2';
import { ResourceLogsPanel } from './resource_logs.js?v=4.0.44-f63f46d2';
const periods = [['1d', '1 dia'], ['7d', '7 dias'], ['30d', '30 dias'], ['90d', '90 dias'], ['max', 'Máx.']];
export class ResourceMetricsPanel {
    constructor(api, render) {
        this.api = api;
        this.render = render;
        this.selected = '';
        this.range = '1d';
        this.open = false;
        this.busy = false;
        this.error = '';
        this.historyError = '';
        this.revision = 0;
        this.historyRevision = 0;
        this.next = 0;
        this.loading = false;
        this.control = new ResourceControlPanel(api, render);
        this.logs = new ResourceLogsPanel(api, render);
    }
    reset() { this.revision++; this.historyRevision++; this.current = undefined; this.history = undefined; this.open = false; this.selected = ''; this.loading = false; this.next = 0; this.error = ''; this.historyError = ''; this.control.reset(); this.logs.reset(); }
    async refresh() {
        void this.control.poll();
        if (this.loading || Date.now() < this.next)
            return;
        const revision = this.revision;
        this.loading = true;
        this.next = Date.now() + 15000;
        try {
            const value = await this.api.request('/admin/resources');
            if (revision === this.revision) {
                this.current = value;
                this.error = '';
            }
        }
        catch {
            if (revision === this.revision)
                this.error = t('Coleta indisponível. Os valores anteriores não são ao vivo.');
        }
        finally {
            if (revision === this.revision) {
                await this.control.refresh();
                this.loading = false;
                this.render();
            }
        }
    }
    async action(action, id = '') {
        if (action.startsWith('resources-logs-')) {
            if (action === 'resources-logs-open') {
                const row = this.current?.components.find(row => row.id === id && row.kind !== 'total');
                const target = this.control.overview?.targets.find(target => target.component === id && target.logs);
                if (!row || !target)
                    return;
                this.control.opened = false;
                this.logs.open(id, target.name);
            }
            else
                this.logs.action(action);
            return;
        }
        if (action.startsWith('resources-control-')) {
            if (action === 'resources-control-open' && !this.current?.components.some(row => row.id === id && row.kind !== 'total' && row.live && !this.error))
                return;
            if (action === 'resources-control-open')
                this.logs.reset();
            await this.control.action(action, id);
            return;
        }
        if (action === 'resources-close') {
            this.open = false;
            this.historyRevision++;
            this.busy = false;
            this.render();
            return;
        }
        if (action === 'resources-period' && this.busy)
            return;
        if (action === 'resources-open') {
            this.logs.reset();
            this.selected = id;
            this.range = '1d';
            this.open = true;
        }
        if (action === 'resources-period' && periods.some(([range]) => range === id))
            this.range = id;
        if (!this.open)
            return;
        const revision = ++this.historyRevision, auth = this.revision;
        this.busy = true;
        this.history = undefined;
        this.historyError = '';
        this.render();
        try {
            const value = await this.api.request(`/admin/resources/${encodeURIComponent(this.selected)}/history?range=${this.range}`);
            if (revision === this.historyRevision && auth === this.revision)
                this.history = value;
        }
        catch {
            if (revision === this.historyRevision && auth === this.revision)
                this.historyError = t('Histórico indisponível. Tente novamente sem perder a seleção.');
        }
        finally {
            if (revision === this.historyRevision && auth === this.revision) {
                this.busy = false;
                this.render();
            }
        }
    }
    html() {
        const value = this.current, total = value?.components.find(row => row.kind === 'total');
        const historical = [...value?.historicalComponents || []].sort((a, b) => b.t - a.t);
        const rows = [...value?.components || []].sort((a, b) => (a.kind === 'total' ? -1 : b.kind === 'total' ? 1 : a.name.localeCompare(b.name)));
        return `<section class="resource-overview" aria-label="${t('Consumo de recursos')}"><header class="section__heading"><div><h2>${t('Consumo de recursos')}</h2><p class="muted">${t('Serviços observados · coleta a cada minuto')}</p></div><span class="muted">${t('RAM e disco')} · CPU</span></header>
      ${this.error ? `<p class="storage-warning" role="alert">${e(this.error)}</p>` : ''}
      ${value?.redisUnavailable ? `<p class="storage-warning">${t('Redis indisponível. Exibindo a última medição recuperada do S3, quando disponível.')}</p>` : ''}
      ${value && !value.archiveEnabled ? `<p class="storage-warning">${t('Configure o S3 da stack para preservar o histórico. Sem S3, só as últimas 2 horas são mantidas.')}</p>` : ''}
      ${value?.archiveUnavailable ? `<p class="storage-warning">${t('S3 indisponível. Histórico recente limitado; nenhuma amostra ausente é convertida em zero.')}</p>` : ''}
      ${rows.some(row => row.archiveState === 'error') ? `<p class="storage-warning">${t('Arquivamento S3 pendente. Coleta recente preservada até o limite de 120 pontos por serviço.')}</p>` : ''}
      ${this.control.status()}
      <div class="resource-cards">${rows.map(row => {
            const live = row.live && !this.error, state = live ? t('Ao vivo') : t('Última medição');
            const alarm = row.kind === 'rabbitmq' && (row.rabbitMemoryAlarm || row.rabbitDiskAlarm || row.rabbitRunningNodes !== undefined && row.rabbitRunningNodes !== row.rabbitNodes);
            return `<button class="resource-card ${row.kind === 'total' ? 'resource-card--total' : ''} ${alarm ? 'resource-card--alarm' : ''}" type="button" data-action="resources-open" data-id="${e(row.id)}" title="${t('Ver detalhes')}"><span class="resource-card__heading"><span>${e(row.name)}</span><small class="${live ? 'resource-live' : 'resource-stale'}">${state}</small></span><strong>${bytes(row.ramBytes)}</strong><span class="resource-card__cpu">${t('CPU')} <b>${percent(row.cpuPercent)}</b>${row.cpuPartial ? ` · ${t('parcial')}` : ''}</span>${alarm ? `<small class="resource-alarm">${t('Alarme de recursos')}</small>` : ''}<small>${row.kind === 'total' ? t('Sem duplicar containers compartilhados') : e(row.kind)}${row.partial ? ` · ${t('parcial')}` : ''}</small><span class="resource-card__footer"><span>${row.kind === 'total' ? t('Ver histórico') : row.kind === 'rabbitmq' ? `${t('Disco livre')} ${bytes(row.diskFreeBytes)}` : `${t('Disco')} ${bytes(row.diskBytes)}${row.diskPartial ? ' ≈' : ''}`}</span><time>${e(time(row.t))}</time></span><small class="resource-card__hint">${t('Ver detalhes')} →</small></button>`;
        }).join('') || `<p class="muted">${t('Aguardando a primeira coleta dos serviços…')}</p>`}</div>
      ${historical.length ? `<details class="resource-previous"><summary>${t('Instâncias anteriores')} (${historical.length})</summary><p class="storage-caption">${t('Histórico de containers anteriores. Não entram no total atual.')}</p><div class="resource-previous__list">${historical.map(row => `<button type="button" class="btn btn--ghost" data-action="resources-open" data-id="${e(row.id)}"><span>${e(row.name)}</span><time>${e(time(row.t))}</time><span>${t('Ver histórico')}</span></button>`).join('')}</div></details>` : ''}
      <p class="storage-caption">${t('CPU: 100% = 1 núcleo. Pode ultrapassar 100% ao usar vários núcleos.')}</p>
      ${rows.some(row => row.kind === 'rabbitmq' && (row.cpuPercent === undefined || row.cpuPartial)) ? `<p class="storage-caption">${t('RabbitMQ: CPU requer Prometheus com duas coletas válidas; leitura incompleta deixa o total de CPU parcial.')}</p>` : ''}
      ${total ? `<p class="storage-caption">${t('Total dos serviços monitorados, não a RAM total do servidor. Redis: RSS; RabbitMQ: mem_used; containers: uso descontando cache inativo. Não inclui S3 ou outros aplicativos.')}</p>` : ''}</section>`;
    }
    dialog() {
        if (this.logs.opened)
            return this.logs.dialog();
        if (this.control.opened)
            return this.control.dialog();
        if (!this.open)
            return '';
        const row = [...this.current?.components || [], ...this.current?.historicalComponents || []].find(sample => sample.id === this.selected), history = this.history;
        const fact = (label, value) => `<div><dt>${t(label)}</dt><dd>${e(value)}</dd></div>`;
        const details = row ? `<dl class="resource-facts">${fact('Última medição', time(row.t))}${fact('Origem', row.live && !this.error ? t('Ao vivo') : row.source === 's3' ? 'S3 · ' + t('Última medição') : t('Última medição'))}
      ${fact('RAM', bytes(row.ramBytes))}${fact('CPU', percent(row.cpuPercent))}${row.cpuPartial ? fact('CPU parcial', t('parcial')) : ''}${!['total', 'rabbitmq'].includes(row.kind) ? fact('RSS do processo', bytes(row.rssBytes)) : ''}
      ${row.cpuSource ? fact('Origem da CPU', row.cpuSource === 'container' ? 'cgroup v2' : row.cpuSource === 'process' ? 'Node.js' : row.cpuSource === 'redis-process' ? 'Redis · INFO cpu' : row.cpuSource === 'rabbitmq-runtime' ? 'RabbitMQ · Prometheus/Erlang' : 'Σ') : ''}
      ${row.heapUsedBytes !== undefined ? fact('Heap JavaScript', bytes(row.heapUsedBytes)) : ''}${row.containerBytes !== undefined ? fact('Container com cache', bytes(row.containerBytes)) + fact('Cache de arquivos', bytes(row.cacheBytes)) : ''}
      ${row.kind === 'redis' ? fact('Dados e estruturas Redis', bytes(row.redisUsedBytes)) + fact('Dataset Redis', bytes(row.redisDatasetBytes)) + fact('Overhead Redis', bytes(row.redisOverheadBytes)) + fact('Pico Redis', bytes(row.redisPeakBytes)) + fact('Fragmentação RSS/alocação', `${row.redisFragmentation ?? '—'}`) + fact('Chaves no banco selecionado', `${row.redisKeys ?? '—'}`) : ''}
      ${row.kind === 'rabbitmq' ? fact('Disco livre', bytes(row.diskFreeBytes)) + fact('Nós ativos', `${row.rabbitRunningNodes ?? '—'} / ${row.rabbitNodes ?? '—'}`) + fact('Origem', `RabbitMQ · mem_used · ${row.rabbitMemoryStrategy || '—'}`)
            + fact('Alarme de memória', row.rabbitMemoryAlarm === undefined ? '—' : row.rabbitMemoryAlarm ? t('Ativo') : t('Normal')) + fact('Alarme de disco', row.rabbitDiskAlarm === undefined ? '—' : row.rabbitDiskAlarm ? t('Ativo') : t('Normal'))
            + fact('Limite de memória do RabbitMQ', bytes(row.rabbitMemoryLimitBytes)) + fact('Menor limite de disco livre nos nós', bytes(row.rabbitDiskFreeLimitBytes))
            + fact('Filas no cluster', `${row.rabbitQueues ?? '—'}`) + fact('Conexões no cluster', `${row.rabbitConnections ?? '—'}`) + fact('Canais no cluster', `${row.rabbitChannels ?? '—'}`) + fact('Consumidores no cluster', `${row.rabbitConsumers ?? '—'}`)
            + fact('Mensagens prontas no cluster', `${row.rabbitMessagesReady ?? '—'}`) + fact('Mensagens sem ACK no cluster', `${row.rabbitMessagesUnacked ?? '—'}`) + fact('Publicações/s no cluster', `${row.rabbitPublishRate ?? '—'}`) + fact('Entregas/s no cluster', `${row.rabbitDeliverRate ?? '—'}`) : ''}
      ${!['total', 'rabbitmq'].includes(row.kind) ? fact(row.kind === 'redis' ? 'AOF em disco (parcial)' : 'Arquivos em disco', bytes(row.diskBytes)) : ''}
      ${row.diskSampledAt ? fact('Disco medido em', time(row.diskSampledAt)) : ''}${row.fsTotalBytes ? fact('Filesystem compartilhado: usado / total', `${bytes(row.fsUsedBytes)} / ${bytes(row.fsTotalBytes)}`) : ''}
      ${row.archivedAt ? fact('Último arquivamento S3', time(row.archivedAt)) : ''}${row.droppedPoints ? fact('Pontos não arquivados descartados pelo limite', `${row.droppedPoints}`) : ''}</dl>` : '';
        const actionable = row?.kind !== 'total' && this.current?.components.some(sample => sample.id === this.selected);
        const body = `<div class="resource-detail">${row && actionable ? `<div class="resource-detail__actions" role="group" aria-label="${t('Ações do serviço')}">${this.control.actions(row.id, row.live && !this.error)}</div>` : ''}<nav class="resource-periods" aria-label="${t('Período do gráfico')}">${periods.map(([range, label]) => `<button class="btn btn--small ${this.range === range ? '' : 'btn--ghost'}" type="button" aria-pressed="${this.range === range}" data-action="resources-period" data-id="${range}"${this.busy ? ' disabled' : ''}>${t(label)}</button>`).join('')}</nav>
      ${this.busy ? `<p role="status">${t('Carregando histórico…')}</p>` : ''}${this.historyError ? `<p class="storage-warning" role="alert">${e(this.historyError)}</p><button class="btn" data-action="resources-retry">${t('Tentar novamente')}</button>` : ''}
      ${history?.warnings.length ? `<p class="storage-warning">${t('Histórico parcial. Exibindo apenas medições disponíveis do Redis/S3, sem preencher lacunas com zero.')}</p>` : ''}
      ${row?.diskShared || row?.diskPartial ? `<p class="storage-caption">${t('Disco pode ser compartilhado ou uma leitura parcial. Filesystem é capacidade do volume, não consumo exclusivo do worker. Não some esses volumes entre serviços.')}</p>` : ''}
      ${row?.kind === 'rabbitmq' ? `<p class="storage-caption">${t('RabbitMQ: CPU requer Prometheus com duas coletas válidas; leitura incompleta deixa o total de CPU parcial.')}</p>` : ''}
      <div class="resource-charts">${history ? renderResourceChart(history.points, 'ramBytes', t('Memória RAM'), history.resolution) + renderResourceChart(history.points, 'cpuPercent', t('CPU'), history.resolution) + (row?.kind === 'total' ? '' : renderResourceChart(history.points, row?.kind === 'rabbitmq' ? 'diskFreeBytes' : 'diskBytes', row?.kind === 'rabbitmq' ? t('Disco livre') : t('Disco'), history.resolution)) : ''}</div>${details}
      <p class="storage-caption">${t('CPU: 100% = 1 núcleo. Pode ultrapassar 100% ao usar vários núcleos.')}</p>
      <p class="storage-caption">${t('Histórico antigo em JSON privado no S3. Os gráficos preservam média e pico de RAM; não representam RAM exclusiva por sessão.')} <code>${e(this.current?.prefix || '')}</code></p></div>`;
        return renderModal('resources', row?.name || t('Consumo de recursos'), body, { wide: true }).replace('data-close-modal', 'data-action="resources-close"');
    }
}
