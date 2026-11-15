import { icon } from '../components/icons.js?v=4.0.42-d963f113';
import { t } from '../core/i18n.js?v=4.0.42-d963f113';
export const renderResourcesPage = (panel) => `
  <div class="resources-page">
    <header class="page-header">
      <div><span class="eyebrow">${t('Operação')}</span><h1>${t('Gerenciador de recursos')}</h1></div>
      <div class="actions"><button class="btn btn--ghost" type="button" data-action="go-dashboard">${icon('arrowLeft')}Dashboard</button></div>
    </header>
    ${panel}
  </div>
`;
