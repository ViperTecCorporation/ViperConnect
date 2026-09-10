import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { renderModal } from '../components/modal.js?v=4.0.30-038921da';
import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { formatNumber, t } from '../core/i18n.js?v=4.0.30-038921da';
import { sessionLabel, sessionPhone } from '../domain/session.js?v=4.0.30-038921da';
export const redisTreeFromKeys = (keys) => {
    const tree = { '': [] };
    keys.forEach((key) => {
        const parts = `${key || ''}`.split(':').filter(Boolean);
        let prefix = '';
        parts.forEach((label, index) => {
            const kind = index === parts.length - 1 ? 'key' : 'branch';
            const path = kind === 'key' ? key : `${prefix}${label}:`;
            tree[prefix] || (tree[prefix] = []);
            const existing = tree[prefix].find((node) => node.path === path);
            if (existing?.kind === 'branch') {
                existing.descendantCount = (existing.descendantCount || 0) + 1;
            }
            else if (!existing) {
                tree[prefix].push({
                    label,
                    path,
                    kind,
                    ...(kind === 'branch' ? { descendantCount: 1 } : {}),
                });
            }
            if (kind === 'branch') {
                tree[path] || (tree[path] = []);
                prefix = path;
            }
        });
    });
    Object.values(tree).forEach((nodes) => nodes.sort((left, right) => {
        if (left.kind !== right.kind)
            return left.kind === 'branch' ? -1 : 1;
        return left.label.localeCompare(right.label);
    }));
    return tree;
};
const renderRedisTreeNodes = (tree, prefix, expanded, selectedKey = '', loading = false) => (tree[prefix] || []).map((node) => {
    if (node.kind === 'key') {
        return `<button class="redis-key ${selectedKey === node.path ? 'redis-key--active' : ''}" type="button" data-action="select-redis-key" data-key="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}">${escapeHtml(node.label)}</button>`;
    }
    const open = expanded.has(node.path);
    const children = tree[node.path];
    return `<div class="redis-tree__node">
    <div class="redis-tree__row">
      <button class="redis-tree__toggle" type="button" data-action="toggle-redis-node" data-prefix="${escapeHtml(node.path)}" aria-expanded="${open}">
        <span class="redis-tree__arrow" aria-hidden="true">›</span>${icon('database')}<strong>${escapeHtml(node.label)}</strong><span class="redis-tree__count" title="${t('Total de chaves abaixo deste item')}">${formatNumber(node.descendantCount || 0)}</span>
      </button>
      <button class="btn btn--icon btn--ghost redis-tree__delete" type="button" data-action="delete-redis-prefix" data-prefix="${escapeHtml(node.path)}" aria-label="${escapeHtml(t('Excluir todos os subitens de {prefix}', { prefix: node.path }))}" title="${t('Excluir todos os subitens')}">${icon('trash')}</button>
    </div>
    ${open ? `<div class="redis-tree__children">${children
        ? renderRedisTreeNodes(tree, node.path, expanded, selectedKey, loading)
        : `<span class="redis-tree__loading">${loading ? t('Atualizando…') : t('Expandir para carregar')}</span>`}</div>` : ''}
  </div>`;
}).join('');
const formattedValue = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export const redisValueIsRedacted = (value) => value === '[REDACTED]'
    || (Array.isArray(value) && value.some(redisValueIsRedacted))
    || (!!value && typeof value === 'object' && Object.values(value).some(redisValueIsRedacted));
export const renderRedisEditorModal = (details) => {
    const key = details?.key || 'unoapi:';
    const editableType = details?.type === 'stream' || details?.type === 'none' ? 'string' : details?.type || 'string';
    return renderModal('redis-editor', details ? t('Editar chave Redis') : t('Adicionar chave Redis'), `
    <form class="stack" data-form="redis-save">
      <label class="field"><span>${t('Chave')}</span><input name="key" value="${escapeHtml(key)}" ${details ? 'readonly' : ''} required></label>
      <div class="form-grid">
        <label class="field"><span>${t('Tipo')}</span><select name="type">${['string', 'hash', 'list', 'set', 'zset'].map((type) => `<option value="${type}" ${type === editableType ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
        <label class="field"><span>TTL (${t('segundos')})</span><small class="field-help">${t('-1 mantém a chave sem expiração.')}</small><input name="ttlSeconds" type="number" value="${details?.ttl ?? -1}"></label>
      </div>
      <label class="field"><span>${t('Conteúdo em JSON ou texto')}</span><textarea name="value" rows="12" required>${escapeHtml(details ? formattedValue(details.value) : '')}</textarea></label>
      <label class="field"><span>${t('Digite o nome da chave para confirmar')}</span><input name="confirm" placeholder="${escapeHtml(key)}" required></label>
      <div class="form-actions"><button class="btn" type="submit">${icon('save')}${t('Salvar chave')}</button></div>
    </form>
  `);
};
export const renderRedisDeleteModal = (key, prefix = false) => renderModal('redis-delete', prefix ? t('Excluir subárvore Redis') : t('Excluir chave Redis'), `
    <form class="stack" data-form="${prefix ? 'redis-delete-prefix' : 'redis-delete'}">
      <input type="hidden" name="${prefix ? 'prefix' : 'key'}" value="${escapeHtml(key)}">
      <p>${prefix
    ? t('Esta operação remove todas as chaves e subitens abaixo deste prefixo.')
    : t('Esta operação remove a chave e todo o seu conteúdo.')}</p>
      <label class="field"><span>${prefix ? t('Digite o prefixo completo para confirmar') : t('Digite o nome da chave para confirmar')}</span><input name="confirm" placeholder="${escapeHtml(key)}" required></label>
      <div class="form-actions"><button class="btn btn--danger" type="submit">${icon('trash')}${t('Excluir definitivamente')}</button></div>
    </form>
  `, { subtitle: key });
export const renderRedisPage = (options) => {
    const filtered = options.keys.filter((key) => (!options.sessionFilter || key.includes(options.sessionFilter))
        && key.toLowerCase().includes(options.query.trim().toLowerCase()));
    const searching = !!(options.sessionFilter || options.query.trim());
    const tree = searching ? redisTreeFromKeys(filtered) : options.tree;
    const expanded = new Set(searching
        ? Object.keys(tree).filter(Boolean)
        : options.expandedPrefixes);
    const treeHtml = renderRedisTreeNodes(tree, '', expanded, options.selected?.key, options.loading);
    return `
    <section class="page-header">
      <div><span class="eyebrow">Redis</span><h1>${t('Chaves e conteúdo')}</h1><p class="muted">${t('Exploração segura do cache e estado persistido do ViperConnect')}</p></div>
      <div class="actions"><button class="btn btn--ghost" type="button" data-action="refresh-redis">${icon('refresh')}${t('Atualizar agora')}</button><button class="btn" type="button" data-action="add-redis-key">${icon('plus')}${t('Adicionar chave')}</button></div>
    </section>
    <section class="section">
      <div class="section__heading"><div><h2>${t('Árvore de chaves')}</h2><p class="muted">${options.loading ? t('Atualizando…') : `${t('Atualização automática em')} <span data-refresh-countdown>${options.refreshIn}s</span>`}</p></div></div>
      <div class="filters queue-filters">
        <label class="search-field">${icon('search')}<input data-filter="redis-query" value="${escapeHtml(options.query)}" placeholder="${t('Buscar chave')}" aria-label="${t('Buscar chave')}"></label>
        <label class="field"><span>${t('Filtrar por sessão')}</span><select data-filter="redis-session"><option value="">${t('Todas as sessões')}</option>${options.sessions.map((session) => `<option value="${escapeHtml(sessionPhone(session))}" ${sessionPhone(session) === options.sessionFilter ? 'selected' : ''}>${escapeHtml(sessionLabel(session))} · ${escapeHtml(sessionPhone(session))}</option>`).join('')}</select></label>
      </div>
      ${options.error ? `<p class="form-error">${escapeHtml(options.error)}</p>` : ''}
      <div class="redis-browser">
        <div class="redis-tree">${treeHtml || `<div class="empty-state">${options.loading ? t('Atualizando…') : t('Nenhuma chave encontrada.')}</div>`}</div>
        <div class="redis-detail">${options.selected ? `
          <div class="section__heading"><div><h2>${escapeHtml(options.selected.key)}</h2><p class="muted">${options.selected.type} · TTL ${options.selected.ttl} · ${formatNumber(options.selected.size)} ${t('itens')}</p></div><div class="actions">${redisValueIsRedacted(options.selected.value) ? '' : `<button class="btn btn--ghost" type="button" data-action="edit-redis-key">${icon('edit')}${t('Editar')}</button>`}<button class="btn btn--danger btn--ghost" type="button" data-action="delete-redis-key">${icon('trash')}${t('Excluir')}</button></div></div>
          ${redisValueIsRedacted(options.selected.value) ? `<p class="hint">${t('A edição foi bloqueada porque o conteúdo possui campos sensíveis mascarados.')}</p>` : ''}
          ${options.selected.truncated ? `<p class="hint">${t('Conteúdo limitado aos primeiros itens para proteger o navegador.')}</p>` : ''}
          <pre>${escapeHtml(formattedValue(options.selected.value))}</pre>` : `<div class="empty-state">${t('Selecione uma chave na árvore para visualizar o conteúdo.')}</div>`}</div>
      </div>
    </section>
    <section class="section">
      <div class="section__heading"><div><h2>${t('Consulta Redis')}</h2><p class="muted">${t('Somente comandos de leitura permitidos; comandos administrativos e scripts são bloqueados.')}</p></div></div>
      <form class="redis-query-form" data-form="redis-query">
        <label class="field"><span>${t('Comando')}</span><select name="command">${['TYPE', 'TTL', 'GET', 'HGETALL', 'LRANGE', 'SMEMBERS', 'ZRANGE', 'SCAN'].map((command) => `<option>${command}</option>`).join('')}</select></label>
        <label class="field"><span>${t('Chave ou termo')}</span><input name="argument" placeholder="unoapi:..."></label>
        <button class="btn" type="submit">${icon('search')}${t('Executar consulta')}</button>
      </form>
      ${typeof options.queryResult !== 'undefined' ? `<pre class="redis-query-result">${escapeHtml(formattedValue(options.queryResult))}</pre>` : ''}
    </section>
  `;
};
