import { ApiError } from '../core/api.js?v=4.0.32-1ab9d8f1';
import { escapeHtml as e } from '../core/html.js?v=4.0.32-1ab9d8f1';
import { renderModal } from '../components/modal.js?v=4.0.32-1ab9d8f1';
const field = (label, name, value = '', type = 'text', required = true) => `<label class="field"><span>${e(label)}</span><input name="${name}" type="${type}" value="${e(value)}" ${required ? 'required' : ''} ${type === 'password' ? 'autocomplete="new-password"' : ''}></label>`;
const button = (label, action, id = '') => `<button class="btn btn--ghost" type="button" data-action="manager-${action}" data-id="${e(id)}">${e(label)}</button>`;
const submit = (label, busy) => `<button class="btn" ${busy ? 'disabled' : ''}>${e(label)}</button>`;
export async function managerIdentity(api) {
    try {
        const { user } = await api.request('/manager/me');
        if (!user || !['admin', 'user'].includes(user.role))
            throw new Error('Identidade inválida.');
        return user;
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 401 && !api.getToken().startsWith('mgr_'))
            return null;
        throw error;
    }
}
export class ManagerPage {
    constructor(api, render) {
        this.api = api;
        this.render = render;
        this.users = [];
        this.assignments = { assignments: {}, history: [] };
        this.keys = [];
        this.knownPhones = [];
        this.assignmentPhone = '';
        this.selected = '';
        this.tab = 'Dados';
        this.secret = '';
        this.error = '';
        this.notice = '';
        this.passwordChanged = false;
        this.busy = false;
        this.generation = 0;
    }
    async request(path, init) {
        const generation = this.generation;
        const result = await this.api.request(path, init);
        if (generation !== this.generation)
            throw new Error('Página alterada. Resposta descartada.');
        return result;
    }
    reset() {
        this.generation++;
        this.users = [];
        this.assignments = { assignments: {}, history: [] };
        this.keys = [];
        this.knownPhones = [];
        this.assignmentPhone = '';
        this.secret = '';
        this.selected = '';
        this.tab = 'Dados';
        this.pending = undefined;
        this.error = '';
        this.notice = '';
        this.passwordChanged = false;
        this.busy = false;
    }
    async load(admin) {
        await this.run(async () => {
            if (admin) {
                const [users, assignments] = await Promise.all([
                    this.request('/manager/users'),
                    this.request('/manager/assignments'),
                ]);
                this.users = users.users;
                this.assignments = assignments;
            }
            else {
                this.keys = (await this.request('/manager/keys')).keys;
            }
        });
    }
    focusAssignment(phone) {
        this.assignmentPhone = phone;
        this.selected = this.assignments.assignments[phone] || '';
        this.tab = 'Sessões';
        this.render();
    }
    async run(work) {
        if (this.busy)
            return;
        const generation = this.generation;
        this.busy = true;
        this.error = '';
        this.notice = '';
        this.render();
        try {
            await work();
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
    async action(action, id, admin) {
        if (action === 'manager-hide-key') {
            this.secret = '';
            this.render();
            return;
        }
        if (action === 'manager-copy-key' && !admin && this.secret) {
            await this.run(() => navigator.clipboard.writeText(this.secret));
            return;
        }
        if (this.busy)
            return;
        if (action === 'manager-select' && admin) {
            this.selected = id;
            this.tab = this.assignmentPhone ? 'Sessões' : 'Dados';
            this.render();
            return;
        }
        if (action === 'manager-tab' && admin && ['Dados', 'Sessões', 'Histórico'].includes(id)) {
            this.tab = id;
            this.render();
            return;
        }
        if (action === 'manager-cancel') {
            this.pending = undefined;
            this.render();
            return;
        }
        if (action === 'manager-confirm' && admin && this.pending) {
            const pending = this.pending;
            const generation = this.generation;
            await this.run(async () => {
                try {
                    await this.request(`/manager/assignments/${encodeURIComponent(pending.phone)}`, {
                        method: 'PUT', body: JSON.stringify({ user_id: pending.target, expected_owner: pending.owner }),
                    });
                    this.pending = undefined;
                }
                catch (error) {
                    if (error instanceof ApiError && error.status === 409) {
                        this.pending = undefined;
                        const current = error.payload?.current_owner;
                        throw new Error(`A atribuição mudou. Responsável atual: ${current ? this.userLabel(current) : 'Sem responsável'}. Atualize e confirme novamente.`);
                    }
                    throw error;
                }
            });
            if (generation !== this.generation)
                return;
            const error = this.error;
            await this.load(true);
            if (error) {
                this.error = error;
                this.render();
            }
            return;
        }
        if (action === 'manager-revoke' && !admin && window.confirm('Revogar esta chave?')) {
            await this.run(async () => {
                await this.request(`/manager/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
                this.secret = '';
                this.keys = (await this.request('/manager/keys')).keys;
            });
        }
        if (action === 'manager-revoke-all' && admin && window.confirm('Revogar todas as chaves deste usuário?')) {
            await this.run(async () => { await this.request(`/manager/users/${encodeURIComponent(id)}/revoke-keys`, { method: 'POST' }); });
        }
    }
    async form(name, data, admin) {
        if (this.busy)
            return;
        const value = (key) => `${data.get(key) || ''}`;
        if (name === 'manager-assign' && admin) {
            const phone = value('phone').replace(/\D/g, '');
            if (!phone) {
                this.error = 'Informe o telefone com DDI.';
                this.render();
                return;
            }
            this.pending = { phone, owner: this.assignments.assignments[phone] || null, target: value('user_id') || null };
            this.render();
            return;
        }
        await this.run(async () => {
            if ((name === 'manager-create' || name === 'manager-edit') && admin) {
                const create = name === 'manager-create';
                const payload = create
                    ? { username: value('username').trim(), name: value('name').trim(), password: value('password') }
                    : { name: value('name').trim(), active: data.get('active') === 'on', ...(value('password') ? { password: value('password') } : {}) };
                await this.request(`/manager/users${create ? '' : `/${encodeURIComponent(this.selected)}`}`, { method: create ? 'POST' : 'PATCH', body: JSON.stringify(payload) });
                this.users = (await this.request('/manager/users')).users;
                this.notice = 'Usuário salvo.';
            }
            else if (name === 'manager-key' && !admin) {
                this.secret = '';
                const days = value('days') ? Number(value('days')) : undefined;
                if (days !== undefined && (!Number.isInteger(days) || days < 1))
                    throw new Error('Validade deve ser um número inteiro positivo.');
                const result = await this.request('/manager/keys', {
                    method: 'POST', body: JSON.stringify({ name: value('name').trim(), ...(days === undefined ? {} : { days }) }),
                });
                this.secret = result.token;
                this.keys = [...this.keys, result.key];
            }
            else if (name === 'manager-password' && !admin) {
                await this.request('/manager/password', { method: 'POST', body: JSON.stringify({ current_password: value('current_password'), password: value('password') }) });
                this.notice = 'Senha alterada.';
                this.passwordChanged = true;
            }
        });
    }
    userLabel(id) {
        if (!id)
            return 'Sem responsável';
        return this.users.find(user => user.id === id)?.name || id;
    }
    renderPage(admin) {
        return `<header class="page-header"><h1>${admin ? 'Usuários' : 'Minha conta'}</h1></header>
      ${this.error ? `<p class="form-error" role="alert">${e(this.error)}</p>` : ''}
      ${this.notice ? `<p role="status">${e(this.notice)}</p>` : ''}
      ${this.busy ? '<p role="status">Aguarde…</p>' : ''}
      ${admin ? this.renderUsers() : this.renderAccount()}`;
    }
    renderConfirmation() {
        if (!this.pending)
            return '';
        return renderModal('manager-transfer', 'Confirmar atribuição / transferência', `
      <p>Telefone: <strong>${e(this.pending.phone)}</strong></p>
      <p>De: ${e(this.userLabel(this.pending.owner))}</p><p>Para: ${e(this.userLabel(this.pending.target))}</p>
      <p>O responsável anterior perderá o acesso a esta sessão.</p>
      ${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}
      <div class="actions">${button('Cancelar', 'cancel')}<button class="btn" data-action="manager-confirm" ${this.busy ? 'disabled' : ''}>Confirmar</button></div>`);
    }
    renderUsers() {
        const user = this.users.find(user => user.id === this.selected);
        if (!user)
            return `${this.assignmentPhone ? `<p role="status">Telefone ${e(this.assignmentPhone)}: ${e(this.userLabel(this.assignments.assignments[this.assignmentPhone] || null))}. Selecione o usuário de destino em Detalhes para atribuir.</p>` : ''}<section class="section"><h2>Novo usuário</h2><form class="stack" data-form="manager-create">
      ${field('Usuário', 'username')}${field('Nome', 'name')}${field('Senha', 'password', '', 'password')}${submit('Criar usuário', this.busy)}</form></section>
      <section class="section"><h2>Usuários</h2>${this.users.map(user => `<p>${e(user.name)} (${e(user.username)}) — ${user.active ? 'Ativo' : 'Desativado'} — ${user.phones.length} sessões ${button('Detalhes', 'select', user.id)}</p>`).join('') || '<p>Nenhum usuário.</p>'}</section>`;
        return `<section class="section">${button('Voltar', 'select')}<h2>${e(user.name)} (${e(user.username)})</h2>
      <nav class="actions" aria-label="Detalhes do usuário">${['Dados', 'Sessões', 'Histórico'].map(tab => `<button class="btn ${this.tab === tab ? '' : 'btn--ghost'}" type="button" data-action="manager-tab" data-id="${tab}" aria-pressed="${this.tab === tab}">${tab}</button>`).join('')}</nav>
      ${this.tab === 'Dados' ? `<form class="stack" data-form="manager-edit">${field('Nome', 'name', user.name)}${field('Redefinir senha (deixe vazio para manter)', 'password', '', 'password', false)}
      <label><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> Ativo (desmarque para desativar)</label>${submit('Salvar', this.busy)}</form>${button('Revogar todas as chaves', 'revoke-all', user.id)}`
            : this.tab === 'Sessões' ? `<p>${Object.entries(this.assignments.assignments).filter(([, owner]) => owner === user.id).map(([phone]) => e(phone)).join(', ') || 'Nenhuma sessão atribuída.'}</p>
      <p>Informe qualquer telefone com DDI, inclusive desconectado. Escolha o novo responsável ou remova a atribuição.</p>
      <form class="stack" data-form="manager-assign"><label class="field"><span>Sessão existente ou telefone com DDI</span><input name="phone" type="tel" list="manager-known-phones" value="${e(this.assignmentPhone)}" required placeholder="Selecione uma sessão ou digite um telefone"></label>
      <datalist id="manager-known-phones">${this.knownPhones.map(item => `<option value="${e(item.phone)}" label="${e(item.label)} — ${e(this.userLabel(this.assignments.assignments[item.phone] || null))}"></option>`).join('')}</datalist>
      <label class="field"><span>Novo responsável</span><select name="user_id"><option value="">Sem responsável</option>${this.users.filter(item => item.active).map(item => `<option value="${e(item.id)}" ${item.id === user.id ? 'selected' : ''}>${e(item.name)} (${e(item.username)})</option>`).join('')}</select></label>${submit('Revisar atribuição', this.busy)}</form>`
                : `<div class="table-wrap"><table><thead><tr><th>Telefone</th><th>De</th><th>Para</th><th>Data</th><th>Autor</th></tr></thead><tbody>${this.assignments.history.filter(item => item.from === user.id || item.to === user.id).map(item => `<tr><td>${e(item.phone)}</td><td>${e(this.userLabel(item.from))}</td><td>${e(this.userLabel(item.to))}</td><td>${e(item.at)}</td><td>${e(this.userLabel(item.actor))}</td></tr>`).join('') || '<tr><td colspan="5">Nenhuma transferência.</td></tr>'}</tbody></table></div>`}</section>`;
    }
    renderAccount() {
        return `<section class="section"><h2>Chaves de API</h2><p>A chave completa aparece somente após a criação. Copie antes de sair desta página.</p>
      ${this.secret ? `<div role="status"><code>${e(this.secret)}</code>${button('Copiar chave', 'copy-key')}${button('Já copiei / ocultar', 'hide-key')}</div>` : ''}
      <form class="stack" data-form="manager-key">${field('Nome da chave', 'name')}${field('Validade em dias (opcional)', 'days', '', 'number', false)}${submit('Gerar chave', this.busy)}</form>
      <div class="table-wrap"><table><thead><tr><th>Nome / prefixo</th><th>Criada</th><th>Expira</th><th>Último uso</th><th>Ações</th></tr></thead><tbody>${this.keys.map(key => `<tr><td>${e(key.name)} / ${e(key.prefix)}</td><td>${e(key.created_at)}</td><td>${e(key.expires_at || 'Sem expiração')}</td><td>${e(key.last_used_at || 'Nunca')}</td><td>${key.revoked ? 'Revogada' : button('Revogar', 'revoke', key.id)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="section"><h2>Alterar senha</h2><form class="stack" data-form="manager-password">${field('Senha atual', 'current_password', '', 'password')}${field('Nova senha', 'password', '', 'password')}${submit('Alterar senha', this.busy)}</form></section>`;
    }
}
