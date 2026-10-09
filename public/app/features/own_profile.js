import { escapeHtml as esc } from '../core/html.js?v=4.0.35-a50438ad';
import { openProfileMap, profileMapControls } from './profile_map.js?v=4.0.35-a50438ad';
import { renderProfileHours } from './profile_hours.js?v=4.0.35-a50438ad';
import { renderAccountEmail, accountEmailRequest } from './profile_email.js?v=4.0.35-a50438ad';
import { accountEmailError, accountEmailFeedback } from './profile_email_feedback.js?v=4.0.35-a50438ad';
import { renderPrivacy, privacyCommands } from './profile_privacy.js?v=4.0.35-a50438ad';
import { bindPrivacyListModals } from './privacy_list_modal.js?v=4.0.35-a50438ad';
const days = [['sun', 'Domingo'], ['mon', 'Segunda'], ['tue', 'Terça'], ['wed', 'Quarta'], ['thu', 'Quinta'], ['fri', 'Sexta'], ['sat', 'Sábado']];
const time = (v) => v === undefined ? '' : `${Math.floor(v / 60)}`.padStart(2, '0') + ':' + `${v % 60}`.padStart(2, '0');
const field = (name, label, value, extra = '') => `<label class="field"><span class="field-label">${esc(label)}</span><input name="${name}" value="${esc(String(value ?? ''))}" ${extra}></label>`;
const save = '<div class="form-actions"><button class="btn btn--primary" type="submit">Salvar</button></div>';
const form = (id, body) => `<form class="stack" data-form="profile-${id}">${body}${save}</form>`;
export function profileTimezoneSelect(current = 'America/Cuiaba') {
    const brazil = ['America/Cuiaba', 'America/Sao_Paulo', 'America/Campo_Grande', 'America/Manaus', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Eirunepe', 'America/Noronha', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Araguaina', 'America/Maceio', 'America/Bahia', 'America/Santarem'];
    const supportedValuesOf = Intl.supportedValuesOf;
    let available = [];
    try {
        available = supportedValuesOf?.('timeZone') || [];
    }
    catch { }
    const others = [...new Set(['UTC', current, ...available])].filter(zone => !brazil.includes(zone)).sort();
    const options = (zones) => zones.map(zone => `<option value="${esc(zone)}" ${zone === current ? 'selected' : ''}>${esc(zone.replace(/_/g, ' '))}</option>`).join('');
    return `<label class="field"><span class="field-label">Fuso horário</span><select name="timezone" required><optgroup label="Brasil">${options(brazil)}</optgroup><optgroup label="Outros fusos">${options(others)}</optgroup></select></label>`;
}
const camera = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h4l2-3h6l2 3h4v15H3z"/><circle cx="12" cy="13" r="4"/></svg>';
const editImage = (kind, label, url, id = '') => `<div class="profile-image-actions"><button type="button" class="btn profile-image-edit" data-action="profile-edit-${kind}" aria-label="Editar ${label}" aria-controls="profile-menu-${kind}" aria-expanded="false">${camera} Editar</button><div class="profile-image-menu" id="profile-menu-${kind}" hidden>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Mostrar ${label}</a>` : `<button type="button" disabled>Mostrar ${label}</button>`}<button type="button" data-action="profile-upload-${kind}">Carregar ${label}</button><hr><button type="button" data-action="profile-delete-${kind}" data-cover-id="${esc(id)}" ${kind === 'cover' && !id ? 'disabled title="O ID da capa não está disponível"' : ''}>Remover ${label}</button></div></div>`;
function profileImages(p, photoUrl) {
    const coverUrl = p.cover?.url && /^https?:\/\//i.test(p.cover.url) ? p.cover.url : '';
    return `<div class="profile-images ${p.business_account ? '' : 'profile-images--personal'}">
    ${p.business_account ? `<div class="profile-cover">${coverUrl ? `<img class="profile-cover-preview" src="${esc(coverUrl)}" alt="Última capa enviada pela Uno" referrerpolicy="no-referrer">` : '<span class="muted profile-cover-empty">Nenhuma prévia local da capa</span>'}${editImage('cover', 'capa', coverUrl, p.cover?.id)}</div>` : ''}
    <div class="profile-photo">${photoUrl ? `<img class="profile-avatar" src="${esc(photoUrl)}" alt="Foto do perfil" referrerpolicy="no-referrer">` : '<div class="profile-avatar profile-avatar--empty">Sem foto</div>'}${editImage('picture', 'foto', photoUrl)}</div>
  </div>
  <input id="profile-image-picture" type="file" data-profile-image="picture" accept="image/jpeg,image/png,image/webp" aria-label="Carregar foto de perfil" hidden>
  ${p.business_account ? '<input id="profile-image-cover" type="file" data-profile-image="cover" accept="image/jpeg,image/png,image/webp" aria-label="Carregar capa" hidden>' : ''}`;
}
export function renderOwnProfile(p, busy = false, selected = 'general', status = '', mapsAllowed = false, emailStatus, privacyState) {
    const business = p.business || {};
    const locationFields = `<div class="stack" data-location-inputs>${field('address', 'Endereço', business.address, 'maxlength="1024"')}<div class="form-grid">${field('latitude', 'Latitude', business.latitude, 'type="number" step="any" min="-90" max="90"')}${field('longitude', 'Longitude', business.longitude, 'type="number" step="any" min="-180" max="180"')}</div></div>`;
    const tabs = [['general', 'Foto e dados do perfil'], ...(p.business_account && !p.warnings.includes('business') ? [['business', 'Informações da empresa'], ['hours', 'Horário de atendimento']] : []), ...(p.mobile_primary ? [['email', 'E-mail da conta']] : []), ['privacy', 'Privacidade']];
    const active = tabs.some(([id]) => id === selected) ? selected : 'general';
    const panel = (id) => `id="profile-panel-${id}" data-profile-panel="${id}" aria-labelledby="profile-tab-${id}" ${active === id ? '' : 'hidden'}`;
    const photoUrl = p.picture?.url && /^https:\/\//i.test(p.picture.url) ? p.picture.url : '';
    return `<fieldset class="profile-editor stack" ${busy ? 'disabled' : ''}>
    <nav class="tabs" aria-label="Seções do perfil">${tabs.map(([id, label]) => `<button class="tab ${id === active ? 'tab--active' : ''}" type="button" id="profile-tab-${id}" data-action="profile-tab" data-profile-tab="${id}" aria-controls="profile-panel-${id}" aria-expanded="${id === active}">${label}</button>`).join('')}</nav>
    <div ${panel('general')}>
    <section class="section"><div class="section__heading"><div><h3>Perfil do WhatsApp</h3><p class="muted">${p.business_account === true ? 'Conta Business' : p.business_account === false ? 'Conta pessoal' : 'Tipo de conta indisponível'} · Alterações são enviadas à conta desta sessão.</p><p class="muted" data-profile-cache-status role="status">${esc(status)}</p></div><button class="btn" type="button" data-action="profile-reload">Atualizar</button></div>
    ${p.warnings.length ? `<p class="muted" role="status" data-profile-warning>Não foi possível consultar: ${esc(p.warnings.join(', '))}. Dados anteriores, quando disponíveis, foram preservados.</p>` : ''}
    ${profileImages(p, photoUrl)}${form('general', `<div class="form-grid profile-summary"><div class="stack">${field('name', 'Nome de exibição', p.name, 'maxlength="128"')}<small class="field-help">Não altera o nome comercial verificado.</small></div><div class="stack">${field('username', 'Nome de usuário', p.username, `readonly placeholder="${p.warnings.includes('username') ? 'Indisponível nesta consulta' : 'Não informado'}"`)}<small class="field-help">Somente leitura.${p.warnings.includes('username') && p.username ? ' Exibindo o último valor conhecido.' : ''}</small></div></div>${field('about', 'Recado (About)', p.about, 'maxlength="139"')}`)}</section>
    </div>
    ${p.business_account && !p.warnings.includes('business') ? `<section class="section" ${panel('business')}><div class="section__heading"><div><h3>Informações da empresa</h3><p class="muted">Nome comercial verificado: ${esc(p.verified_name || 'não informado')} (somente leitura).</p></div></div>
    ${form('business', `<div class="form-grid">${field('description', 'Descrição', business.description, 'maxlength="1024"')}${field('email', 'E-mail comercial', business.email, 'type="email" maxlength="254"')}${field('site1', 'Site', business.websites?.[0]?.url, 'type="url"')}${field('site2', 'Segundo site', business.websites?.[1]?.url, 'type="url"')}${field('ids', 'IDs das categorias (somente leitura)', (business.categories || []).map((c) => c.id).join(','), 'readonly')}</div>${mapsAllowed ? profileMapControls(locationFields) : locationFields}<p class="field-help">Categorias atuais: ${esc((business.categories || []).map((c) => `${c.name} (${c.id})`).join(', ') || 'Nenhuma categoria informada')}. Por segurança, as categorias são somente leitura neste painel e não são enviadas ao salvar.</p>`)}
    <p class="muted">Área de cobertura e observações de localização não têm edição confirmada na Zapo.</p></section>
    <section class="section" ${panel('hours')}><div class="section__heading"><div><h3>Horário de atendimento</h3><p class="muted">Defina o fuso e os horários de cada dia.</p></div></div>${form('hours', profileTimezoneSelect(business.businessHours?.timezone || 'America/Cuiaba') + renderProfileHours(business.businessHours))}</section>
    ` : ''}
    ${p.mobile_primary ? `<section class="section stack" ${panel('email')}>${renderAccountEmail(emailStatus)}</section>` : ''}
    <section class="section stack" ${panel('privacy')}>${renderPrivacy(privacyState)}</section>
  </fieldset>`;
}
export function businessFormValue(kind, data) {
    const text = (name) => String(data.get(name) || '').trim();
    if (kind === 'categories')
        return { categories: text('ids').split(',').map(id => id.trim()).filter(Boolean).map(id => ({ id })) };
    if (kind === 'hours')
        return { businessHours: { timezone: text('timezone'), config: days.flatMap(([day]) => {
                    const globalMode = text('hours-mode');
                    if (globalMode && !data.has(`${day}-enabled`))
                        return [];
                    const mode = globalMode && globalMode !== 'mixed' ? globalMode : text(`${day}-mode`);
                    if (mode === 'closed')
                        return [];
                    const minute = (key) => { const v = text(key); if (!/^\d{2}:\d{2}$/.test(v))
                        throw new Error('Informe abertura e fechamento.'); const [h, m] = v.split(':').map(Number); return h * 60 + m; };
                    return [{ dayOfWeek: day, mode, ...(mode === 'specific_hours' ? { openTime: minute(`${day}-open`), closeTime: minute(`${day}-close`) } : {}) }];
                }) } };
    const value = { description: text('description'), address: text('address'), email: text('email'), websites: [text('site1'), text('site2')].filter(Boolean).map(url => ({ url })) };
    if (text('latitude') || text('longitude')) {
        if (!text('latitude') || !text('longitude'))
            throw new Error('Informe latitude e longitude juntas.');
        value.latitude = Number(text('latitude'));
        value.longitude = Number(text('longitude'));
    }
    return value;
}
export class OwnProfilePanel {
    constructor(api, render, root) {
        this.api = api;
        this.render = render;
        this.root = root;
        this.selectedTab = 'general';
        this.phone = '';
        this.revision = 0;
        this.busy = false;
        this.error = '';
        this.notice = '';
        this.dirty = false;
        if (root)
            bindPrivacyListModals(root);
    }
    markDirty() { this.dirty = true; }
    mountMap() {
        if (!this.root || !this.phone || this.busy || this.selectedTab !== 'business')
            return;
        if (!this.root.querySelector('[data-profile-map]'))
            return;
        void openProfileMap(this.api, this.root, () => this.markDirty());
    }
    async openMap() {
        if (this.root && this.phone && !this.busy) {
            this.markDirty();
            await openProfileMap(this.api, this.root, () => this.markDirty(), undefined, true);
        }
    }
    selectTab(tab) {
        if (!['general', 'business', 'hours', 'email', 'privacy'].includes(tab))
            return;
        const panels = this.root?.querySelectorAll('[data-profile-panel]');
        if (!panels || !Array.from(panels).some(p => p.dataset.profilePanel === tab))
            return;
        this.selectedTab = tab;
        panels.forEach(p => { p.hidden = p.dataset.profilePanel !== tab; });
        this.root?.querySelectorAll('[data-profile-tab]').forEach(button => {
            const active = button.dataset.profileTab === tab;
            button.classList.toggle('tab--active', active);
            button.setAttribute('aria-expanded', String(active));
        });
        this.mountMap();
        if (tab === 'privacy' && !this.busy)
            void this.submit('privacy-get', new FormData()).catch(() => this.render());
    }
    reset() { if (this.warningTimer)
        clearTimeout(this.warningTimer); this.privacyState = undefined; this.emailStatus = undefined; this.revision++; this.phone = ''; this.profile = undefined; this.busy = false; this.error = ''; this.notice = ''; this.dirty = false; }
    async open(phone, force = false) {
        if (phone !== this.phone)
            this.selectedTab = 'general';
        this.reset();
        this.phone = phone;
        const revision = this.revision;
        this.busy = true;
        this.render();
        try {
            const result = await this.api.request(`/${encodeURIComponent(phone)}/profile${force ? '?refresh=1' : ''}`);
            if (revision === this.revision)
                this.profile = result;
        }
        catch (e) {
            if (revision === this.revision)
                this.error = e.message;
        }
        finally {
            if (revision === this.revision) {
                this.busy = false;
                this.render();
            }
        }
        if (!force && revision === this.revision && this.profile?.cache?.source === 'cache')
            void this.refresh(phone, revision);
    }
    async refresh(phone, revision) {
        let message = '';
        try {
            const result = await this.api.request(`/${encodeURIComponent(phone)}/profile?refresh=1`);
            if (revision !== this.revision)
                return;
            if (!this.dirty) {
                this.profile = result;
                this.render();
                return;
            }
            message = result.cache?.refresh_failed ? 'Não foi possível atualizar. Dados anteriores e suas edições foram preservados.' : 'Consulta concluída em segundo plano. Suas edições foram preservadas; atualize para exibir os novos dados.';
        }
        catch {
            if (revision !== this.revision)
                return;
            message = 'Não foi possível atualizar. Exibindo os dados anteriores.';
        }
        const status = this.root?.querySelector('[data-profile-cache-status]');
        if (status)
            status.textContent = message;
    }
    async mapsSettings(method, apiKey) {
        const result = await this.api.request('/admin/settings/google-maps', { method, ...(method === 'PUT' ? { body: JSON.stringify({ apiKey }) } : {}) });
        const status = this.root?.querySelector('[data-maps-status]');
        if (status)
            status.textContent = result.configured ? 'Chave configurada. O mapa abre em Perfil → Informações da empresa. Após trocar a chave, recarregue a página.' : 'Nenhuma chave configurada.';
        const input = this.root?.querySelector('[name="mapsApiKey"]');
        if (input && method !== 'GET')
            input.value = '';
    }
    html(phone, mapsAllowed = false) {
        if (phone !== this.phone)
            return '<section class="section">Abra a aba Perfil para consultar esta sessão.</section>';
        if (this.warningTimer)
            clearTimeout(this.warningTimer);
        if (this.profile?.warnings.length && this.root)
            this.warningTimer = setTimeout(() => {
                this.root?.querySelector('[data-profile-warning]')?.remove();
            }, 8000);
        const cache = this.profile?.cache;
        const status = cache ? `${cache.source === 'cache' ? 'Perfil em cache' : 'Consulta ao WhatsApp'} · ${new Date(cache.updated_at).toLocaleString()}${cache.refresh_failed ? ' · Atualização falhou; dados anteriores mantidos.' : cache.stale ? ' · Pode conter dados desatualizados.' : ''}` : '';
        return `${this.error ? `<div class="inline-error" role="alert">${esc(this.error)}</div>` : ''}${this.notice ? `<p role="status">${esc(this.notice)}</p>` : ''}${this.profile ? renderOwnProfile(this.profile, this.busy, this.selectedTab, status, mapsAllowed, this.emailStatus, this.privacyState) : `<section class="section">${this.busy ? 'Consultando perfil…' : '<button class="btn" data-action="profile-reload">Tentar novamente</button>'}</section>`}`;
    }
    async submit(kind, data) {
        if (this.busy || !this.phone)
            return;
        const phone = this.phone;
        const revision = ++this.revision;
        let target = kind;
        let value = String(data.get('value') || '');
        let method = 'PUT';
        try {
            if (kind.startsWith('privacy-')) {
                const commands = kind === 'privacy-get' ? [] : privacyCommands(kind, data, this.privacyState);
                if (kind !== 'privacy-get' && !commands.length)
                    return;
                if (kind === 'privacy-status' && !window.confirm('Aplicar este público aos próximos Status? A lista informada substituirá a anterior.'))
                    return;
                if (kind === 'privacy-block' && !window.confirm(`Confirmar ${commands[0].operation === 'block' ? 'bloqueio' : 'desbloqueio'} de ${commands[0].jid}?`))
                    return;
                this.busy = true;
                this.error = '';
                this.notice = '';
                const applied = [];
                try {
                    for (const value of commands) {
                        const result = await this.api.request(`/${encodeURIComponent(phone)}/profile/privacy`, { method: 'PUT', body: JSON.stringify({ value }) });
                        if (revision !== this.revision)
                            return;
                        if (!result.success)
                            throw new Error('Alteração não confirmada.');
                        applied.push(value.setting || value.operation);
                        if (value.operation === 'setting' && this.privacyState?.settings)
                            this.privacyState.settings[value.setting] = value.value;
                    }
                    const result = await this.api.request(`/${encodeURIComponent(phone)}/profile/privacy`);
                    if (revision !== this.revision)
                        return;
                    this.privacyState = result;
                    this.notice = kind === 'privacy-status' ? 'Público do Status enviado e confirmado pelo SDK. A consulta não retorna esse público.' : applied.length ? 'Alterações confirmadas. Situação consultada novamente.' : 'Privacidade consultada no WhatsApp.';
                    this.busy = false;
                    this.render();
                    return;
                }
                catch (error) {
                    throw new Error(`${applied.length ? `Já confirmado: ${applied.join(', ')}. ` : ''}${error.message} Consulte novamente antes de repetir.`);
                }
            }
            if (kind.startsWith('email-')) {
                if (!this.profile?.mobile_primary)
                    throw new Error('Disponível somente no mobile primary.');
                this.busy = true;
                this.error = '';
                this.notice = '';
                accountEmailFeedback(this.root, kind, 'pending');
                const codeInput = this.root?.querySelector('[data-form="profile-email-verify"] input[name="code"]');
                if (codeInput)
                    codeInput.value = '';
                const result = await this.api.request(`/${encodeURIComponent(phone)}/profile/account_email`, accountEmailRequest(kind, data));
                if (revision !== this.revision)
                    return;
                if (kind !== 'email-get' && !result.success)
                    throw new Error('Operação não confirmada pelo WhatsApp.');
                if ('email' in result)
                    this.emailStatus = { email: result.email, verified: !!result.verified, confirmed: !!result.confirmed };
                if (kind === 'email-confirm')
                    this.emailStatus = undefined;
                this.notice = { 'email-get': 'Situação consultada no WhatsApp.', 'email-set': 'E-mail salvo. Solicite o código para verificar.',
                    'email-request_code': 'Código solicitado. Confira sua caixa de entrada.', 'email-verify': 'Código verificado. Confirme a vinculação.',
                    'email-confirm': 'Vinculação confirmada. Consulte para atualizar a situação exibida.' }[kind];
                this.busy = false;
                this.render();
                accountEmailFeedback(this.root, kind, 'success', this.notice);
                return;
            }
            if (kind === 'general') {
                const changes = ['name', 'about'].filter(field => data.has(field) && String(data.get(field) ?? '') !== (this.profile?.[field] ?? ''));
                if (!changes.length)
                    return;
                this.busy = true;
                this.error = '';
                this.notice = '';
                const saved = [];
                for (const field of changes) {
                    const next = String(data.get(field) ?? '');
                    try {
                        const result = await this.api.request(`/${encodeURIComponent(phone)}/profile/${field}`, { method: 'PUT', body: JSON.stringify({ value: next }) });
                        if (revision !== this.revision)
                            return;
                        if (!result.success)
                            throw new Error('O WhatsApp não confirmou a alteração.');
                        if (this.profile)
                            this.profile = { ...this.profile, [field]: next };
                        saved.push(field === 'name' ? 'nome' : 'recado');
                    }
                    catch (error) {
                        throw new Error(`${saved.length ? `Já salvo: ${saved.join(', ')}. ` : ''}Falha ao salvar ${field === 'name' ? 'nome' : 'recado'}: ${error.message}`);
                    }
                }
                await this.open(phone, true);
                if (this.phone === phone) {
                    this.notice = 'Dados do perfil salvos.';
                    this.render();
                }
                return;
            }
            if (['business', 'categories', 'hours'].includes(kind)) {
                target = 'business';
                value = businessFormValue(kind, data);
            }
            if (kind.startsWith('delete-')) {
                method = 'DELETE';
                target = kind.slice(7);
                if (target !== 'cover')
                    value = undefined;
            }
            if (['picture', 'cover'].includes(kind)) {
                const file = data.get('image');
                if (!file?.size || file.size > 5 * 1024 * 1024)
                    throw new Error('Selecione uma imagem de até 5 MiB.');
                this.busy = true;
                value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Falha ao ler imagem.')); reader.readAsDataURL(file); });
            }
            if (revision !== this.revision)
                return;
            this.busy = true;
            this.error = '';
            this.notice = '';
            const result = await this.api.request(`/${encodeURIComponent(phone)}/profile/${target}`, { method, body: JSON.stringify({ value }) });
            if (revision !== this.revision)
                return;
            if (!result.success)
                throw new Error('O WhatsApp não confirmou a alteração.');
            await this.open(phone, true);
            if (this.phone === phone) {
                this.notice = `Alteração confirmada.${result.id ? ` ID: ${result.id}` : ''}${result.warning ? ` Atenção: ${result.warning}. Guarde o ID; a persistência ou limpeza local não foi concluída.` : ''}`;
                this.render();
            }
        }
        catch (e) {
            if (revision === this.revision && kind.startsWith('email-')) {
                const message = accountEmailError(e);
                accountEmailFeedback(this.root, kind, 'error', message);
                this.error = message;
                this.busy = false;
                throw new Error(message);
            }
            if (revision === this.revision) {
                this.error = e.message;
                this.busy = false;
                throw e;
            }
        }
        finally {
            if (revision === this.revision)
                this.busy = false;
        }
    }
}
