import { ApiError } from '../core/api.js?v=4.0.43-010277e1';
import { escapeHtml as e } from '../core/html.js?v=4.0.43-010277e1';
import { t } from '../core/i18n.js?v=4.0.43-010277e1';
import { renderModal } from '../components/modal.js?v=4.0.43-010277e1';
const defaults = () => ({ tail: '300', include: '', exclude: '', level: 'all', channel: 'all' });
const formatting = (line) => `${line.timestamp || '—'} [${line.level || '?'}] [${line.channel}] ${line.text}`;
export function logErrorMessage(error) {
    const code = error instanceof ApiError ? error.payload?.error : '';
    if (code === 'logs_not_configured')
        return t('Configure ou atualize o agente para consultar os logs.');
    if (code === 'logs_viewers_limit')
        return t('Limite de leitores atingido. Feche outro visualizador e tente novamente.');
    if (code === 'logs_query_invalid')
        return t('Filtros inválidos. Use até 8 termos separados por vírgula, sem expressões regulares.');
    if (code === 'logs_target_not_allowed')
        return t('Este serviço não está autorizado para leitura de logs.');
    return t('Leitura interrompida. Verifique o agente e a fonte de logs; retome para tentar novamente.');
}
export class ResourceLogsPanel {
    constructor(api, render, root = () => typeof document === 'undefined' ? null : document) {
        this.api = api;
        this.render = render;
        this.root = root;
        this.opened = false;
        this.component = '';
        this.name = '';
        this.state = 'paused';
        this.error = '';
        this.reason = '';
        this.follow = true;
        this.filters = defaults();
        this.lines = [];
        this.dropped = 0;
        this.ids = new Set();
        this.bytes = 0;
        this.since = 0;
        this.revision = 0;
        this.urls = new Set();
        this.visibility = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && this.abort) {
            this.pause();
            this.reason = t('Pausado porque a aba ficou oculta.');
            this.paint();
        } };
    }
    reset() {
        this.revision++;
        this.abort?.abort();
        this.abort = undefined;
        clearTimeout(this.paintTimer);
        this.paintTimer = undefined;
        if (typeof document !== 'undefined')
            document.removeEventListener('visibilitychange', this.visibility);
        for (const url of this.urls)
            URL.revokeObjectURL(url);
        this.urls.clear();
        this.opened = false;
        this.lines = [];
        this.ids.clear();
        this.bytes = 0;
        this.dropped = 0;
        this.since = 0;
        this.component = '';
        this.name = '';
        this.filters = defaults();
        this.state = 'paused';
        this.error = '';
        this.reason = '';
        this.follow = true;
    }
    open(component, name) {
        this.reset();
        this.opened = true;
        this.component = component;
        this.name = name;
        if (typeof document !== 'undefined')
            document.addEventListener('visibilitychange', this.visibility);
        this.connect(true);
    }
    draft(name, value) { if (Object.prototype.hasOwnProperty.call(this.filters, name))
        this.filters[name] = value; }
    submit(data) { for (const name of Object.keys(this.filters))
        this.draft(name, String(data.get(name) || '')); this.connect(true); }
    connect(clear) {
        this.revision++;
        this.abort?.abort();
        if (clear) {
            this.lines = [];
            this.ids.clear();
            this.bytes = 0;
            this.dropped = 0;
            this.since = 0;
        }
        const revision = this.revision, abort = new AbortController();
        this.abort = abort;
        this.state = 'connecting';
        this.error = '';
        this.reason = '';
        const since = this.since && this.since >= Date.now() / 1000 - 86400 ? Math.max(0, this.since - 1) : 0;
        const query = new URLSearchParams({ ...this.filters, since: String(since) }).toString();
        this.render();
        void this.consume(revision, abort, query);
    }
    async consume(revision, abort, query) {
        let reader;
        try {
            const response = await this.api.serviceLogs(this.component, query, abort.signal);
            if (revision !== this.revision || abort.signal.aborted) {
                await response.body?.cancel();
                return;
            }
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            while (true) {
                const chunk = await reader.read();
                if (revision !== this.revision || abort.signal.aborted)
                    return;
                pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
                let end;
                while ((end = pending.indexOf('\n')) >= 0) {
                    if (end > 262144)
                        throw new Error('record limit');
                    const value = pending.slice(0, end);
                    pending = pending.slice(end + 1);
                    if (value)
                        this.event(JSON.parse(value));
                }
                if (pending.length > 262144)
                    throw new Error('record limit');
                this.schedulePaint();
                if (chunk.done) {
                    if (pending.trim())
                        this.event(JSON.parse(pending));
                    break;
                }
            }
            if (['connecting', 'live'].includes(this.state)) {
                this.state = 'ended';
                this.reason = t('Fonte encerrada. Retome para buscar o recorte recente; pode haver lacunas.');
            }
        }
        catch (error) {
            if (revision === this.revision && !abort.signal.aborted) {
                this.state = 'error';
                this.error = logErrorMessage(error);
            }
        }
        finally {
            await reader?.cancel().catch(() => undefined);
            if (revision === this.revision) {
                this.abort = undefined;
                this.schedulePaint();
            }
        }
    }
    event(value) {
        if (value.type === 'connected')
            this.state = 'live';
        else if (value.type === 'line')
            this.append(value.line);
        else if (value.type === 'error') {
            this.state = 'error';
            this.error = logErrorMessage(new ApiError(503, '', value));
        }
        else if (value.type === 'end') {
            this.state = 'ended';
            this.reason = ['time_limit', 'input_limit'].includes(value.reason) ? t('Limite da leitura atingido. Retome para continuar; pode haver lacunas.') : t('Fonte encerrada. Retome para buscar o recorte recente; pode haver lacunas.');
        }
    }
    append(line) {
        if (!line || !/^[a-f0-9]{24}$/.test(line.id) || typeof line.text !== 'string' || line.text.length > 65536 || !['stdout', 'stderr', 'journal'].includes(line.channel))
            throw new Error('invalid log record');
        if (this.ids.has(line.id))
            return;
        const safe = { id: line.id, text: line.text, timestamp: typeof line.timestamp === 'string' ? line.timestamp.slice(0, 40) : undefined, channel: line.channel, level: typeof line.level === 'string' ? line.level.slice(0, 10) : undefined };
        this.ids.add(safe.id);
        this.lines.push(safe);
        this.bytes += safe.text.length * 2 + 256;
        const parsed = Date.parse(safe.timestamp || '');
        if (Number.isFinite(parsed))
            this.since = Math.max(this.since, Math.floor(parsed / 1000));
        const limit = Math.min(2000, Math.max(1, Number(this.filters.tail) || 300));
        while (this.lines.length > limit || this.bytes > 1024 * 1024) {
            const removed = this.lines.shift();
            this.ids.delete(removed.id);
            this.bytes -= removed.text.length * 2 + 256;
            this.dropped++;
        }
    }
    pause() { this.revision++; this.abort?.abort(); this.abort = undefined; this.state = 'paused'; this.paint(); }
    action(action) {
        if (action === 'resources-logs-close') {
            this.reset();
            this.render();
        }
        else if (action === 'resources-logs-toggle') {
            if (this.abort)
                this.pause();
            else
                this.connect(false);
        }
        else if (action === 'resources-logs-follow') {
            this.follow = !this.follow;
            this.paint();
        }
        else if (action === 'resources-logs-clear') {
            this.lines = [];
            this.ids.clear();
            this.bytes = 0;
            this.dropped = 0;
            this.paint();
        }
        else if (action === 'resources-logs-export')
            this.download();
    }
    exportText() { return this.lines.map(formatting).join('\n') + (this.lines.length ? '\n' : ''); }
    download() {
        if (!this.lines.length || typeof document === 'undefined')
            return;
        const url = URL.createObjectURL(new Blob([this.exportText()], { type: 'text/plain;charset=utf-8' }));
        this.urls.add(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = `logs-${this.component.slice(0, 8)}-${Date.now()}.txt`;
        link.click();
        setTimeout(() => { URL.revokeObjectURL(url); this.urls.delete(url); }, 1000);
    }
    schedulePaint() { if (!this.paintTimer)
        this.paintTimer = setTimeout(() => { this.paintTimer = undefined; this.paint(); }, 200); }
    paint() {
        const root = this.root(), output = root?.querySelector('[data-resource-log-output]');
        if (!output || !this.opened)
            return;
        const previous = output.scrollTop;
        output.textContent = this.lines.length ? this.exportText() : t('Nenhuma linha recebida com estes filtros.');
        output.scrollTop = this.follow ? output.scrollHeight : previous;
        const status = root?.querySelector('[data-resource-log-status]');
        if (status)
            status.textContent = `${this.state === 'live' ? t('Ao vivo') : this.state === 'connecting' ? t('Conectando…') : this.state === 'error' ? t('Falha na leitura') : t('Pausado')} · ${this.lines.length} ${t('linhas')} · ${this.dropped} ${t('descartadas pelo limite')}`;
        const error = root?.querySelector('[data-resource-log-error]');
        if (error) {
            error.textContent = this.error || this.reason;
            error.hidden = !error.textContent;
        }
        const toggle = root?.querySelector('[data-action="resources-logs-toggle"]');
        if (toggle)
            toggle.textContent = this.abort ? t('Pausar') : t('Retomar');
        const follow = root?.querySelector('[data-action="resources-logs-follow"]');
        if (follow)
            follow.setAttribute('aria-pressed', String(this.follow));
        const download = root?.querySelector('[data-action="resources-logs-export"]');
        if (download)
            download.disabled = !this.lines.length;
    }
    dialog() {
        if (!this.opened)
            return '';
        const select = (name, values) => `<select name="${name}" data-log-filter>${values.map(([value, label]) => `<option value="${value}"${this.filters[name] === value ? ' selected' : ''}>${e(label)}</option>`).join('')}</select>`;
        const body = `<div class="resource-logs"><form data-form="resource-logs"><div class="resource-logs__filters"><label>${t('Incluir palavras')}<input name="include" data-log-filter maxlength="200" value="${e(this.filters.include)}" placeholder="${t('Qualquer termo, separado por vírgula')}"></label><label>${t('Excluir palavras')}<input name="exclude" data-log-filter maxlength="200" value="${e(this.filters.exclude)}" placeholder="${t('Termos separados por vírgula')}"></label>
      <label>${t('Linhas recentes')}${select('tail', ['100', '300', '1000', '2000'].map(value => [value, value]))}</label><label>${t('Nível mínimo')}${select('level', [['all', t('Todos')], ['trace', 'Trace'], ['debug', 'Debug'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error'], ['fatal', 'Fatal']])}</label><label>${t('Canal')}${select('channel', [['all', t('Todos')], ['stdout', 'stdout'], ['stderr', 'stderr'], ['journal', 'journal']])}</label></div><button type="submit" class="btn btn--small">${t('Aplicar filtros')}</button></form>
      <div class="resource-logs__tools"><button type="button" class="btn btn--small" data-action="resources-logs-toggle">${this.abort ? t('Pausar') : t('Retomar')}</button><button type="button" class="btn btn--small btn--ghost" data-action="resources-logs-follow" aria-pressed="${this.follow}">${t('Rolagem automática')}</button><button type="button" class="btn btn--small btn--ghost" data-action="resources-logs-clear">${t('Limpar tela')}</button><button type="button" class="btn btn--small btn--ghost" data-action="resources-logs-export"${this.lines.length ? '' : ' disabled'}>${t('Exportar exibido (.txt)')}</button></div>
      <p class="storage-caption" data-resource-log-status role="status">${this.state === 'live' ? t('Ao vivo') : this.state === 'connecting' ? t('Conectando…') : this.state === 'error' ? t('Falha na leitura') : t('Pausado')} · ${this.lines.length} ${t('linhas')} · ${this.dropped} ${t('descartadas pelo limite')}</p><p class="storage-warning" data-resource-log-error${this.error || this.reason ? '' : ' hidden'}>${e(this.error || this.reason)}</p><pre class="resource-logs__output" data-resource-log-output tabindex="0" aria-label="${t('Linhas de log')}">${e(this.exportText() || t('Nenhuma linha recebida com estes filtros.'))}</pre><p class="storage-caption">${t('Somente leitura. Recorte limitado; exporta apenas o que está na tela. Credenciais reconhecidas são ocultadas, mas logs ainda podem conter dados pessoais.')}</p></div>`;
        return renderModal('resource-logs', `${t('Logs ao vivo')} · ${this.name}`, body, { wide: true }).replace('data-close-modal', 'data-action="resources-logs-close"');
    }
}
