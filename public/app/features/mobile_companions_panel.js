import { escapeHtml } from '../core/html.js?v=4.0.35-a50438ad';
import { createQrReader } from './qr_reader.js?v=4.0.35-a50438ad';
export function formatCompanionCode(value) {
    const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
export class MobileCompanionsPanel {
    setSendHistory(value) { if (!this.busy && !this.isCapturing)
        this.sendHistory = value; }
    get isCapturing() { return this.cameraPending || this.readingImage || !!this.stream; }
    constructor(api, render, root) {
        this.api = api;
        this.render = render;
        this.root = root;
        this.device = '';
        this.revision = 0;
        this.busy = false;
        this.message = '';
        this.cameraRevision = 0;
        this.cameraPending = false;
        this.readingImage = false;
        this.sendHistory = true;
    }
    reset() {
        this.revision++;
        clearTimeout(this.timer);
        this.stopCamera();
        this.device = '';
        this.rows = undefined;
        this.busy = false;
        this.readingImage = false;
        this.sendHistory = true;
        this.message = '';
    }
    open(id) { this.reset(); this.device = id; void this.command('list'); }
    html(session, restricted) {
        if (!session.mobilePrimaryDraftId)
            return '';
        if (restricted)
            return '<p>O gerenciamento de vínculos está reservado ao administrador neste piloto.</p>';
        const disabled = this.busy ? 'disabled' : '';
        return `<section class="section companions-panel">
      <header class="companions-heading"><div><h2>Dispositivos conectados</h2><p class="muted">Gerencie os dispositivos vinculados à sua conta.</p></div>
      <button class="btn" data-action="companion-list" ${disabled}>Atualizar vínculos</button></header>
      <p class="companions-status muted" role="status">${escapeHtml(this.message || 'A lista ainda não foi consultada.')}</p>
      ${this.rows ? this.rows.length ? `<ul class="companions-list">${this.rows.map(row => `<li class="companion-row"><div class="companion-identity"><strong>Dispositivo${row.deviceJid.match(/:(\d+)@/) ? ` ${escapeHtml(row.deviceJid.match(/:(\d+)@/)[1])}` : ' vinculado'}</strong><span class="muted">${escapeHtml(row.deviceJid)}</span></div><div class="companion-date"><span class="muted">Vinculado em</span><span>${row.addedAtSeconds === undefined ? 'Data não disponível' : escapeHtml(new Date(row.addedAtSeconds * 1000).toLocaleString())}</span></div>${row.canRevoke === false ? '<span class="muted">Sem registro local: revogue no WhatsApp.</span>' : `<button class="btn btn--danger" data-action="companion-revoke" data-id="${escapeHtml(row.deviceJid)}" aria-label="Revogar vínculo de ${escapeHtml(row.deviceJid)}" ${disabled}>Revogar vínculo</button>`}</li>`).join('')}</ul>` : '<div class="companions-empty muted">Nenhum vínculo registrado neste principal. Use o código abaixo para adicionar um dispositivo.</div>' : ''}
      <p class="companions-note muted">A lista confirma vínculos, não presença on-line. Revogar remove somente o secundário selecionado.</p>
      <section class="companion-pairing" aria-labelledby="companion-pairing-title"><h3 id="companion-pairing-title">Vincular novo dispositivo</h3>
      <label><input type="checkbox" data-companion-history ${this.sendHistory ? 'checked' : ''} ${disabled}> Enviar histórico de mensagens</label>
      <p class="companions-note muted">Vale para QR e código. Desmarcado: vincula sem exportar mensagens antigas do Redis; a inicialização e as chaves obrigatórias continuam sendo enviadas.</p>
      <p class="muted">Leia um QR Code recém-gerado no WhatsApp Web ou aparelho secundário, ou escolha vincular pelo número de telefone.</p>
      <form data-form="companion-image"><label class="field"><span>Imagem do QR Code</span><input type="file" name="image" accept="image/png,image/jpeg,image/webp" required ${disabled}></label><button class="btn" ${disabled}>Ler QR Code da imagem</button></form>
      <div class="toolbar"><button class="btn" type="button" data-action="companion-camera" ${disabled}>Ler QR Code pela câmera</button><button class="btn" type="button" data-action="companion-stop-camera">Desligar câmera</button></div>
      <video data-companion-video autoplay muted playsinline aria-label="Leitura do QR Code" style="width:100%;max-width:360px"></video>
      <p class="companions-note muted">A câmera exige HTTPS ou localhost e permissão. A leitura é local; confirme somente dispositivos sob seu controle. O vínculo por QR está em validação no lab.</p>
      <form class="companion-code-form" data-form="companion-code"><label class="field" for="companion-pairing-code"><span>Código de pareamento</span><input id="companion-pairing-code" data-companion-code name="value" required maxlength="9" pattern="[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}" title="Informe os 8 caracteres do código de pareamento." autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="companion-code-help" placeholder="ABCD-EFGH" ${disabled}></label><button class="btn" ${disabled}>Vincular por código</button></form>
      <p id="companion-code-help" class="companions-note muted">8 caracteres (letras e números). Use o código de pareamento, não o SMS de registro.</p></section>
      <details class="companion-history"><summary>Histórico do novo vínculo · textos e vídeos</summary><p class="muted">Quando a opção está marcada, o histórico disponível no Redis é enviado em lotes no novo vínculo, sem corte por idade ou quantidade total. Inclui somente textos e vídeos; outros tipos não são exportados. Arquivos expirados podem não abrir. Exclui mensagens temporárias e de visualização única. Reconectar não reenvia o histórico. A lista pode não incluir vínculos criados fora desta instância.</p></details></section>`;
    }
    async action(action, value = '') {
        if (action === 'companion-stop-camera') {
            this.stopCamera();
            return;
        }
        if (this.busy || this.readingImage || !this.device)
            return;
        if (action === 'companion-list')
            await this.command('list');
        if (action === 'companion-revoke' && window.confirm(`Revogar o vínculo de ${value}? O principal continuará conectado.`))
            await this.command('revoke', value);
        if (action === 'companion-camera')
            await this.camera();
    }
    async submit(form, data) {
        if (this.busy || this.readingImage || !this.device)
            return;
        const revision = this.revision;
        if (form === 'companion-image') {
            try {
                const file = data.get('image');
                if (!file || file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
                    throw new Error('Use uma imagem PNG, JPEG ou WebP de até 5 MB.');
                if (!window.confirm('Autorizar o vínculo do dispositivo mostrado nesta imagem? Use um print recente, obtido de um aparelho ou navegador sob seu controle. Ao ler o QR, o pedido será enviado.'))
                    return;
                this.readingImage = true;
                const reader = await createQrReader();
                if (revision !== this.revision)
                    return;
                const bitmap = await createImageBitmap(file);
                try {
                    if (bitmap.width * bitmap.height > 16000000)
                        throw new Error('A imagem excede 16 megapixels. Recorte somente o QR Code.');
                    const codes = reader.detect(bitmap);
                    if (revision !== this.revision)
                        return;
                    if (codes.length !== 1)
                        throw new Error('QR Code não encontrado. Recorte o QR atual com uma margem branca e tente novamente.');
                    await this.command('qr', codes[0].rawValue);
                }
                finally {
                    bitmap.close();
                }
            }
            catch (error) {
                if (revision === this.revision) {
                    this.message = error.message;
                    this.render();
                }
            }
            finally {
                if (revision === this.revision)
                    this.readingImage = false;
            }
            return;
        }
        const value = String(data.get('value') || '').trim();
        if (form === 'companion-qr')
            await this.confirmQr(value);
        if (form === 'companion-code') {
            const code = value.replace(/[-\s]/g, '').toUpperCase();
            if (!/^[A-Z0-9]{8}$/.test(code)) {
                this.message = 'Informe os 8 caracteres do código de pareamento (letras e números).';
                this.render();
                return;
            }
            if (window.confirm('Autorizar este dispositivo secundário a acessar sua conta?'))
                await this.command('code', code);
        }
    }
    async confirmQr(value) {
        this.stopCamera();
        if (window.confirm('Vincular o dispositivo deste QR Code? Ele terá acesso à sua conta. Confirme somente se o QR veio do seu aparelho ou navegador.'))
            await this.command('qr', value);
    }
    stopCamera() {
        this.cameraRevision++;
        this.cameraPending = false;
        clearTimeout(this.cameraTimer);
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = undefined;
    }
    async camera() {
        this.stopCamera();
        const revision = this.revision;
        const capture = this.cameraRevision;
        try {
            if (!window.confirm('Autorizar o vínculo do próximo QR lido pela câmera? Aponte somente para o WhatsApp Web ou aparelho que você controla. O pedido será enviado assim que o QR for lido.'))
                return;
            this.cameraPending = true;
            const detector = await createQrReader();
            if (revision !== this.revision || capture !== this.cameraRevision)
                return;
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
            if (revision !== this.revision || capture !== this.cameraRevision) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            this.cameraPending = false;
            this.stream = stream;
            const video = this.root.querySelector('[data-companion-video]');
            if (!video) {
                this.stopCamera();
                return;
            }
            video.srcObject = stream;
            await video.play();
            const scan = async () => {
                if (revision !== this.revision || capture !== this.cameraRevision || !this.stream)
                    return;
                if (!video.isConnected) {
                    this.stopCamera();
                    return;
                }
                try {
                    const codes = await detector.detect(video);
                    if (revision !== this.revision || capture !== this.cameraRevision || !this.stream)
                        return;
                    if (!video.isConnected) {
                        this.stopCamera();
                        return;
                    }
                    if (codes.length === 1) {
                        this.stopCamera();
                        await this.command('qr', codes[0].rawValue);
                        return;
                    }
                    this.cameraTimer = setTimeout(() => void scan(), 300);
                }
                catch {
                    this.stopCamera();
                    this.message = 'Não foi possível ler a câmera. Tente uma imagem.';
                    this.render();
                }
            };
            void scan();
        }
        catch {
            if (revision !== this.revision || capture !== this.cameraRevision)
                return;
            this.stopCamera();
            this.message = 'Câmera indisponível: verifique HTTPS e permissão, ou use um print recente.';
            this.render();
        }
    }
    async command(action, value) {
        this.stopCamera();
        const revision = this.revision, device = this.device;
        this.busy = true;
        this.message = 'Aguardando o worker…';
        this.render();
        try {
            const operation = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(device)}/companions`, { method: 'POST', body: JSON.stringify({ action, ...(value ? { value, confirm: true } : {}), ...(['qr', 'code'].includes(action) ? { sendHistory: this.sendHistory } : {}) }) });
            const poll = async () => {
                if (revision !== this.revision)
                    return;
                try {
                    const response = await this.api.request(`/manager/mobile-devices/${encodeURIComponent(device)}/companions/${encodeURIComponent(operation.id)}`);
                    if (revision !== this.revision)
                        return;
                    if (['queued', 'running'].includes(response.state)) {
                        this.timer = setTimeout(() => void poll(), 1000);
                        return;
                    }
                    this.busy = false;
                    if (response.state === 'done') {
                        if (action === 'list') {
                            this.rows = response.result.companions;
                            this.message = response.result.source === 'server_device_list' ? 'Lista de dispositivos consultada no WhatsApp.' : response.result.source === 'epoch_after_reconciliation' ? 'Lista atualizada após reconciliação de vínculos.' : 'Lista consultada no worker.';
                        }
                        else {
                            this.message = 'Operação concluída. Atualize a lista para conferir o vínculo.';
                            this.rows = undefined;
                        }
                    }
                    else
                        this.message = action === 'qr'
                            ? 'Vínculo não confirmado. O QR pode ter expirado ou o WhatsApp pode ter recusado o pedido. Atualize os vínculos antes de repetir; se não estiver vinculado, leia o QR atual ou envie um novo print. O QR antigo não será reenviado automaticamente.'
                            : 'Resultado não confirmado. Atualize os vínculos antes de repetir. Nenhuma tentativa será reenviada automaticamente.';
                    this.render();
                }
                catch {
                    if (revision === this.revision) {
                        this.busy = false;
                        this.message = 'Consulta interrompida. Atualize os vínculos antes de repetir.';
                        this.render();
                    }
                }
            };
            void poll();
        }
        catch {
            if (revision === this.revision) {
                this.busy = false;
                this.message = 'Não foi possível iniciar. Confira se o principal está conectado e se há outra operação em andamento; depois atualize os vínculos.';
                this.render();
            }
        }
    }
}
