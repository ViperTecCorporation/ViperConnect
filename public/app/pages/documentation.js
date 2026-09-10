import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { getLocale, t } from '../core/i18n.js?v=4.0.30-038921da';
export const DOCUMENTATION_URL = 'https://viperconnect.vipertec.net/';
export const DOCUMENTATION_ORIGIN = new URL(DOCUMENTATION_URL).origin;
export const localizedDocumentationUrl = () => getLocale() === 'en' ? new URL('/en/', DOCUMENTATION_URL).toString() : DOCUMENTATION_URL;
export const renderDocumentationPage = () => {
    const documentationUrl = localizedDocumentationUrl();
    return `
  <section class="documentation-embed" aria-label="${escapeHtml(t('Documentação'))}">
    <iframe
      class="documentation-embed__frame"
      src="${documentationUrl}"
      title="${escapeHtml(t('Documentação'))}"
      loading="eager"
      referrerpolicy="strict-origin-when-cross-origin"
    >
      <a href="${documentationUrl}" target="_blank" rel="noopener">${escapeHtml(t('Documentação'))}</a>
    </iframe>
  </section>
`;
};
