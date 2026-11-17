import { ApiError } from '../core/api.js?v=4.0.44-f63f46d2';
import { escapeHtml as e } from '../core/html.js?v=4.0.44-f63f46d2';
import { t } from '../core/i18n.js?v=4.0.44-f63f46d2';
import { renderModal } from '../components/modal.js?v=4.0.44-f63f46d2';
const active = (operation) => !!operation && ['accepted', 'restarting'].includes(operation.state);
export function controlMessage(code = '') {
    if (code === 'control_calls_active')
        return t('Há chamada ativa. Encerre-a antes de reiniciar.');
    if (code === 'control_storage_busy')
        return t('Há migração, backup ou restauração em andamento.');
    if (code === 'control_jobs_active')
        return t('Há tarefas em processamento. Aguarde antes de reiniciar.');
    if (['control_instance_changed', 'control_confirmation_expired', 'control_confirmation_invalid'].includes(code))
        return t('A instância ou a confirmação mudou. Feche e confira o serviço novamente.');
    if (code === 'control_busy')
        return t('Outro serviço está sendo reiniciado. Aguarde.');
    if (code === 'control_not_configured')
        return t('Configure o agente de controle para habilitar o reinício.');
    if (code === 'control_swarm_unsupported')
        return t('Reinício de serviços Swarm não é suportado por este agente.');
    if (code === 'control_not_running')
        return t('O serviço não está em execução. Verifique no servidor.');
    if (code === 'control_agent_self_forbidden')
        return t('O agente não pode reiniciar a si próprio.');
    return t('Não foi possível confirmar a operação. Consulte o estado; não repita o reinício automaticamente.');
}
export class ResourceControlPanel {
    constructor(api, render) {
        this.api = api;
        this.render = render;
        this.opened = false;
        this.busy = false;
        this.error = '';
        this.loading = false;
        this.revision = 0;
        this.nextPoll = 0;
        this.polling = false;
        this.pendingId = '';
        try {
            this.pendingId = globalThis.sessionStorage?.getItem('resource-restart-operation') || '';
        }
        catch { }
    }
    reset() { this.revision++; this.overview = undefined; this.selected = undefined; this.operation = undefined; this.opened = false; this.busy = false; this.loading = false; this.error = ''; this.pendingId = ''; this.polling = false; this.nextPoll = 0; this.save(); }
    save() { try {
        if (this.pendingId)
            globalThis.sessionStorage?.setItem('resource-restart-operation', this.pendingId);
        else
            globalThis.sessionStorage?.removeItem('resource-restart-operation');
    }
    catch { } }
    async refresh() {
        const revision = this.revision;
        try {
            const value = await this.api.request('/admin/resources/control');
            if (revision === this.revision)
                this.overview = Array.isArray(value?.targets) ? value : { configured: false, targets: [], reason: 'control_unavailable' };
        }
        catch {
            if (revision === this.revision)
                this.overview = { configured: false, targets: [], reason: 'control_unavailable' };
        }
    }
    async poll(force = false) {
        if (!this.pendingId || this.polling || !force && (Date.now() < this.nextPoll || this.operation && !active(this.operation)))
            return;
        const revision = this.revision;
        this.polling = true;
        this.nextPoll = Date.now() + 3000;
        try {
            const value = await this.api.request(`/admin/resources/operations/${this.pendingId}`);
            if (revision === this.revision) {
                this.operation = value;
                this.error = value.error ? controlMessage(value.error) : '';
            }
        }
        catch {
            if (revision === this.revision)
                this.error = controlMessage();
        }
        finally {
            if (revision === this.revision) {
                this.polling = false;
                this.render();
            }
        }
    }
    actions(component, live) {
        const target = this.overview?.targets.find(target => target.component === component);
        const enabled = live && target?.available && !this.busy && !this.pendingId;
        const reason = !live ? t('Reinício indisponível para medições antigas.') : this.pendingId ? t('Consulte a operação anterior antes de iniciar outra.') : target?.reason ? controlMessage(target.reason) : !target ? controlMessage(this.overview?.reason || 'control_not_configured') : '';
        return `<div class="resource-service-actions"><button type="button" class="btn btn--small btn--ghost" data-action="resources-logs-open" data-id="${e(component)}"${target?.logs ? '' : ' disabled'} title="${target?.logs ? t('Consultar logs ao vivo') : t('Configure ou atualize o agente para consultar os logs.')}">${t('Logs')}</button><button type="button" class="btn btn--small btn--ghost" data-action="resources-control-open" data-id="${e(component)}"${enabled ? '' : ' disabled'} title="${e(reason)}">${t('Reiniciar serviço')}</button>${target ? `<small class="muted">${e(target.backend)}</small>` : ''}</div>`;
    }
    status() { return this.pendingId ? `<p class="storage-caption" role="status">${t('Reinício de serviço')} · <button class="btn btn--small btn--ghost" type="button" data-action="resources-control-status">${t('Consultar operação')}</button></p>` : this.overview && !this.overview.configured ? `<p class="storage-caption">${e(controlMessage(this.overview.reason))} <a href="https://viperconnect.vipertec.net/guide/resource-metrics#reiniciar-serviços" target="_blank" rel="noopener">${t('Como configurar')}</a></p>` : ''; }
    async action(action, id = '') {
        if (action === 'resources-control-close') {
            if (this.busy)
                return;
            this.opened = false;
            if (this.operation && !active(this.operation)) {
                this.pendingId = '';
                this.save();
            }
            this.render();
            return;
        }
        if (action === 'resources-control-status') {
            this.opened = true;
            this.render();
            await this.poll(true);
            return;
        }
        if (action === 'resources-control-open') {
            if (this.loading || this.busy || this.pendingId)
                return;
            const revision = this.revision;
            this.loading = true;
            this.selected = undefined;
            this.operation = undefined;
            this.error = '';
            this.opened = true;
            this.render();
            await this.refresh();
            if (revision !== this.revision)
                return;
            const target = this.overview?.targets.find(target => target.component === id);
            this.selected = target;
            if (!target?.available)
                this.error = controlMessage(target?.reason || this.overview?.reason);
            this.loading = false;
            this.render();
            return;
        }
        if (action !== 'resources-control-confirm' || this.busy || !this.selected?.available || this.pendingId)
            return;
        if (!this.selected.expiresAt || this.selected.expiresAt <= Date.now()) {
            this.error = controlMessage('control_confirmation_expired');
            this.render();
            return;
        }
        const revision = this.revision, target = this.selected;
        let requestId;
        try {
            requestId = crypto.randomUUID();
        }
        catch {
            this.error = controlMessage();
            this.render();
            return;
        }
        this.busy = true;
        this.error = '';
        this.pendingId = requestId;
        this.save();
        this.render();
        try {
            const result = await this.api.request(`/admin/resources/${target.component}/restart`, { method: 'POST', body: JSON.stringify({ operationId: this.pendingId, confirm: target.component, confirmation: target.confirmation }) });
            if (revision === this.revision) {
                this.operation = result;
                if (result.error)
                    this.error = controlMessage(result.error);
            }
        }
        catch (error) {
            if (revision === this.revision) {
                const code = error instanceof ApiError ? error.payload?.error : undefined;
                this.error = controlMessage(code);
                if (error instanceof ApiError && [400, 403, 404, 409, 423].includes(error.status)) {
                    this.pendingId = '';
                    this.save();
                }
            }
        }
        finally {
            if (revision === this.revision) {
                this.busy = false;
                this.render();
            }
        }
    }
    dialog() {
        if (!this.opened)
            return '';
        const operation = this.operation;
        const state = operation?.state === 'running' ? t('Serviço em execução após o reinício.') : operation?.state === 'failed' ? t('Reinício recusado; serviço não reiniciado.') : operation?.state === 'unknown' ? t('Resultado não confirmado. Verifique os logs do serviço antes de tentar novamente.') : t('Reiniciando… Acompanhe a operação sem repetir o comando.');
        const body = `${this.loading ? `<p role="status">${t('Verificando serviço…')}</p>` : ''}${this.error ? `<p class="storage-warning" role="alert">${e(this.error)}</p>` : ''}
      ${operation ? `<p role="status">${state}</p><p class="storage-caption">${e(operation.name)} · <code>${e(operation.id)}</code></p>${operation.state === 'running' ? `<p class="storage-caption">${operation.applicationHealth === 'healthy' ? t('Healthcheck do serviço aprovado.') : t('Processo em execução; saúde da aplicação e sessões Online não foram confirmadas.')}</p>` : ''}` : this.selected ? `<p><strong>${e(this.selected.name)}</strong> · ${e(this.selected.backend)}</p><p>${t('O serviço ficará temporariamente indisponível. Sessões podem desconectar; volumes e configurações não serão removidos.')}</p><p class="storage-caption">${t('O controle verifica chamadas e tarefas antes de reiniciar. Evite iniciar novas operações durante a confirmação.')}</p>` : ''}
      <div class="form-actions"><button type="button" class="btn btn--ghost" data-action="resources-control-close"${this.busy ? ' disabled' : ''}>${operation || this.pendingId ? t('Fechar') : t('Cancelar')}</button>
      ${!operation && !this.pendingId && this.selected?.available ? `<button type="button" class="btn btn--danger" data-action="resources-control-confirm"${this.busy ? ' disabled' : ''}>${t('Confirmar reinício')}</button>` : ''}
      ${this.pendingId ? `<button type="button" class="btn" data-action="resources-control-status">${t('Consultar operação')}</button>` : ''}</div>`;
        return renderModal('resource-control', t('Reiniciar serviço'), body).replace('data-close-modal', 'data-action="resources-control-close"');
    }
}
