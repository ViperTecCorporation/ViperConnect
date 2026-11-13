import { renderStorageDialog, renderStorageMetrics, renderStorageOverview, storageRestoreAvailable } from './session_storage_view.js?v=4.0.42-39b50dec';
import { downloadMobileBackup } from './mobile_backup.js?v=4.0.42-39b50dec';
import { normalizeStorageBackupFiles, validStorageBackupId } from './session_storage_downloads.js?v=4.0.42-39b50dec';
import { SessionStorageExplorer } from './session_storage_explorer.js?v=4.0.42-39b50dec';
export function normalizeStorageMetrics(value) {
    const stored = value?.storage, migrated = value?.migration;
    return {
        worker: value?.worker ? { ...value.worker, sessionCount: value.worker.sessionCount ?? value.worker.sharedSessionCount ?? 0 } : undefined,
        session: value?.session || (stored ? { backend: stored.backend, sqliteBytes: stored.files?.databaseBytes, walBytes: stored.files?.walBytes, shmBytes: stored.files?.shmBytes,
            logicalBytes: stored.estimatedLogicalBytes, records: stored.records, redisEstimatedBytes: stored.backend === 'redis' ? stored.estimatedBytes : undefined,
            redisSampledKeys: stored.sampledKeys, cacheBudgetBytes: stored.cacheBudgetBytes, partial: stored.partial } : undefined),
        migration: migrated ? { ...migrated, beforeRedisEstimatedBytes: migrated.beforeRedisEstimatedBytes ?? migrated.before?.storage?.estimatedBytes,
            afterSqliteBytes: migrated.afterSqliteBytes ?? migrated.after?.storage?.files?.databaseBytes } : undefined,
        sampledAt: value?.sampledAt,
    };
}
const path = (phone) => `/v15.0/${encodeURIComponent(phone)}/storage`;
const pending = (task) => !!task && ['queued', 'running'].includes(task.status);
const restoring = (task) => ['restore', 'restore-upload'].includes(task.kind || task.operation || '');
const MAX_RESTORE_UPLOAD_BYTES = 256 * 1024 * 1024;
export function storageTaskError(code, fallback) {
    if (code === 'session_storage_active_calls')
        return 'Há uma ligação ou operação VoIP em andamento. A migração não começou e a ligação foi preservada. Aguarde encerrar para tentar novamente.';
    if (code === 'session_storage_voip_gate_required')
        return 'Atualize o worker e o plugin VoIP antes de migrar. A sessão não foi desconectada.';
    return code || fallback;
}
export class SessionStoragePanel {
    constructor(api, render, pollLimit = 120, metricsActive = () => true) {
        this.api = api;
        this.render = render;
        this.pollLimit = pollLimit;
        this.metricsActive = metricsActive;
        this.phone = '';
        this.modal = false;
        this.busy = false;
        this.error = '';
        this.notice = '';
        this.confirmed = false;
        this.restoreMode = false;
        this.metricsError = '';
        this.backupsLoading = false;
        this.backupDownloading = false;
        this.backupsError = '';
        this.revision = 0;
        this.polls = 0;
        this.expanded = new Set();
        this.explorer = new SessionStorageExplorer(api, render);
    }
    reset() {
        this.explorer.reset();
        this.revision++;
        if (this.timer)
            clearTimeout(this.timer);
        if (this.metricsTimer)
            clearTimeout(this.metricsTimer);
        this.metricsTimer = undefined;
        this.metrics = undefined;
        this.metricsError = '';
        this.timer = undefined;
        this.phone = '';
        this.modal = false;
        this.busy = false;
        this.confirmed = false;
        this.restoreMode = false;
        this.status = undefined;
        this.task = undefined;
        this.error = '';
        this.notice = '';
        this.polls = 0;
        this.backupFiles = undefined;
        this.backupsLoading = false;
        this.backupDownloading = false;
        this.backupsError = '';
        this.expanded.clear();
    }
    async load(phone) {
        if (this.phone !== phone) {
            this.reset();
            this.phone = phone;
        }
        const revision = this.revision;
        try {
            const status = await this.api.request(path(phone));
            if (revision !== this.revision || this.phone !== phone)
                return;
            this.status = status;
            this.error = '';
            if (status.currentTask?.phone === phone) {
                this.task = status.currentTask;
                if (['failed', 'interrupted'].includes(this.task.status))
                    this.error = storageTaskError(this.task.error, 'A tarefa falhou ou foi interrompida. Consulte a recuperação antes de repetir a operação.');
                this.schedule(revision);
            }
        }
        catch (error) {
            if (revision === this.revision)
                this.error = error instanceof Error ? error.message : 'Armazenamento indisponível.';
        }
        if (revision === this.revision)
            this.render();
    }
    startMetrics(phone) {
        const revision = this.revision;
        if (this.metricsTimer)
            clearTimeout(this.metricsTimer);
        const refresh = async () => {
            if (revision !== this.revision || this.phone !== phone)
                return;
            if (!this.metricsActive()) {
                this.metricsTimer = setTimeout(() => { this.metricsTimer = undefined; void refresh(); }, 5000);
                return;
            }
            try {
                const metrics = await this.api.request(`${path(phone)}/metrics`);
                if (revision !== this.revision)
                    return;
                this.metrics = normalizeStorageMetrics(metrics);
                this.metricsError = '';
            }
            catch (error) {
                if (revision !== this.revision)
                    return;
                this.metricsError = error instanceof Error ? error.message : 'Métricas indisponíveis.';
            }
            if (revision !== this.revision)
                return;
            if (!this.modal)
                this.render();
            this.metricsTimer = setTimeout(() => { this.metricsTimer = undefined; void refresh(); }, 5000);
        };
        void refresh();
    }
    schedule(revision) {
        if (!pending(this.task) || revision !== this.revision || this.timer)
            return;
        if (this.polls >= this.pollLimit) {
            this.notice = 'A tarefa continua pendente. A consulta automática foi pausada; use Atualizar tarefa. Não solicite outra migração ou backup.';
            this.render();
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (revision === this.revision)
                void this.checkTask();
        }, 2000);
    }
    async checkTask() {
        if (!this.task || this.busy)
            return;
        const revision = this.revision, phone = this.phone, id = this.task.id;
        this.busy = true;
        this.polls++;
        try {
            const task = await this.api.request(`${path(phone)}/tasks/${encodeURIComponent(id)}`);
            if (revision !== this.revision)
                return;
            if (task.id !== id || task.phone !== phone)
                throw new Error('A resposta não corresponde à tarefa desta sessão.');
            this.task = task;
            this.error = '';
            if (task.status === 'failed' || task.status === 'interrupted')
                this.error = storageTaskError(task.error, 'A tarefa falhou ou foi interrompida. Consulte o estado antes de tentar novamente.');
            else if (task.status === 'succeeded' || task.status === 'ready') {
                this.notice = (task.kind || task.operation) === 'backup' ? 'Backup concluído pelo worker. Consulte o destino e a política de retenção.'
                    : restoring(task) ? 'Restauração concluída pelo worker. Nenhuma conexão foi solicitada; confirme o estado da sessão.' : 'Migração concluída pelo worker. Consulte a conexão e valide o funcionamento.';
                await this.load(phone);
            }
        }
        catch (error) {
            if (revision === this.revision)
                this.error = `${error instanceof Error ? error.message : 'Não foi possível consultar a tarefa.'} Não repita a operação sem consultar seu resultado.`;
            return;
        }
        finally {
            if (revision === this.revision) {
                this.busy = false;
                this.render();
            }
        }
        this.schedule(revision);
    }
    async action(action, phone = this.phone, backupId) {
        if (action === 'storage-explorer-open') {
            if (this.busy || pending(this.task))
                return;
            await this.load(phone);
            if (this.status?.backend !== 'sqlite')
                return;
            this.modal = true;
            await this.explorer.show(phone, this.status.state === 'offline' && this.status.autoConnect === false && ['offline', 'disconnected'].includes(this.status.connectionStatus || ''));
            return;
        }
        if (action.startsWith('storage-explorer-')) {
            await this.explorer.action(action, phone);
            this.modal = this.explorer.open;
            this.render();
            return;
        }
        if (['storage-toggle-technical', 'storage-toggle-configuration', 'storage-toggle-backups'].includes(action)) {
            const key = action.slice('storage-toggle-'.length);
            if (this.expanded.has(key))
                this.expanded.delete(key);
            else
                this.expanded.add(key);
            this.render();
            if (key === 'backups' && this.expanded.has(key))
                await this.loadBackupFiles();
            return;
        }
        if (action === 'storage-backups-refresh') {
            await this.loadBackupFiles();
            return;
        }
        if (action === 'storage-download-latest' || action === 'storage-download-backup') {
            if (phone !== this.phone || this.status?.backend !== 'sqlite' || this.backupDownloading)
                return;
            if (action === 'storage-download-backup' && (!backupId || !validStorageBackupId(backupId) || !this.backupFiles?.slots.some(slot => slot.id === backupId)))
                return;
            const revision = this.revision;
            this.backupDownloading = true;
            this.backupsError = '';
            this.render();
            try {
                const id = action === 'storage-download-latest' ? 'latest' : backupId;
                const blob = await this.api.downloadBackup(`/manager/storage/${encodeURIComponent(phone)}/backups/${id}/download`);
                if (revision !== this.revision)
                    return;
                downloadMobileBackup({ archive: blob, fileName: `sessao-${phone}-${id}.viperstorage` });
            }
            catch {
                if (revision === this.revision)
                    this.backupsError = 'Não foi possível baixar o backup. Atualize a lista e confira sua disponibilidade.';
            }
            finally {
                if (revision === this.revision) {
                    this.backupDownloading = false;
                    this.render();
                }
            }
            return;
        }
        if (action === 'storage-close') {
            this.explorer.reset();
            this.modal = false;
            this.confirmed = false;
            this.restoreMode = false;
            this.render();
            return;
        }
        if (action === 'storage-open' || action === 'storage-restore-open') {
            await this.load(phone);
            this.confirmed = false;
            this.restoreMode = action === 'storage-restore-open';
            this.modal = true;
            this.render();
            return;
        }
        if (action === 'storage-refresh') {
            await this.load(this.phone);
            return;
        }
        if (action === 'storage-task') {
            if (this.timer)
                clearTimeout(this.timer);
            this.timer = undefined;
            this.polls = 0;
            await this.checkTask();
        }
    }
    async loadBackupFiles() {
        if (!this.phone || this.status?.backend !== 'sqlite' || this.backupsLoading)
            return;
        const revision = this.revision, phone = this.phone;
        this.backupsLoading = true;
        this.backupsError = '';
        this.render();
        try {
            const files = await this.api.request(`/manager/storage/${encodeURIComponent(phone)}/backups`);
            if (revision === this.revision)
                this.backupFiles = normalizeStorageBackupFiles(files);
        }
        catch {
            if (revision === this.revision)
                this.backupsError = 'Não foi possível consultar os arquivos de backup.';
        }
        finally {
            if (revision === this.revision) {
                this.backupsLoading = false;
                this.render();
            }
        }
    }
    async submit(form, data) {
        if (form.startsWith('storage-explorer-')) {
            await this.explorer.submit(form, data);
            return;
        }
        if (this.busy || pending(this.task))
            return;
        const revision = this.revision, phone = this.phone;
        this.error = '';
        this.notice = '';
        this.confirmed = data.get('confirm') === 'on';
        if (!this.status || !phone || data.get('confirm') !== 'on') {
            this.error = 'Consulte o armazenamento e confirme a operação.';
            this.render();
            return;
        }
        if (['migrating', 'restoring', 'backing_up'].includes(this.status.state)) {
            this.error = 'Há uma operação em andamento nesta sessão.';
            this.render();
            return;
        }
        if (form === 'storage-migrate' && this.status.backend !== 'redis') {
            this.error = 'A sessão já utiliza SQLite.';
            this.render();
            return;
        }
        if (form === 'storage-migrate' && !this.status.capability?.sqliteAvailable) {
            this.error = 'Configure e valide o volume persistente e as variáveis do worker antes de migrar.';
            this.render();
            return;
        }
        if (!['storage-migrate', 'storage-backup', 'storage-restore-upload'].includes(form))
            return;
        let archive;
        if (form === 'storage-restore-upload') {
            if (!storageRestoreAvailable(this.status, this.task)) {
                this.error = 'A restauração exige sessão explicitamente offline, reconexão automática desativada e autorização do worker.';
                this.render();
                return;
            }
            const file = data.get('archive');
            if (typeof File === 'undefined' || !(file instanceof File) || !file.name.toLowerCase().endsWith('.viperstorage') || file.size < 1 || file.size > MAX_RESTORE_UPLOAD_BYTES) {
                this.error = 'Selecione um backup .viperstorage, não vazio e com até 256 MiB.';
                this.render();
                return;
            }
            archive = file;
        }
        this.busy = true;
        this.render();
        try {
            const task = archive ? await this.api.request(`${path(phone)}/restore-upload?confirm=true&mode=offline`, {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archive,
            }) : await this.api.request(`${path(phone)}/${form === 'storage-migrate' ? 'migrations' : 'backups'}`, {
                method: 'POST', body: JSON.stringify(form === 'storage-migrate' ? { target: 'sqlite', confirm: true } : { confirm: true }),
            });
            if (revision !== this.revision)
                return;
            if (!task?.id || task.phone !== phone)
                throw new Error('A resposta não identifica uma tarefa válida desta sessão.');
            if (archive && (task.kind || task.operation) && !restoring(task))
                throw new Error('A resposta não identifica uma tarefa de restauração desta sessão.');
            this.task = task;
            this.polls = 0;
            if (!['failed', 'interrupted'].includes(task.status)) {
                this.modal = false;
                this.confirmed = false;
                this.restoreMode = false;
            }
            this.notice = archive ? 'Arquivo enviado. Aguarde a validação e a conclusão da restauração pelo worker; nenhuma conexão será solicitada.' : 'Operação registrada. Aguarde a conclusão da tarefa; isso ainda não confirma migração ou backup.';
            if (task.status === 'failed' || task.status === 'interrupted')
                this.error = storageTaskError(task.error, 'A tarefa falhou ou foi interrompida.');
            if (task.status === 'succeeded' || task.status === 'ready') {
                this.notice = archive || restoring(task) ? 'Restauração concluída pelo worker. Nenhuma conexão foi solicitada; confirme o estado da sessão.' : 'Tarefa concluída pelo worker. Consulte o estado e valide o funcionamento.';
                await this.load(phone);
            }
        }
        catch (error) {
            if (revision === this.revision)
                this.error = `${error instanceof Error ? error.message : 'Falha ao solicitar operação.'} Não houve repetição automática. Atualize o estado antes de tentar novamente.`;
        }
        finally {
            if (revision === this.revision) {
                this.busy = false;
                this.render();
            }
        }
        this.schedule(revision);
    }
    setConfirmed(confirmed) { this.confirmed = confirmed; }
    viewState() {
        return { phone: this.phone, status: this.status, task: this.task, metrics: this.metrics, modal: this.modal, busy: this.busy, error: this.error, metricsError: this.metricsError, notice: this.notice, expanded: this.expanded, confirmed: this.confirmed, restoreMode: this.restoreMode, backupFiles: this.backupFiles, backupsLoading: this.backupsLoading, backupDownloading: this.backupDownloading, backupsError: this.backupsError };
    }
    metricsHtml() { return renderStorageMetrics(this.viewState()); }
    html(phone) { return phone === this.phone ? renderStorageOverview(this.viewState()) : ''; }
    dialog() { return this.explorer.open ? this.explorer.html() : renderStorageDialog(this.viewState()); }
}
