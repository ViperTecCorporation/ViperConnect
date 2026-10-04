import { escapeHtml as esc } from '../core/html.js?v=4.0.34-43ce0548';
const visibility = ['all', 'contacts', 'contact_blacklist', 'none'];
export const privacyFields = [
    ['lastSeen', 'Visto por último', visibility], ['online', 'Online', ['all', 'none', 'match_last_seen']],
    ['profilePicture', 'Foto do perfil', visibility], ['about', 'Recado', visibility],
    ['readReceipts', 'Confirmações de leitura', ['all', 'none']], ['groupAdd', 'Quem pode adicionar em grupos', ['all', 'contacts', 'contact_blacklist']],
    ['callAdd', 'Ligações', ['all', 'known', 'contacts']], ['messages', 'Mensagens', ['all', 'contacts']],
    ['linkedProfiles', 'Perfis vinculados (Central de Contas)', visibility], ['pix', 'Chave Pix', visibility],
    ['defenseMode', 'Modo de defesa', ['off', 'on_standard']],
];
const labels = { all: 'Todos', contacts: 'Meus contatos', contact_blacklist: 'Meus contatos, exceto…', none: 'Ninguém', match_last_seen: 'Mesmo que “visto por último”', known: 'Conhecidos', off: 'Desativado', on_standard: 'Ativado (padrão)' };
const options = (values, current, key = '') => values.filter(v => key !== 'online' || v !== 'none' || current === 'none').map(v => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(key === 'readReceipts' ? (v === 'all' ? 'Ativadas' : 'Desativadas') : key === 'online' && v === 'none' ? 'Ninguém (valor retornado pela Zapo)' : labels[v] || v)}</option>`).join('');
const save = '<div class="form-actions"><button class="btn btn--primary" type="submit">Salvar</button></div>';
export function renderPrivacy(state) {
    const refresh = '<form data-form="profile-privacy-get"><button class="btn" type="submit">Consultar privacidade</button></form>';
    if (!state)
        return `<h3>Privacidade</h3><p class="muted">Consulte as configurações atuais do WhatsApp antes de editar. Nenhuma alteração é automática.</p>${refresh}`;
    const controls = (keys) => privacyFields.filter(([key]) => keys.includes(key)).map(([key, label, values]) => {
        const current = state.settings?.[key];
        const available = current !== undefined && values.includes(current);
        return `<div class="stack"><label class="field"><span class="field-label">${esc(label)}</span><select name="${key}" ${values.includes('contact_blacklist') ? `data-privacy-list data-label="${esc(label)}" data-initial="${esc(current || '')}" data-list="${esc(JSON.stringify(state.exceptions[key] ?? null))}"` : ''} ${available ? '' : 'disabled'}>${available ? options(values, current, key) : '<option>Indisponível nesta conta/consulta</option>'}</select></label>${values.includes('contact_blacklist') ? `<input type="hidden" name="exceptions_${key}"><button class="btn" type="button" data-edit-privacy-list="${key}">Editar exceções</button>` : ''}</div>`;
    }).join('');
    return `<div class="section__heading"><h3>Privacidade</h3>${refresh}</div>
    ${state.cache ? `<p class="muted" role="status">${state.cache.stale ? 'Exibindo dados possivelmente desatualizados do cache. ' : 'Consulta ao WhatsApp. '}Último registro: ${esc(state.cache.updated_at)}</p>` : ''}
    ${state.warnings.length ? '<p class="inline-error" role="alert">Algumas consultas falharam. Os controles afetados ficam indisponíveis; consulte novamente.</p>' : ''}
    <form class="stack" data-form="profile-privacy-settings">
    <h4>Visto por último e online</h4><div class="form-grid">${controls(['lastSeen', 'online'])}</div>
    <h4>Quem pode ver minhas informações</h4><div class="form-grid">${controls(['profilePicture', 'about', 'linkedProfiles', 'pix'])}</div>
    <p class="field-help">Chave Pix: somente visibilidade. Perfis vinculados não são os sites comerciais; a equivalência com “Links” do iPhone ainda não foi confirmada.</p>
    <h4>Grupos e confirmações de leitura</h4><div class="form-grid">${controls(['groupAdd', 'readReceipts'])}</div>
    <p class="field-help">Desativar confirmações também impede ver as confirmações de outras pessoas. Conversas em grupo mantêm confirmações de leitura.</p>
    <details><summary>Ligações, mensagens e proteção — opções da Zapo</summary><div class="form-grid">${controls(['callAdd', 'messages', 'defenseMode'])}</div><p class="field-help">Não equivalem automaticamente a “Silenciar desconhecidos” ou “Proteger IP”. A disponibilidade depende da conta.</p></details>
    <p class="field-help">Apenas campos alterados são enviados. Cada alteração é independente.</p>${save}</form>
    <hr><h4>Contatos bloqueados</h4><p class="muted">${state.blocked === null ? 'Consulta indisponível' : esc(state.blocked.join(', ') || 'Nenhum contato bloqueado')}</p>
    <form class="stack" data-form="profile-privacy-block"><div class="form-grid"><label class="field"><span class="field-label">Número com país e DDD ou ID @lid</span><input name="jid" required></label><label class="field"><span class="field-label">Ação</span><select name="operation"><option value="block">Bloquear</option><option value="unblock">Desbloquear</option></select></label></div><p class="field-help">Bloquear impede mensagens e chamadas desse contato. A ação será confirmada antes do envio.</p>${save}</form>
    <hr><h4>Mensagens temporárias</h4><form class="stack" data-form="profile-privacy-timer"><label class="field"><span class="field-label">Duração padrão</span><select name="duration" required><option value="">${state.duration === null ? 'Não foi possível consultar; selecione explicitamente' : 'Selecione'}</option>${[[0, 'Desativado'], [86400, '24 horas'], [604800, '7 dias'], [7776000, '90 dias']].map(([n, l]) => `<option value="${n}" ${n === state.duration ? 'selected' : ''}>${l}</option>`).join('')}</select></label><p class="field-help">Aplica-se somente a novas conversas individuais. Não altera conversas existentes nem grupos.</p>${save}</form>
    <hr><h4>Público do Status</h4><form class="stack" data-form="profile-privacy-status"><label class="field"><span class="field-label">Quem pode ver meus próximos Status</span><select name="mode" data-privacy-list data-initial="" required><option value="">Selecione um novo público</option><option value="CONTACTS">Meus contatos</option><option value="DENY_LIST">Meus contatos, exceto…</option><option value="ALLOW_LIST">Compartilhar somente com…</option></select></label><input type="hidden" name="userJids"><button class="btn" type="button" data-edit-privacy-list="mode">Editar lista do público</button><p class="field-help">Em “exceto”, informe quem excluir; em “somente com”, quem incluir. Em “Meus contatos”, deixe a lista vazia. Até 100 contatos. A lista informada substitui a anterior.</p><p class="field-help">O público atual não é consultado. Sua escolha será aplicada aos próximos Status, sem alterar os já publicados.</p>${save}</form>`;
}
export function privacyCommands(kind, data, state) {
    const text = (key) => String(data.get(key) ?? '').trim();
    if (kind === 'privacy-status') {
        const mode = text('mode');
        const userJids = text('userJids').split(/[\s,;]+/).filter(Boolean);
        if (!['CONTACTS', 'DENY_LIST', 'ALLOW_LIST'].includes(mode) || (mode === 'CONTACTS' ? userJids.length > 0 : userJids.length === 0))
            throw new Error('Selecione o público e preencha a lista correspondente; Meus contatos exige lista vazia.');
        return [{ operation: 'status', mode, userJids }];
    }
    if (kind === 'privacy-settings')
        return privacyFields.flatMap(([key, , values]) => {
            if (!data.has(key) || state?.settings?.[key] === undefined || !values.includes(text(key)))
                return [];
            if (text(key) === 'contact_blacklist' && text(`exceptions_${key}`)) {
                const delta = JSON.parse(text(`exceptions_${key}`));
                if (delta.add.length || delta.remove.length)
                    return [{ operation: 'exceptions', setting: key, add: delta.add, remove: delta.remove }];
            }
            return text(key) !== state.settings[key] ? [{ operation: 'setting', setting: key, value: text(key) }] : [];
        });
    if (kind === 'privacy-exceptions')
        return [{ operation: 'exceptions', setting: text('setting'), add: text('add').split(/[\s,;]+/).filter(Boolean), remove: text('remove').split(/[\s,;]+/).filter(Boolean) }];
    if (kind === 'privacy-block')
        return [{ operation: text('operation'), jid: text('jid') }];
    if (kind === 'privacy-timer' && text('duration') !== '')
        return [{ operation: 'timer', duration: Number(text('duration')) }];
    throw new Error('Selecione uma configuração válida.');
}
