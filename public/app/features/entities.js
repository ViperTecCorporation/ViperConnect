import { renderAvatar } from '../components/avatar.js?v=4.0.30-038921da';
import { icon } from '../components/icons.js?v=4.0.30-038921da';
import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
export const CONTACT_SEARCH_MIN_LENGTH = 3;
const contactUsername = (contact) => {
    const username = `${contact.username || ''}`.trim().replace(/^@/, '');
    return username ? `@${username}` : '';
};
const contactName = (contact) => contact.display_name || contact.push_name || contactUsername(contact) || contact.phone_number || contact.user_id;
export const filterContacts = (contacts, query) => {
    const needle = query.trim().toLowerCase();
    if (needle.length < CONTACT_SEARCH_MIN_LENGTH)
        return contacts;
    return contacts.filter((contact) => [contactName(contact), contact.phone_number, contact.user_id, contact.username].some((value) => `${value || ''}`.toLowerCase().includes(needle)));
};
export const filterGroups = (groups, query) => {
    const needle = query.trim().toLowerCase();
    if (!needle)
        return groups;
    return groups.filter((group) => [group.subject, group.id, group.jid].some((value) => `${value || ''}`.toLowerCase().includes(needle)));
};
export const renderContactCards = (contacts, sessionPhone = '') => {
    if (!contacts.length)
        return `<div class="empty-state">${t('Nenhum contato sincronizado para esta sessão.')}</div>`;
    return `<div class="entity-grid">${contacts
        .map((contact) => {
        const name = contactName(contact);
        const username = contactUsername(contact);
        const showUsername = username && username.toLowerCase() !== name.toLowerCase();
        return `<article class="entity-card">
      ${renderAvatar(contact.picture, t('Foto de {name}', { name }), 'contact')}
      <div class="entity-card__body">
        <strong>${escapeHtml(name)}</strong>
        ${showUsername ? `<span class="entity-card__username">${escapeHtml(username)}</span>` : ''}
        ${contact.phone_number ? `<span>${escapeHtml(contact.phone_number)}</span>` : ''}
        <small>${escapeHtml(contact.user_id)}</small>
        <div class="entity-card__actions">
          <button class="btn btn--icon btn--ghost" type="button" data-action="test-message" data-phone="${escapeHtml(sessionPhone)}" data-recipient="${escapeHtml(contact.user_id)}" aria-label="${escapeHtml(t('Enviar mensagem para {name}', { name }))}" title="${t('Enviar mensagem')}">${icon('send')}</button>
          ${contact.phone_number ? `<button class="btn btn--icon btn--ghost" type="button" data-action="copy-value" data-value="${escapeHtml(contact.phone_number)}" data-copy-label="${t('Telefone')}" aria-label="${escapeHtml(t('Copiar telefone de {name}', { name }))}" title="${t('Copiar telefone')}">${icon('copy')}</button>` : ''}
        </div>
      </div>
    </article>`;
    })
        .join('')}</div>`;
};
export const renderGroupCards = (groups, sessionPhone = '') => {
    if (!groups.length)
        return `<div class="empty-state">${t('Nenhum grupo sincronizado para esta sessão.')}</div>`;
    return `<div class="entity-grid">${groups
        .map((group) => {
        const id = group.id || group.jid || '';
        const name = group.subject || id || t('Grupo sem nome');
        const count = group.participants_count ?? group.participantsCount ?? group.total_participant_count ?? 0;
        return `<article class="entity-card">
      ${renderAvatar(group.picture, t('Foto do grupo {name}', { name }), 'group')}
      <div class="entity-card__body">
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(t('{count} participantes', { count }))}</span>
        <small>${escapeHtml(id)}</small>
        <div class="entity-card__actions">
          <button class="btn btn--icon btn--ghost" type="button" data-action="test-message" data-phone="${escapeHtml(sessionPhone)}" data-recipient="${escapeHtml(id)}" aria-label="${escapeHtml(t('Enviar mensagem para o grupo {name}', { name }))}" title="${t('Enviar mensagem')}">${icon('send')}</button>
          <button class="btn btn--icon btn--ghost" type="button" data-action="copy-value" data-value="${escapeHtml(id)}" data-copy-label="${t('Identificador do grupo')}" aria-label="${escapeHtml(t('Copiar identificador do grupo {name}', { name }))}" title="${t('Copiar identificador')}">${icon('copy')}</button>
        </div>
      </div>
    </article>`;
    })
        .join('')}</div>`;
};
