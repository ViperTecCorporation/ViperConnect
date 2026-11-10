import { escapeHtml as e } from '../core/html.js?v=4.0.41-39b50dec';
import { renderModal } from '../components/modal.js?v=4.0.41-39b50dec';
import { downloadMobileBackup } from './mobile_backup.js?v=4.0.41-39b50dec';
export class VoipBackupPanel {
    constructor(api, render) {
        this.api = api;
        this.render = render;
        this.open = false;
        this.busy = false;
        this.error = '';
        this.notice = '';
        this.mode = '';
        this.restoreId = '';
        this.revision = 0;
    }
    reset() { this.revision++; this.open = false; this.busy = false; this.error = ''; this.notice = ''; this.mode = ''; this.restoreId = ''; this.status = undefined; }
    async load() {
        const revision = this.revision;
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const value = await this.api.request('/manager/voip-backups');
            if (revision === this.revision)
                this.status = value;
        }
        catch (error) {
            if (revision === this.revision)
                this.error = error instanceof Error ? error.message : 'Não foi possível consultar os backups.';
        }
        finally {
            if (revision === this.revision) {
                this.busy = false;
                this.render();
            }
        }
    }
    async action(action, id = '') {
        if (action === 'voip-backup-close') {
            if (!this.busy) {
                this.reset();
                this.render();
            }
            ;
            return;
        }
        if (this.busy)
            return;
        if (action === 'voip-backup-open') {
            this.reset();
            this.open = true;
            await this.load();
            return;
        }
        if (action === 'voip-backup-refresh') {
            await this.load();
            return;
        }
        if (action === 'voip-backup-cancel') {
            this.mode = '';
            this.render();
            return;
        }
        if (action === 'voip-backup-create' && this.status?.enabled)
            this.mode = 'backup';
        if (action === 'voip-backup-upload' && this.status?.enabled)
            this.mode = 'upload';
        const file = this.status?.files?.find(file => file.id === id);
        if (action === 'voip-backup-restore' && file) {
            this.restoreId = id;
            this.mode = 'restore';
        }
        if (action === 'voip-backup-download' && file) {
            const revision = this.revision;
            this.busy = true;
            this.render();
            try {
                const blob = await this.api.downloadBackup(`/manager/voip-backups/${id}/download`);
                if (revision === this.revision)
                    downloadMobileBackup({ archive: blob, fileName: `voip-${id}.vipervoip` });
            }
            catch {
                if (revision === this.revision)
                    this.error = 'Não foi possível baixar o backup VoIP.';
            }
            finally {
                if (revision === this.revision)
                    this.busy = false;
            }
        }
        this.render();
    }
    async submit(data) {
        if (this.busy || !this.status?.enabled || !this.mode)
            return;
        if (data.get('confirm') !== 'on') {
            this.error = 'Confirme a operação.';
            this.render();
            return;
        }
        let archive;
        if (this.mode === 'upload') {
            const file = data.get('archive');
            if (!(file instanceof File) || !file.name.endsWith('.vipervoip') || file.size < 1 || file.size > 256 * 1024 * 1024) {
                this.error = 'Selecione um arquivo .vipervoip válido de até 256 MiB.';
                this.render();
                return;
            }
            archive = file;
        }
        const revision = this.revision, backup = this.mode === 'backup';
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = archive ? await this.api.request('/manager/voip-backups/restore-upload?confirm=true', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archive })
                : await this.api.request(`/manager/voip-backups${backup ? '' : '/restore'}`, { method: 'POST', body: JSON.stringify(backup ? { confirm: true } : { confirm: true, backupId: this.restoreId }) });
            if (revision !== this.revision)
                return;
            if (backup ? result?.status !== 'ready' || result?.uploadVerified !== true : result?.restored !== true)
                throw new Error('Resposta não confirmou a operação');
            this.mode = '';
            this.notice = backup ? 'Backup VoIP confirmado no S3.' : `Base VoIP restaurada. Webhooks desativados e registros SIP removidos; revise a configuração. Backup anterior: ${result.beforeBackupId}.`;
            await this.load();
        }
        catch (error) {
            if (revision === this.revision)
                this.error = `${error instanceof Error ? error.message : 'Operação não confirmada'}. Não houve repetição automática; atualize o estado antes de tentar novamente.`;
        }
        finally {
            if (revision === this.revision) {
                this.busy = false;
                this.render();
            }
        }
    }
    dialog() {
        if (!this.open)
            return '';
        const status = this.status, waiting = ['restoring', 'restore_unconfirmed'].includes(status?.state?.phase || ''), disabled = this.busy || !status?.enabled;
        const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const body = `<div class="storage-dialog"><p>Base VoIP, configurações e áudios de espera. <strong>Gravações não são incluídas.</strong></p>
      ${status?.prefix ? `<dl class="storage-facts"><div><dt>Bucket</dt><dd>${e(status.bucket || '')}</dd></div><div><dt>Caminho</dt><dd><code>${e(status.prefix)}</code></dd></div><div><dt>Rotina</dt><dd>${status.automatic ? 'A cada 12 horas' : 'Somente manual'} · 7 slots semanais</dd></div></dl>` : ''}
      ${status && !status.enabled ? `<p class="storage-warning">Indisponível: ${e(status.reason || 'SQLite VoIP não disponível')}. Atualize o serviço VoIP e confira o S3.</p>` : ''}
      ${this.error ? `<p class="storage-warning" role="alert">${e(this.error)}</p>` : ''}${this.notice ? `<p role="status" class="storage-caption">${e(this.notice)}</p>` : ''}
      ${waiting ? '<p class="storage-warning">Restauração pendente de confirmação. Não repita a operação; use Atualizar para conferir o recibo do VoIP.</p>' : ''}
      <div class="storage-actions"><button class="btn" type="button" data-action="voip-backup-create"${disabled || waiting ? ' disabled' : ''}>Gerar backup</button><button class="btn btn--ghost" type="button" data-action="voip-backup-upload"${disabled || waiting ? ' disabled' : ''}>Restaurar arquivo</button><button class="btn btn--ghost" type="button" data-action="voip-backup-refresh"${this.busy ? ' disabled' : ''}>Atualizar</button></div>
      ${this.mode ? `<form data-form="voip-backup-confirm" class="storage-confirm-form">${this.mode === 'upload' ? '<label>Backup VoIP<input type="file" name="archive" accept=".vipervoip,application/octet-stream" required></label>' : ''}<label class="storage-confirm"><input type="checkbox" name="confirm" required${this.busy ? ' disabled' : ''}>${this.mode === 'backup' ? 'Confirmo gerar um backup privado sem criptografia, incluindo as credenciais do VoIP.' : 'Confirmo substituir a base VoIP, sem ligações ou tarefas em andamento. Será criado um backup anterior no S3. Webhooks ficarão desativados e ramais deverão registrar novamente.'}</label><div class="storage-actions"><button class="btn"${this.busy ? ' disabled' : ''}>${this.busy ? 'Processando…' : 'Confirmar'}</button><button class="btn btn--ghost" type="button" data-action="voip-backup-cancel"${this.busy ? ' disabled' : ''}>Cancelar</button></div></form>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Slot</th><th>Último backup</th><th>Tamanho</th><th>Ações</th></tr></thead><tbody>${(status?.files || []).map(file => `<tr><td>${days[file.day]}</td><td>${e(new Date(file.createdAt).toLocaleString('pt-BR'))}</td><td>${(file.bytes / 1048576).toFixed(1)} MiB</td><td><div class="row-actions"><button class="btn btn--ghost btn--small" type="button" data-action="voip-backup-download" data-id="${e(file.id)}"${this.busy ? ' disabled' : ''}>Baixar</button><button class="btn btn--danger btn--small" type="button" data-action="voip-backup-restore" data-id="${e(file.id)}"${disabled || waiting ? ' disabled' : ''}>Restaurar</button></div></td></tr>`).join('') || '<tr><td colspan="4">Nenhum backup semanal confirmado.</td></tr>'}</tbody></table></div><p class="storage-caption">Arquivo privado .vipervoip, sem chave de backup. Não contém sessões WhatsApp, Redis ou os arquivos de gravação. Não substitui .viperstorage. Na restauração, endereços SIP e diretório de gravações do destino são mantidos; cursors antigos do histórico expiram e não há replay de filas.</p></div>`;
        return renderModal('voip-backups', 'Backups do VoIP', body, { wide: true }).replace('data-close-modal', 'data-action="voip-backup-close"');
    }
}
