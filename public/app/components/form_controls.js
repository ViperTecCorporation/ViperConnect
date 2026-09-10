import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
import { icon } from './icons.js?v=4.0.30-038921da';
export const renderInfoTooltip = (description) => `
  <button class="info-tooltip" type="button" data-action="toggle-tooltip"
    data-tooltip="${escapeHtml(description)}" aria-label="${escapeHtml(description)}"
    aria-expanded="false">${icon('info')}</button>
`;
export const renderSwitchField = (name, label, description, enabled) => `
  <div class="switch-field">
    <label>
      <input name="${escapeHtml(name)}" type="checkbox" ${enabled ? 'checked' : ''}>
      <strong>${escapeHtml(label)}</strong>
    </label>
    ${renderInfoTooltip(description)}
  </div>
`;
export const renderSecretField = (name, label, value) => {
    const inputId = `secret-${name.replace(/[^a-z0-9_-]/gi, '-')}`;
    return `
  <div class="field">
    <label for="${escapeHtml(inputId)}">${escapeHtml(label)}</label>
    <span class="secret-field">
      <input id="${escapeHtml(inputId)}" name="${escapeHtml(name)}" type="password" value="${escapeHtml(value)}" autocomplete="off">
      <button type="button" class="btn btn--icon btn--ghost" data-action="toggle-secret" aria-label="${escapeHtml(t('Exibir {label}', { label }))}" aria-pressed="false">${icon('eye')}</button>
      <button type="button" class="btn btn--icon btn--ghost" data-action="copy-secret" aria-label="${escapeHtml(t('Copiar {label}', { label }))}">${icon('copy')}</button>
    </span>
  </div>
`;
};
