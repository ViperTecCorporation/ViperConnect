import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
import { icon } from './icons.js?v=4.0.30-038921da';
export const renderModal = (id, title, content, options = {}) => `
  <div class="modal-backdrop" data-modal-backdrop="${escapeHtml(id)}">
    <section class="modal ${options.wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(id)}-title">
      <header class="modal__header">
        <div>
          ${options.subtitle ? `<span class="eyebrow">${escapeHtml(options.subtitle)}</span>` : ''}
          <h2 id="${escapeHtml(id)}-title">${escapeHtml(title)}</h2>
        </div>
        <button class="btn btn--icon btn--ghost" type="button" data-close-modal aria-label="${t('Fechar')}">${icon('close')}</button>
      </header>
      <div class="modal__body">${content}</div>
    </section>
  </div>
`;
