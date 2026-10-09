import { ApiError } from '../core/api.js?v=4.0.35-a50438ad';
import { escapeHtml as e } from '../core/html.js?v=4.0.35-a50438ad';
import { renderModal } from '../components/modal.js?v=4.0.35-a50438ad';
import { icon } from '../components/icons.js?v=4.0.35-a50438ad';
import { renderMobileDeviceGrid, mobileGridSession } from './mobile_device_grid.js?v=4.0.35-a50438ad';
import { sessionPhone } from '../domain/session.js?v=4.0.35-a50438ad';
import { renderMobileBackup, transferMobileBackup, downloadMobileBackup, mobileBackupError } from './mobile_backup.js?v=4.0.35-a50438ad';
const reason = 'O registro SMS exige habilitação; o cadastro não conecta automaticamente a Zapo nem altera sessões vinculadas.';
const button = (label, action, id = '') => `<button type="button" class="btn btn--ghost" data-action="mobile-${action}" data-id="${e(id)}">${action === 'new' ? icon('devicePlus') : ''}${e(label)}</button>`;
export class MobileDevicesPanel {
    constructor(api, render) {
        this.api = api;
        this.render = render;
        this.enabled = false;
        this.smsRegistration = false;
        this.devices = [];
        this.query = '';
        this.statusFilter = 'all';
        this.error = '';
        this.busy = false;
        this.transferEligible = false;
        this.backupTasks = [];
        this.generation = 0;
        this.values = { phone: '', name: '', platform: 'android', accountType: 'personal', labConsent: false };
    }
    reset() {
        this.stopCooldown();
        this.checkedDeadline = undefined;
        this.generation++;
        this.enabled = false;
        this.smsRegistration = false;
        this.registration = undefined;
        this.connection = undefined;
        this.transferEligible = false;
        this.backupDownload = undefined;
        this.backupTasks = [];
        this.devices = [];
        this.query = '';
        this.statusFilter = 'all';
        this.error = '';
        this.busy = false;
        this.modal = undefined;
        this.selected = undefined;
        this.values = { phone: '', name: '', platform: 'android', accountType: 'personal', labConsent: false };
    }
    async load(admin) {
        if (!admin) {
            this.reset();
            return;
        }
        if (this.modal || this.busy)
            return;
        const generation = this.generation;
        try {
            const caps = await this.api.request('/manager/mobile-devices/capabilities');
            const data = await this.api.request('/manager/mobile-devices');
            if (generation !== this.generation)
                return;
            this.enabled = caps.draftManagement === true;
            this.smsRegistration = caps.smsRegistration === true;
            this.devices = data.devices;
            this.error = '';
            await this.refreshBackups();
        }
        catch (error) {
            if (generation !== this.generation)
                return;
            if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
                this.reset();
                return;
            }
            this.error = 'Não foi possível consultar os dispositivos experimentais. As sessões existentes continuam independentes.';
        }
    }
    action(action, id = '') {
        if (!this.enabled || this.busy)
            return;
        this.error = '';
        if (action === 'mobile-backups-refresh') {
            void this.refreshBackups().then(() => this.render());
            return;
        }
        if (action === 'mobile-saved-backup') {
            void this.fetchSavedBackup(id);
            return;
        }
        if (action === 'mobile-backup-download' && this.backupDownload) {
            try {
                downloadMobileBackup(this.backupDownload);
            }
            catch {
                this.error = 'Não foi possível iniciar o download. Verifique as permissões de download do navegador e tente novamente.';
            }
            this.render();
            return;
        }
        this.backupDownload = undefined;
        if (action === 'mobile-reg-status') {
            void this.refreshRegistration();
            return;
        }
        if (action === 'mobile-reg-check') {
            void this.checkConfirmation();
            return;
        }
        if (action === 'mobile-connection-status') {
            void this.connectionOperation(false);
            return;
        }
        this.stopCooldown();
        this.checkedDeadline = undefined;
        if (action === 'mobile-close')
            this.modal = undefined;
        else if (action === 'mobile-restore')
            this.modal = 'restore';
        else if (action === 'mobile-new') {
            this.values = { phone: '', name: '', platform: 'android', accountType: 'personal', labConsent: false };
            this.modal = 'new';
        }
        else {
            this.selected = this.devices.find(item => item.id === id);
            this.registration = undefined;
            this.connection = undefined;
            if (!this.selected)
                return;
            if (action === 'mobile-details')
                this.modal = 'details';
            if (action === 'mobile-remove')
                this.modal = 'remove';
            if (action === 'mobile-backup')
                this.modal = 'backup';
            if (action === 'mobile-transfer-remove' && this.transferEligible)
                this.modal = 'transfer-remove';
        }
        this.render();
        if (action === 'mobile-details') {
            this.transferEligible = false;
            if (this.smsRegistration)
                void this.refreshRegistration();
            else
                void this.refreshTransferEligibility();
        }
    }
    async refreshBackups() {
        const generation = this.generation;
        try {
            const result = await this.api.request('/manager/mobile-devices/backups');
            if (generation === this.generation && Array.isArray(result?.tasks))
                this.backupTasks = result.tasks;
        }
        catch { }
    }
    async fetchSavedBackup(deviceId) {
        const task = this.backupTasks.find(item => item.deviceId === deviceId && item.status === 'ready');
        if (!task)
            return;
        const generation = this.generation;
        this.selected = this.devices.find(item => item.id === deviceId);
        this.modal = 'backup';
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(deviceId)}/backup-tasks/${encodeURIComponent(task.id)}/download`);
            if (generation !== this.generation)
                return;
            this.backupDownload = result;
            try {
                downloadMobileBackup(result);
            }
            catch {
                this.error = 'Arquivo disponível. Clique em Baixar arquivo para tentar novamente.';
            }
        }
        catch {
            if (generation === this.generation)
                this.error = 'Não foi possível baixar o arquivo. Ele pode ter expirado; atualize a lista de backups.';
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
            }
        }
    }
    async refreshTransferEligibility() {
        const id = this.selected?.id, generation = this.generation;
        if (!id)
            return;
        try {
            const result = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/transfer-removal`);
            if (generation === this.generation && this.selected?.id === id)
                this.transferEligible = result.eligible === true;
        }
        catch {
            if (generation === this.generation)
                this.transferEligible = false;
        }
        if (generation === this.generation)
            this.render();
    }
    async submit(form, data) {
        if (!this.enabled || this.busy)
            return;
        if (typeof data.get('phone') === 'string')
            data.set('phone', String(data.get('phone')).trim());
        if (form === 'mobile-backup' || form === 'mobile-restore') {
            await this.transferBackup(form, data);
            return;
        }
        if (form === 'mobile-connect') {
            if (data.get('confirmConnection') !== 'on') {
                this.error = 'Confirme a conexão deste dispositivo no laboratório.';
                this.render();
                return;
            }
            await this.connectionOperation(true);
            return;
        }
        if (form === 'mobile-sms' || form === 'mobile-voice' || form === 'mobile-verify') {
            await this.submitRegistration(form, data);
            return;
        }
        if (form !== 'mobile-create' && form !== 'mobile-delete' && form !== 'mobile-transfer-delete')
            return;
        if (form === 'mobile-create')
            this.values = {
                phone: `${data.get('phone') || ''}`, name: `${data.get('name') || ''}`,
                platform: `${data.get('platform') || ''}`, accountType: `${data.get('accountType') || ''}`,
                labConsent: data.get('labConsent') === 'on',
            };
        const generation = this.generation;
        const selected = this.selected;
        this.busy = true;
        this.error = '';
        this.render();
        try {
            if (form === 'mobile-create') {
                await this.api.request('/manager/mobile-devices', { method: 'POST', body: JSON.stringify(this.values) });
            }
            else if (form === 'mobile-transfer-delete') {
                if (!selected || data.get('confirm') !== 'on' || data.get('backupValidated') !== 'on' || data.get('phone') !== selected.phone || !data.get('password'))
                    throw new Error('Confirme a validação no novo servidor, o número e a senha do administrador.');
                await this.api.request(`/manager/mobile-devices/${encodeURIComponent(selected.id)}/transfer-removal`, { method: 'DELETE', body: JSON.stringify({ confirm: true, backupValidated: true, phone: selected.phone, password: String(data.get('password')) }) });
            }
            else {
                if (!selected || data.get('confirm') !== 'on')
                    throw new Error('Confirme a remoção do cadastro.');
                if (data.get('acknowledgeNewSms') !== 'on' || data.get('phone') !== selected.phone)
                    throw new Error('Digite o número do dispositivo e confirme que será necessário um novo registro por SMS.');
                await this.api.request(`/manager/mobile-devices/${encodeURIComponent(selected.id)}/full`, { method: 'DELETE', body: JSON.stringify({ confirm: true, acknowledgeNewSms: true, phone: selected.phone }) });
            }
            if (generation !== this.generation)
                return;
            this.modal = undefined;
            this.busy = false;
            await this.load(true);
        }
        catch (error) {
            if (generation === this.generation)
                this.error = error instanceof Error ? error.message : 'Falha na operação.';
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
            }
        }
    }
    renderButton() { return this.enabled ? button('Novo dispositivo', 'new') : ''; }
    async transferBackup(form, data) {
        const generation = this.generation;
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = await transferMobileBackup(this.api, form === 'mobile-restore', this.selected?.id, data, true);
            if (generation !== this.generation)
                return;
            if (result && 'restored' in result) {
                this.modal = undefined;
                this.busy = false;
                await this.load(true);
                if (result.warning)
                    this.error = 'Dispositivo restaurado. Não foi possível solicitar a conexão ao worker; use Conectar. Não importe novamente.';
            }
            else if (result && 'status' in result) {
                this.backupTasks = [...this.backupTasks.filter(item => item.deviceId !== result.deviceId), result];
                this.modal = undefined;
                this.busy = false;
            }
            else if (result) {
                if (typeof result.archive !== 'string' || !result.archive || typeof result.fileName !== 'string')
                    throw new Error('O servidor não retornou um arquivo de backup válido. Consulte a conexão antes de tentar novamente.');
                this.backupDownload = result;
                try {
                    downloadMobileBackup(result);
                }
                catch {
                    this.error = 'O backup foi gerado, mas o download automático não iniciou. Use o botão Baixar arquivo.';
                }
            }
            else {
                this.modal = undefined;
                this.busy = false;
                await this.load(true);
            }
        }
        catch (error) {
            if (generation === this.generation)
                this.error = mobileBackupError(error);
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
            }
        }
    }
    async connectionOperation(connect) {
        if (!this.enabled || !this.selected || this.busy || this.registration?.status !== 'registered')
            return;
        const generation = this.generation;
        const id = this.selected.id;
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/connection`, connect ? { method: 'POST', body: JSON.stringify({ confirm: true }) } : undefined);
            if (generation === this.generation && this.selected?.id === id) {
                this.connection = result;
                if (connect)
                    this.transferEligible = false;
            }
        }
        catch {
            if (generation === this.generation)
                this.error = 'Não foi possível concluir a operação de conexão. Consulte o estado; o registro e suas chaves foram preservados.';
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
            }
        }
    }
    stopCooldown() {
        if (this.cooldownTimer !== undefined)
            clearInterval(this.cooldownTimer);
        this.cooldownTimer = undefined;
    }
    countdown(deadline = this.registration?.retryAt || 0) {
        const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
    }
    watchCooldown() {
        this.stopCooldown();
        const deadlines = [!this.registration?.canResendSms ? this.registration?.retryAt : undefined, !this.registration?.canResendVoice ? this.registration?.retryAtVoice : undefined]
            .filter((value) => Number.isFinite(value) && value !== this.checkedDeadline);
        const deadline = deadlines.length ? Math.min(...deadlines) : undefined;
        if (this.modal !== 'details' || !this.selected || !['blocked', 'code_required', 'additional_confirmation_required'].includes(this.registration?.status || '') || deadline === undefined)
            return;
        const id = this.selected.id;
        const generation = this.generation;
        this.cooldownTimer = setInterval(() => {
            if (this.modal !== 'details' || this.selected?.id !== id || generation !== this.generation) {
                this.stopCooldown();
                return;
            }
            if (typeof document !== 'undefined')
                document.querySelectorAll('[data-mobile-countdown]').forEach(el => { el.textContent = this.countdown(el.getAttribute('data-mobile-countdown') === 'voice' ? this.registration?.retryAtVoice : this.registration?.retryAt); });
            if (Date.now() >= deadline && !this.busy) {
                this.checkedDeadline = deadline;
                this.stopCooldown();
                void this.refreshRegistration();
            }
        }, 1000);
    }
    async refreshRegistration() {
        if (!this.smsRegistration || !this.selected || this.busy)
            return;
        const generation = this.generation;
        const id = this.selected.id;
        const codeInput = typeof document !== 'undefined' ? document.querySelector('[data-form="mobile-verify"] input[name="code"]') : null;
        const pendingCode = this.registration?.status === 'code_required' ? codeInput?.value : undefined;
        this.stopCooldown();
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/registration`);
            if (generation === this.generation && this.selected?.id === id) {
                this.registration = result;
                if (result.status === 'registered')
                    void this.refreshTransferEligibility();
            }
        }
        catch {
            if (generation === this.generation)
                this.error = 'Não foi possível consultar o registro. Não repita a solicitação de SMS.';
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
                this.watchCooldown();
                if (pendingCode && this.selected?.id === id && this.registration?.status === 'code_required' && typeof document !== 'undefined') {
                    const input = document.querySelector('[data-form="mobile-verify"] input[name="code"]');
                    if (input)
                        input.value = pendingCode;
                }
            }
        }
    }
    async checkConfirmation() {
        if (!this.smsRegistration || !this.selected || this.busy || this.registration?.status !== 'additional_confirmation_required')
            return;
        const generation = this.generation, id = this.selected.id;
        this.stopCooldown();
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/registration/check`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
            if (generation === this.generation && this.selected?.id === id)
                this.registration = result;
        }
        catch {
            if (generation === this.generation)
                this.error = 'A confirmação ainda não pôde ser comprovada. As chaves e os prazos foram preservados; nenhum código foi solicitado. Aguarde antes de consultar novamente.';
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
                this.watchCooldown();
            }
        }
    }
    async submitRegistration(form, data) {
        if (!this.smsRegistration || !this.selected || this.busy)
            return;
        const request = form === 'mobile-sms' || form === 'mobile-voice';
        const voice = form === 'mobile-voice';
        const canResend = voice ? this.registration?.canResendVoice : this.registration?.canResendSms;
        if (request && this.registration?.status !== 'idle' && !canResend) {
            this.error = 'O envio ainda não foi liberado. Consulte o andamento e aguarde o prazo informado.';
            this.render();
            return;
        }
        const recovery = !request && this.registration?.canRetryVerification === true;
        if (recovery && data.get('confirmRecovery') !== 'on') {
            this.error = 'Confirme a nova tentativa de validação. Nenhum SMS será solicitado.';
            this.render();
            return;
        }
        if (request ? data.get('confirmSms') !== 'on' : !/^\d{6}$/.test(String(data.get('code') || ''))) {
            this.error = 'Confirme o envio do código por SMS ou ligação, ou informe os seis dígitos recebidos.';
            this.render();
            return;
        }
        const generation = this.generation;
        const id = this.selected.id;
        this.busy = true;
        this.error = '';
        this.render();
        try {
            const result = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/registration/${request ? 'request' : 'verify'}`, {
                method: 'POST', body: JSON.stringify(request ? { confirm: true, ...(voice ? { method: 'voice' } : {}), ...(canResend ? { confirmResend: true } : {}) } : { code: String(data.get('code')), ...(recovery ? { confirmRecovery: true } : {}) }),
            });
            if (generation === this.generation && this.selected?.id === id)
                this.registration = result;
        }
        catch {
            if (generation === this.generation) {
                this.registration = undefined;
                this.error = 'Consulte o andamento antes de tentar novamente. A operação pode continuar no servidor.';
            }
        }
        finally {
            if (generation === this.generation) {
                this.busy = false;
                this.render();
                this.watchCooldown();
            }
        }
    }
    renderRegistration() {
        if (!this.smsRegistration)
            return '<p>Registro SMS desativado até autorização do teste real.</p>';
        const labels = { idle: 'Não iniciado', requesting: 'Solicitando SMS', code_required: 'Aguardando código', verifying: 'Confirmando código', registered: 'Registro concluído; conexão Zapo ainda não iniciada', blocked: 'Bloqueado: é necessária análise antes de repetir', uncertain: 'Resultado incerto: não solicite outro código' };
        const state = this.registration?.status;
        if (state === 'registered' && this.connection)
            labels.registered = 'Registro concluído';
        const waiting = state === 'blocked' && this.registration?.diagnostic?.providerReason === 'too_recent';
        if (waiting)
            labels.blocked = this.registration?.canResendSms ? 'Você já pode solicitar um novo SMS.' : 'Aguardando liberação para solicitar outro SMS.';
        if (this.registration?.diagnostic?.reason === 'ipv6_relay_configuration')
            labels.blocked = 'Falha local no teste IPv6; nenhuma solicitação enviada ao WhatsApp.';
        if (state === 'blocked' && this.registration?.diagnostic?.providerReason === 'no_routes')
            labels.blocked = this.registration.canResendSms || this.registration.canResendVoice ? 'Sem rota na tentativa anterior; nova tentativa manual disponível.' : 'Sem rota na tentativa anterior; aguardando liberação do método.';
        if (state === 'blocked' && this.registration?.diagnostic?.stage === 'request' && this.registration.diagnostic.providerReason === 'blocked')
            labels.blocked = this.registration.canResendSms || this.registration.canResendVoice ? 'Solicitação recusada pelo provedor; nova tentativa manual disponível.' : 'Solicitação recusada pelo provedor; aguardando prazo ou resolução de pendência.';
        labels.additional_confirmation_required = 'Confirmação adicional solicitada pelo WhatsApp';
        let html = `<div class="mobile-overview__status"><p role="status">${e(state ? labels[state] || 'Estado desconhecido' : 'Consulte o andamento antes de iniciar.')}</p>${button('Consultar andamento', 'reg-status')}</div>`;
        if (state === 'blocked' && this.registration?.diagnostic?.reason === 'ipv6_relay_configuration')
            html += '<p>O teste IPv6 expirou ou está inválido. A solicitação não chegou ao WhatsApp. Após corrigir a saída de rede, use os controles abaixo para tentar manualmente; as chaves foram preservadas.</p>';
        if (state === 'additional_confirmation_required')
            html += `<p>Confirme a transferência no aparelho atual e depois consulte a confirmação abaixo. A consulta usa as mesmas chaves e não envia SMS ou ligação. Se o WhatsApp confirmar o registro, o painel libera a conexão à Zapo.</p><button type="button" class="btn" data-action="mobile-reg-check" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Consultando confirmação…' : 'Já confirmei no aparelho — consultar confirmação'}</button>`;
        if (state === 'additional_confirmation_required' && !Number.isFinite(this.registration?.retryAt) && !Number.isFinite(this.registration?.retryAtVoice))
            html += '<p>O provedor não informou prazo para reenvio; a solicitação permanece indisponível.</p>';
        if (state === 'registered') {
            const connectionLabels = { online: 'Conectado à Zapo', connecting: 'Conectando à Zapo', connection_requested: 'Conexão solicitada ao worker; aguarde e consulte o estado', disconnected: 'Desconectado', not_imported: 'Credenciais ainda não importadas' };
            html += `<p>Conexão: ${e(this.connection ? connectionLabels[this.connection.status] || this.connection.status : 'ainda não consultada')}</p>${button('Consultar conexão Zapo', 'connection-status')}<form data-form="mobile-connect"><label><input type="checkbox" name="confirmConnection" required>Autorizo conectar este dispositivo principal à Zapo no laboratório, preservando as chaves do registro.</label><button class="btn" ${this.busy ? 'disabled' : ''}>Conectar à Zapo</button></form>`;
        }
        if (this.registration?.canonicalPhone)
            html += `<p>Número canônico: ${e(this.registration.canonicalPhone)}</p>`;
        if (state === 'code_required' || (state === 'blocked' && !waiting && this.registration?.diagnostic?.stage === 'verify'))
            html += '<p>Se o WhatsApp atual solicitar autorização para transferir a conta, conclua essa confirmação no aparelho antes de prosseguir. Este painel ainda não detecta automaticamente essa aprovação. Não solicite outro SMS enquanto aguarda.</p>';
        const detail = this.registration?.diagnostic;
        if (Number.isFinite(this.registration?.retryAt) && !this.registration?.canResendSms)
            html += `<p>Espera de SMS informada pelo provedor até: ${e(new Date(this.registration.retryAt).toLocaleString('pt-BR'))}.</p><p>Tempo restante para SMS: <strong data-mobile-countdown="sms" role="timer">${this.countdown()}</strong></p><p>Ao terminar, o painel consulta a liberação automaticamente. Nenhum SMS é enviado sem seu clique.</p><button type="button" class="btn" disabled>Solicitar novo SMS — aguardando liberação</button>`;
        else if (detail?.reason === 'rate_limited' && !this.registration?.canResendSms && !Number.isFinite(this.registration?.retryAt))
            html += '<p>Prazo não informado pelo provedor. Não há horário de liberação calculado; o reenvio permanece indisponível até revisão.</p>';
        if (detail?.providerReason === 'no_routes')
            html += '<p>O provedor não encontrou rota para entregar o código pelo método solicitado. Com prazo explícito, o mesmo método permite nova tentativa manual após a espera, inclusive zero; sem prazo, somente o método alternativo pode ser liberado. Nenhuma solicitação é feita automaticamente.</p>';
        if (detail?.stage === 'request' && detail.providerReason === 'blocked')
            html += '<p>O provedor retornou blocked ao solicitar o código. Você pode tentar SMS ou ligação quando liberados abaixo, mantendo as mesmas chaves. Isso não garante aceitação nem confirma banimento da conta. Prazos e desafios informados pelo provedor continuam sendo respeitados; não há reenvio automático.</p>';
        if (detail && state !== 'code_required') {
            const descriptions = { code_expired: 'Código expirado ou já utilizado.', invalid_code: 'Código não aceito. Confira os dígitos recebidos.', challenge_required: 'O provedor exige uma verificação adicional.', rate_limited: 'Limite de tentativas atingido. Não repita agora.', network: 'Falha de comunicação; o resultado remoto pode ser incerto.', android_material: 'Falha no material do aplicativo Android.', local_configuration: 'Falha na configuração local.', http_error: 'O serviço remoto retornou erro HTTP.', unknown: 'Motivo não reconhecido; requer análise.' };
            if (waiting)
                descriptions.rate_limited = this.registration?.canResendSms ? 'A espera terminou. O retorno abaixo pertence à tentativa anterior.' : 'O WhatsApp pediu uma espera antes de outra solicitação.';
            html += `<p role="alert">${e(descriptions[detail.reason] || 'O provedor recusou a operação.')} Diagnóstico: ${e(detail.stage)} / ${e(detail.reason)}${detail.httpStatus ? ` / HTTP ${e(String(detail.httpStatus))}` : ''}</p>`;
            for (const [label, code] of [['Status do provedor', detail.providerStatus], ['Motivo do provedor', detail.providerReason], ['Pendência do provedor', detail.providerPending]]) {
                if (code)
                    html += `<p>${e(label)}: <code>${e(code)}</code></p>`;
            }
        }
        if (state === 'code_required')
            html += '<p>Não recebeu o código? Você pode solicitar outro SMS quando o reenvio estiver liberado. Isso não confirma o registro. Após reenviar, use somente o novo código recebido.</p>';
        if (state === 'idle' || this.registration?.canResendVoice)
            html += `<form data-form="mobile-voice"><label><input type="checkbox" name="confirmSms" required>Autorizo receber uma ligação real com o código neste número, inclusive telefone fixo. O registro pode afetar o acesso no aparelho. Use somente o novo código recebido.</label><button class="btn" ${this.busy ? 'disabled' : ''}>Receber código por ligação</button></form>`;
        else if (Number.isFinite(this.registration?.retryAtVoice) && this.registration.retryAtVoice > Date.now())
            html += `<p>Ligação disponível após a espera informada: ${e(new Date(this.registration.retryAtVoice).toLocaleString('pt-BR'))}.</p><p>Tempo restante para ligação: <strong data-mobile-countdown="voice" role="timer">${this.countdown(this.registration.retryAtVoice)}</strong>. Ao terminar, o painel consulta a liberação; não solicita o código automaticamente.</p>`;
        if (state === 'idle' || this.registration?.canResendSms)
            html += `<form data-form="mobile-sms"><label><input type="checkbox" name="confirmSms" required>Autorizo ${this.registration?.canResendSms ? 'solicitar um novo SMS, preservando as chaves existentes' : 'enviar um SMS real para este número de laboratório'}. O registro pode afetar o acesso no aparelho. Use somente o novo código recebido.</label><button class="btn" ${this.busy ? 'disabled' : ''}>${state === 'code_required' ? 'Não recebi o código — solicitar novo SMS' : this.registration?.canResendSms ? 'Solicitar novo SMS' : 'Solicitar SMS'}</button></form>`;
        if (state === 'code_required' || this.registration?.canRetryVerification)
            html += `<form class="mobile-overview__verify" data-form="mobile-verify">${this.registration?.canRetryVerification ? '<label><input type="checkbox" name="confirmRecovery" required>Autorizo uma nova tentativa de confirmação, preservando as chaves e sem solicitar outro SMS.</label>' : ''}<label class="field"><span>Código recebido por SMS ou ligação</span><input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" required><small>Informe os seis dígitos do último código recebido por SMS ou ligação.</small></label><button class="btn" ${this.busy ? 'disabled' : ''}>Confirmar código</button></form>`;
        return html;
    }
    listedSessionPhones(sessions) {
        if (!this.enabled)
            return [];
        return this.devices.flatMap(device => {
            const session = mobileGridSession(device, sessions);
            return session ? [sessionPhone(session)] : [];
        });
    }
    renderGrid(sessions = []) {
        if (!this.enabled)
            return this.error ? `<p role="alert">${e(this.error)}</p>` : '';
        const backups = this.backupTasks.length ? `<section class="mobile-overview__section" aria-label="Backups de dispositivos"><div class="mobile-overview__status"><h3>Backups de dispositivos</h3>${button('Atualizar backups', 'backups-refresh')}</div>${this.backupTasks.map(task => {
            const device = this.devices.find(item => item.id === task.deviceId);
            const status = task.status === 'ready' ? `Pronto para baixar até ${new Date(task.expiresAt).toLocaleString('pt-BR')}.` : task.status === 'running' ? 'Gerando em segundo plano. Você pode sair desta página e voltar depois.' : task.status === 'interrupted' ? 'Processamento interrompido. Consulte a conexão e solicite um novo backup.' : mobileBackupError(new ApiError(409, '', { error: task.error }));
            return `<div class="mobile-overview__status"><div><strong>${e(device?.name || task.deviceId)}</strong><p role="status">${e(status)}</p></div>${task.status === 'ready' ? button('Baixar backup', 'saved-backup', task.deviceId) : ''}</div>`;
        }).join('')}</section>` : '';
        return `${this.error && !this.modal ? `<p role="alert">${e(this.error)}</p>` : ''}${backups}${renderMobileDeviceGrid(this.devices, sessions, this.query, this.statusFilter)}`;
    }
    renderDialog() {
        if (!this.modal || !this.enabled)
            return '';
        const input = (label, name, extra = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${e(this.values[name])}" required ${extra}></label>`;
        let content = '';
        if (this.modal === 'new')
            content = `<form data-form="mobile-create">
      ${input('Telefone com código do país (somente números)', 'phone', 'inputmode="numeric" pattern="[1-9][0-9]{7,14}" maxlength="15"')}
      ${input('Nome do dispositivo', 'name', 'maxlength="80"')}
      <label class="field"><span>Plataforma pretendida</span><select name="platform"><option value="android" ${this.values.platform === 'android' ? 'selected' : ''}>Android</option><option value="ios" ${this.values.platform === 'ios' ? 'selected' : ''}>iPhone</option></select></label>
      <label class="field"><span>Tipo de conta pretendido</span><select name="accountType"><option value="personal" ${this.values.accountType === 'personal' ? 'selected' : ''}>WhatsApp pessoal</option><option value="business" ${this.values.accountType === 'business' ? 'selected' : ''}>WhatsApp Business</option></select></label>
      <p>A escolha registra a intenção de teste, não garante suporte nem emula um aparelho.</p>
      <label><input type="checkbox" name="labConsent" required ${this.values.labConsent ? 'checked' : ''}>Confirmo que este número é destinado ao laboratório e tenho autorização para utilizá-lo.</label>
      <p><button class="btn" ${this.busy ? 'disabled' : ''}>Salvar rascunho</button></p></form><hr><p>Já possui um backup deste dispositivo?</p>${button('Restaurar dispositivo', 'restore')}`;
        else if (this.modal === 'backup' && this.backupDownload)
            content = `<div class="stack"><h3 role="status">Backup gerado. Origem suspensa.</h3><p>O download foi solicitado ao navegador. Confira se o arquivo foi salvo antes de fechar esta janela.</p><p><strong>${e(this.backupDownload.fileName)}</strong></p><p>Se não baixou automaticamente, clique abaixo. Não é necessário gerar outro backup.</p>${button('Baixar arquivo .viperdevice', 'backup-download')}${button('Fechar', 'close')}</div>`;
        else if (this.modal === 'restore' || this.modal === 'backup')
            content = renderMobileBackup(this.modal === 'restore', this.busy);
        else if (this.selected) {
            const item = this.selected;
            content = `<p><strong>${e(item.name)}</strong> · ${e(item.phone)}</p><p>${e(reason)}</p>`;
            if (this.modal === 'details')
                content = `<div class="mobile-overview">
        <header class="mobile-overview__identity"><div><h3>${e(item.name)}</h3><p>${e(item.phone)}</p></div><span class="mobile-overview__tag">${item.platform === 'ios' ? 'iPhone' : 'Android'} · ${item.accountType === 'business' ? 'Business' : 'Pessoal'}</span></header>
        <section class="mobile-overview__section"><h3>Registro e conexão</h3><div class="mobile-overview__registration">${this.renderRegistration()}</div></section>
        <section class="mobile-overview__section"><h3>Dispositivos vinculados</h3><p>Após conectar o principal, abra <strong>Gerenciar → Dispositivos conectados</strong> para consultar vínculos, vincular por código de pareamento ou revogar um secundário.</p></section>
        <section class="mobile-overview__section"><h3>Backup e migração</h3><p>Salve uma cópia protegida por senha. Gerar o backup suspende a conexão nesta instância.</p>${this.registration?.status === 'registered' ? '' : '<p>Conclua o registro SMS e conecte à Zapo para habilitar o backup.</p>'}<div class="mobile-overview__actions">${this.registration?.status === 'registered' ? button('Baixar backup', 'backup', item.id) : '<button class="btn" disabled>Baixar backup — registro pendente</button>'}${this.transferEligible ? button('Remover desta instância após migração', 'transfer-remove', item.id) : ''}</div></section>
        <details class="mobile-overview__notes"><summary>Sobre o cadastro</summary><p>${e(reason)}</p><p>Não reserva o telefone, não altera atribuições e não interfere nas sessões vinculadas existentes.</p></details>
        <section class="mobile-overview__danger"><div><h3>Excluir dispositivo</h3><p>Remoção definitiva do cadastro e das credenciais locais. Exige confirmação.</p></div>${button('Excluir dispositivo', 'remove', item.id)}</section>
      </div>`;
            else if (this.modal === 'transfer-remove')
                content += `<form data-form="mobile-transfer-delete">
        <p role="alert"><strong>O backup foi validado no novo servidor?</strong> Prossiga somente após restaurar, conectar e testar no destino. Esta ação apaga o cadastro e as credenciais locais de forma definitiva, sem logout no WhatsApp ou revogação no novo servidor.</p>
        <p>Guarde o arquivo de backup e sua senha. Mídias armazenadas, histórico de webhooks e atribuições históricas não são apagados.</p>
        <label class="field"><span>Digite ${e(item.phone)} para confirmar</span><input name="phone" autocomplete="off" required></label>
        <label class="field"><span>Senha do administrador conectado (não a senha do backup)</span><input type="password" name="password" autocomplete="current-password" maxlength="4096" required></label>
        <p><label><input type="checkbox" name="backupValidated" required>Restaurei o backup e validei o funcionamento no novo servidor.</label></p>
        <p><label><input type="checkbox" name="confirm" required>Confirmo a remoção definitiva somente desta instância.</label></p>
        <button class="btn" ${this.busy ? 'disabled' : ''}>Remover desta instância</button></form>`;
            else
                content = `<form class="mobile-removal" data-form="mobile-delete">
        <div class="mobile-removal__device"><strong>${e(item.name)}</strong><span>${e(item.phone)}</span></div>
        <div class="mobile-removal__warning" role="alert"><strong>Esta ação é definitiva. Não é uma suspensão.</strong><p>A conexão será encerrada e o cadastro, o registro SMS e as credenciais locais serão apagados.</p><p>Para usar o número novamente, será necessário um novo registro por SMS, sujeito aos prazos e validações do WhatsApp.</p></div>
        <p class="mobile-removal__note">A conta no WhatsApp não será excluída. Mídias armazenadas, histórico de webhooks e atribuições históricas serão preservados.</p>
        <label class="field"><span>Digite <strong>${e(item.phone)}</strong> para confirmar</span><input name="phone" type="text" inputmode="numeric" autocomplete="off" maxlength="15" required><small>Informe o número completo, somente com dígitos.</small></label>
        <div class="mobile-removal__checks">
          <label><input type="checkbox" name="confirm" required><span>Confirmo a exclusão definitiva deste dispositivo e das credenciais locais.</span></label>
          <label><input type="checkbox" name="acknowledgeNewSms" required><span>Entendo que será necessário um novo registro por SMS.</span></label>
        </div>
        <p class="mobile-removal__note">Se a conexão ainda estiver encerrando, aguarde e repita a exclusão. Não solicite outro SMS durante a remoção.</p>
        <footer class="mobile-removal__actions"><button type="button" class="btn btn--ghost" data-action="mobile-close" ${this.busy ? 'disabled' : ''}>Cancelar</button><button type="submit" class="btn btn--danger" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Excluindo…' : 'Excluir definitivamente'}</button></footer>
      </form>`;
        }
        return renderModal('mobile-draft', this.modal === 'new' ? 'Novo dispositivo' : this.modal === 'remove' ? 'Excluir dispositivo' : 'Visão geral do dispositivo', `${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}${content}`)
            .replace('data-close-modal', `data-action="mobile-close" ${this.busy ? 'disabled' : ''}`);
    }
}
