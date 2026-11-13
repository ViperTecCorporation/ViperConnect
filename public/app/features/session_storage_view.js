import { escapeHtml as e } from '../core/html.js?v=4.0.42-39b50dec';
import { renderModal } from '../components/modal.js?v=4.0.42-39b50dec';
import { renderStorageBackupFiles } from './session_storage_downloads.js?v=4.0.42-39b50dec';
const bytes = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${(value / 1048576).toFixed(1)} MiB` : '—';
const states = { active: 'Disponível', offline: 'Offline', migrating: 'Em migração', restoring: 'Restaurando', backing_up: 'Gerando backup' };
const phases = { queued: 'Preparando', draining: 'Pausando a sessão', copy: 'Copiando dados', native: 'Convertendo dados', validating: 'Validando dados', backup: 'Verificando backup no S3', source_cleanup: 'Liberando dados antigos do Redis', ready: 'Concluído' };
const owner = (status) => typeof status?.owner === 'string' ? status.owner : status?.owner?.workerId || status?.owner?.serverId || 'Não informado';
const pending = (task) => !!task && ['queued', 'running'].includes(task.status);
const facts = (rows) => `<dl class="storage-facts">${rows.filter(([, value]) => value !== undefined).map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value || '—')}</dd></div>`).join('')}</dl>`;
export function storageRestoreAvailable(status, task, busy = false) {
    return !!status && !busy && !pending(task) && status.backend === 'sqlite' && status.state === 'offline' && status.autoConnect === false
        && ['offline', 'disconnected'].includes(status.connectionStatus || '') && status.restoreUpload?.available === true && status.capability?.sqliteAvailable === true;
}
function backupLocation(view) {
    const policy = view.status?.backupPolicy, location = policy?.location, retention = policy?.retention;
    return `${location ? facts([['Bucket S3', location.bucket], ['Prefixo dos backups', location.prefix], ['Índices dos dias', location.slotsPrefix]]) : '<p class="muted">Destino S3 não informado pelo worker.</p>'}
    ${retention?.strategy === 'weekday-slots' ? facts([['Retenção', `${retention.slots} slots · último backup de cada dia da semana`], ['Fuso dos backups', retention.timeZone]]) : ''}
    ${view.status?.lastBackup?.objectKey ? facts([['Último arquivo', view.status.lastBackup.objectKey]]) : ''}`;
}
function backups(view, scope) {
    const enabled = storageRestoreAvailable(view.status, view.task, view.busy);
    const latest = !!view.backupFiles?.latest || !!view.status?.lastBackup?.id || !!view.status?.lastBackup?.objectKey;
    return disclosure(view, 'backups', 'Backup e restauração', `${backupLocation(view)}<div class="storage-actions">${view.status?.backend === 'sqlite' ? `<button type="button" class="btn btn--ghost btn--small" data-action="storage-download-latest" data-id="${e(view.phone)}"${!latest || view.backupDownloading ? ' disabled' : ''}>${view.backupDownloading ? 'Baixando…' : 'Baixar último backup'}</button><button type="button" class="btn btn--ghost btn--small" data-action="storage-backups-refresh" data-id="${e(view.phone)}"${view.backupsLoading ? ' disabled' : ''}>Atualizar arquivos</button>` : ''}</div>${view.backupsError ? `<p class="storage-warning" role="alert">${e(view.backupsError)}</p>` : ''}${renderStorageBackupFiles(view.phone, view.backupFiles, view.backupDownloading)}<p class="storage-caption">Restauração manual por arquivo .viperstorage, com a sessão offline e a reconexão automática desativada. Novos backups não usam criptografia nem chave. Backups antigos criptografados exigem a chave correspondente configurada no worker; não informe senha no navegador. O arquivo contém credenciais: mantenha-o privado.</p><div class="storage-actions"><button type="button" class="btn btn--ghost btn--small" data-action="storage-restore-open" data-id="${e(view.phone)}"${enabled ? '' : ' disabled'}>Restaurar arquivo de backup</button></div>${enabled ? '' : '<p class="muted">Upload indisponível: confirme o estado offline, a reconexão desativada e a disponibilidade no worker. Para outro servidor ou sessão ainda inexistente, use Restaurar sessão na lista geral.</p>'}`, scope);
}
function disclosure(view, key, label, content, scope) {
    const open = view.expanded.has(key), id = `storage-${e(view.phone)}-${scope}-${key}`;
    return `<div class="storage-disclosure"><button type="button" class="storage-disclosure__toggle" data-action="storage-toggle-${key}" aria-expanded="${open}" aria-controls="${id}"><span>${e(label)}</span><span aria-hidden="true">${open ? '−' : '+'}</span></button><div id="${id}" class="storage-disclosure__body"${open ? '' : ' hidden'}>${content}</div></div>`;
}
function feedback(view) {
    if (view.error)
        return '<p role="alert" class="storage-feedback storage-feedback--error">Não foi possível confirmar a operação. Atualize o estado e consulte os detalhes.</p>';
    if (!view.task)
        return view.notice ? `<p role="status" class="storage-feedback">${e(view.notice)}</p>` : '';
    const task = view.task, ready = ['ready', 'succeeded'].includes(task.status), failed = ['failed', 'interrupted'].includes(task.status);
    const phase = task.phase || (typeof task.progress === 'object' ? task.progress.phase : '');
    const reconnect = task.result?.reconnect;
    const label = ready ? ((task.kind || task.operation) === 'backup' ? 'Backup concluído' : ['restore', 'restore-upload'].includes(task.kind || task.operation || '') ? 'Restauração concluída · Sem reconexão' : reconnect?.status === 'requested' ? 'Migração concluída · Reconexão solicitada' : reconnect?.status === 'failed' ? 'Migração concluída · Reconexão pendente' : 'Migração concluída') : failed ? 'Operação não concluída' : `${phases[phase || ''] || 'Operação em andamento'}…`;
    return `<div role="status" class="storage-feedback${ready ? ' storage-feedback--success' : failed ? ' storage-feedback--error' : ''}"><span>${e(label)}</span>${pending(task) ? '<button class="btn btn--ghost btn--small" type="button" data-action="storage-task">Atualizar</button>' : ''}</div>`;
}
function configuration(view, scope) {
    const capability = view.status?.capability;
    if (!view.status)
        return '';
    if (capability?.sqliteAvailable) {
        if (capability.defaultBackend !== 'redis')
            return '';
        const body = '<p>No worker responsável, defina:</p><pre><code>SESSION_STORAGE_DEFAULT=sqlite</code></pre><p>Aplique a configuração ao worker preservando os volumes e o dono da sessão. O padrão vale apenas para novas sessões; as existentes exigem migração manual. Sessões já migradas permanecem no SQLite.</p><a href="https://viperconnect.vipertec.net/guide/session-storage" target="_blank" rel="noopener noreferrer">Ver documentação de armazenamento</a>';
        return `<p class="storage-warning" role="alert">SQLite disponível, mas novas sessões ainda usam Redis.</p>${disclosure(view, 'configuration', 'Como ativar SQLite', body, scope)}`;
    }
    const example = capability?.configurationExample;
    const environment = typeof example?.env === 'string' ? example.env : Object.entries(example?.env || {}).map(([key, value]) => `${key}=${value}`).join('\n');
    const body = `<p>Monte um volume persistente em <code>/app/session-data</code> no worker responsável. SQLite e esse caminho já são os padrões para novas sessões; as variáveis abaixo permitem explicitá-los ou trocar o caminho. Uma pasta no container ou apenas declarar as variáveis não comprova persistência. Sem volume validado, novas sessões usam Redis; sessões já migradas não trocam de banco silenciosamente. Redis continua obrigatório para configuração e coordenação.</p>${capability?.reason ? facts([['Motivo', capability.reason]]) : ''}${environment ? `<pre><code>${e(environment)}</code></pre>` : ''}${example?.compose ? `<pre><code>${e(example.compose)}</code></pre>` : ''}<a href="https://viperconnect.vipertec.net/guide/session-storage" target="_blank" rel="noopener noreferrer">Ver documentação de armazenamento</a>`;
    return `<p class="storage-warning" role="alert">SQLite indisponível neste worker. Novas sessões usarão Redis; configure o volume persistente.</p>${disclosure(view, 'configuration', 'Como configurar', body, scope)}`;
}
function technical(view, scope) {
    const { status, metrics, task } = view, worker = metrics?.worker, container = worker?.container, session = metrics?.session, migration = metrics?.migration;
    const body = `${status ? facts([['Worker', owner(status)], ['Estado do armazenamento', status.state], ['Geração', String(status.generation)], ['Padrão para novas sessões', status.capability?.defaultBackend], ['Backup automático S3', status.backupPolicy ? status.backupPolicy.enabled ? 'A cada 12 horas' : 'Desativado' : undefined], ['Proteção dos novos backups', status.backupPolicy?.protection === 'none' ? 'Sem criptografia' : undefined], ['Último backup', status.lastBackup?.createdAt || 'Ainda não gerado'], ['Proteção do último backup', status.lastBackup?.protection === 'none' ? 'Sem criptografia' : undefined], ['Estado do backup', status.backupPolicy?.schedule?.phase || status.lastBackup?.status], ['Erro do backup', status.backupPolicy?.schedule?.lastError?.code || status.lastBackup?.error]]) : ''}
    ${worker ? `<h4>Memória compartilhada</h4>${facts([['RAM do worker (RSS)', bytes(worker.rssBytes)], ['Heap', bytes(worker.heapUsedBytes)], ['Buffers externos', bytes(worker.externalBytes)], ['Clientes carregados', String(worker.sessionCount)]])}` : ''}
    ${container ? facts([['Total do container (cgroup)', bytes(container.currentBytes)], ['Memória anônima', bytes(container.anonBytes)], ['Arquivos/cache', bytes(container.fileBytes)], ['Arquivos inativos', bytes(container.inactiveFileBytes)], ['Kernel', bytes(container.kernelBytes)]]) : '<p class="muted">Detalhamento de memória do container indisponível.</p>'}
    <p class="storage-footnote">A RAM acima é do processo/container inteiro, não desta sessão. Não some cgroup ao RSS. Arquivos inativos não são RAM livre garantida; clientes carregados não contam bancos SQLite offline.</p>
    ${session?.backend === 'sqlite' ? `<h4>Banco da sessão</h4>${facts([['SQLite (disco)', bytes(session.sqliteBytes)], ['WAL (disco)', bytes(session.walBytes)], ['SHM (disco)', bytes(session.shmBytes)], ['Registros', String(session.records ?? '—')], ['Orçamento de cache SQLite', bytes(session.cacheBudgetBytes)], ['Amostra', session.partial ? 'Estimativa parcial' : 'Concluída']])}<p class="storage-footnote">O orçamento de cache é soft; não é consumo medido nem teto de RAM da sessão. Tamanho em disco não é consumo de RAM.</p>` : session?.backend === 'redis' ? facts([['Redis estimado', bytes(session.redisEstimatedBytes)], ['Chaves amostradas', String(session.redisSampledKeys ?? 0)], ['Amostra', session.partial ? 'Estimativa parcial' : 'Concluída']]) : ''}
    ${migration ? `<h4>Resultado da migração</h4>${facts([['Duração', typeof migration.durationMs === 'number' ? `${(migration.durationMs / 1000).toFixed(1)} s` : undefined], ['Redis antes (estimativa)', bytes(migration.beforeRedisEstimatedBytes)], ['SQLite depois (disco)', bytes(migration.afterSqliteBytes)], ['Origem Redis', migration.sourcePreserved === true ? 'Preservada' : migration.sourcePreserved === false ? 'Removida após validação e backup' : undefined]])}<p class="storage-footnote">Excluir as chaves antigas reduz os dados no Redis, mas não comprova queda imediata do RSS. Uma origem preservada ainda ocupa memória.</p>` : ''}
    ${task ? facts([['ID da tarefa', task.id], ['Estado da tarefa', task.status], ['Etapa', task.phase || (typeof task.progress === 'object' ? task.progress.phase : undefined)], ['Reconexão', task.result?.reconnect?.status], ['Motivo da reconexão', task.result?.reconnect?.reason]]) : ''}
    ${view.error || view.metricsError || view.notice ? facts([['Erro da operação', view.error || undefined], ['Erro de métricas', view.metricsError || undefined], ['Aviso', view.notice || undefined]]) : ''}
    <p class="storage-footnote">Atualização a cada 5 segundos; contagens e estimativas podem usar amostras de até 60 segundos.${metrics?.sampledAt ? ` Amostra: ${e(new Date(metrics.sampledAt).toLocaleString('pt-BR'))}.` : ''}</p>
    <div class="storage-actions"><button type="button" class="btn btn--ghost btn--small" data-action="storage-refresh">Atualizar estado</button><a href="https://viperconnect.vipertec.net/guide/session-storage" target="_blank" rel="noopener noreferrer">Documentação</a></div>`;
    return disclosure(view, 'technical', 'Detalhes técnicos', body, scope);
}
export function renderStorageMetrics(view) {
    const metrics = view.metrics, worker = metrics?.worker;
    const session = metrics?.session && (!view.status || view.status.backend === metrics.session.backend) ? metrics.session : undefined;
    const sqlite = (view.status?.backend || session?.backend) === 'sqlite', value = sqlite ? session?.sqliteBytes : session?.redisEstimatedBytes;
    return `<div class="storage-metrics">
    <article class="storage-metric"><span>${sqlite ? 'Banco SQLite' : 'Dados no Redis'}</span><strong>${bytes(value)}</strong><small>${sqlite ? `Em disco${typeof session?.records === 'number' ? ` · ${e(session.records.toLocaleString('pt-BR'))} registros` : ''}` : session?.partial ? 'Estimativa parcial desta sessão' : 'Estimativa desta sessão'}</small></article>
    <article class="storage-metric"><span>RAM do worker</span><strong>${worker ? bytes(worker.rssBytes) : '—'}</strong><small>Compartilhada entre as sessões</small></article>
    </div><p class="storage-caption">RAM exclusiva desta sessão ainda não é medida.</p>${view.metricsError ? '<p class="storage-warning" role="alert">Métricas temporariamente indisponíveis.</p>' : ''}${technical(view, 'overview')}`;
}
export function renderStorageOverview(view) {
    const status = view.status, capability = status?.capability;
    const blocked = view.busy || pending(view.task) || !status || ['migrating', 'restoring', 'backing_up'].includes(status.state);
    return `<section class="section session-storage"><div class="storage-heading"><div><h2>Armazenamento da sessão</h2><p class="muted">${status ? `<span class="storage-badge">${e(status.backend.toUpperCase())}</span> Worker: ${e(owner(status))}${['migrating', 'restoring', 'backing_up'].includes(status.state) ? ` · ${e(states[status.state])}` : ''}` : 'Consultando armazenamento…'}</p></div><button class="btn btn--ghost" type="button" data-action="storage-open" data-id="${e(view.phone)}"${blocked ? ' disabled' : ''}>${status?.backend === 'sqlite' ? 'Backup e opções' : capability?.sqliteAvailable ? 'Migrar para SQLite' : 'Configurar armazenamento'}</button></div>
    ${status?.fixture ? '<p class="storage-warning" role="alert"><strong>Dados de teste – conexão/envios bloqueados.</strong></p>' : ''}
    <div class="storage-actions">${status?.backend === 'sqlite' ? `<button type="button" class="btn btn--ghost btn--small" data-action="storage-explorer-open" data-id="${e(view.phone)}"${blocked ? ' disabled' : ''}>Explorar SQLite</button>` : ''}<button type="button" class="btn btn--ghost btn--small" data-action="storage-redis-open" data-id="${e(view.phone)}">Redis da sessão</button></div>
    ${feedback(view)}${configuration(view, 'overview')}${renderStorageMetrics(view)}${backups(view, 'overview')}</section>`;
}
export function renderStorageDialog(view) {
    if (!view.modal)
        return '';
    if (view.restoreMode) {
        const blocked = !storageRestoreAvailable(view.status, view.task, view.busy);
        const content = `<div class="storage-dialog"><p class="storage-dialog__summary">Restaure um backup .viperstorage desta sessão. A sessão permanecerá offline; nenhuma conexão ou reenvio será solicitado.</p>
      ${backupLocation(view)}<p class="storage-caption">Arquivo .viperstorage com até 256 MiB, validado no worker. Novos backups não usam criptografia nem chave. Somente backups antigos criptografados exigem a chave correspondente configurada no worker. O navegador não solicita nem recebe essa chave. O arquivo contém credenciais: mantenha-o privado. Um .sqlite isolado não substitui o pacote de backup.</p>
      ${view.error ? `<p role="alert" class="storage-feedback storage-feedback--error">${e(view.error)}</p>` : pending(view.task) ? feedback(view) : ''}${blocked && !view.busy ? '<p class="storage-warning" role="alert">A restauração exige sessão explicitamente offline, reconexão automática desativada e autorização do worker.</p>' : ''}
      <form class="storage-confirm-form" data-form="storage-restore-upload"><label>Arquivo de backup<input type="file" name="archive" accept=".viperstorage,application/octet-stream" required${blocked ? ' disabled' : ''}></label>
        <label class="storage-confirm"><input type="checkbox" name="confirm" required${blocked ? ' disabled' : ''}${view.confirmed ? ' checked' : ''}><span>Confirmo restaurar esta sessão somente offline, sem conectar nem reenviar mensagens.</span></label>
        <div class="storage-actions storage-actions--end"><button type="button" class="btn btn--ghost" data-action="storage-close">Cancelar</button><button class="btn"${blocked ? ' disabled' : ''}>${view.busy ? 'Enviando…' : 'Enviar e restaurar offline'}</button></div></form></div>`;
        return renderModal('session-storage', 'Restaurar backup da sessão', content, { subtitle: view.phone }).replace('data-close-modal', 'data-action="storage-close"');
    }
    const status = view.status, migrate = status?.backend === 'redis';
    const blocked = view.busy || pending(view.task) || !status || ['migrating', 'restoring', 'backing_up'].includes(status.state) || !status.capability?.sqliteAvailable;
    const content = `<div class="storage-dialog"><p class="storage-dialog__summary">${migrate ? 'A sessão será pausada sem logout. Mensagens e IDs serão preservados.' : 'Crie um backup sem criptografia dos dados e credenciais desta sessão.'}</p>${migrate ? '<p class="storage-caption">Se estava ativa, a reconexão será solicitada após a validação.</p>' : ''}
    <p class="muted">Worker: <strong>${e(owner(status))}</strong>${migrate ? ' · Redis → SQLite' : ' · SQLite'}</p>
    ${status?.fixture ? '<p class="storage-warning" role="alert"><strong>Sessão sintética de laboratório.</strong> Conexão e envios bloqueados.</p>' : ''}
    ${view.error || pending(view.task) ? feedback(view) : ''}${configuration(view, 'dialog')}
    ${status ? `<form class="storage-confirm-form" data-form="storage-${migrate ? 'migrate' : 'backup'}"><label class="storage-confirm"><input type="checkbox" name="confirm" required ${blocked ? 'disabled' : ''}${view.confirmed ? ' checked' : ''}><span>${migrate ? 'Autorizo pausar a sessão e migrar os dados.' : 'Confirmo a geração do backup sem criptografia.'}</span></label><div class="storage-actions storage-actions--end"><button type="button" class="btn btn--ghost" data-action="storage-close">Cancelar</button><button class="btn"${blocked ? ' disabled' : ''}>${view.busy ? 'Aguarde…' : migrate ? 'Iniciar migração' : 'Gerar backup'}</button></div></form>` : '<p role="alert">Consulte o armazenamento antes de continuar.</p>'}
    <p class="storage-caption">${migrate ? 'Após validação e backup verificado no S3, os dados antigos da sessão serão removidos do Redis. Configuração e coordenação permanecem.' : 'Requer destino S3 privado. Novos backups não usam chave e contêm credenciais; aguarde a confirmação e mantenha o arquivo privado.'}</p>
    ${backups(view, 'dialog')}${technical(view, 'dialog')}</div>`;
    return renderModal('session-storage', migrate ? 'Migrar para SQLite' : 'Backup do armazenamento', content, { subtitle: view.phone }).replace('data-close-modal', 'data-action="storage-close"');
}
