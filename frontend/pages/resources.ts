import { icon } from '../components/icons.js'
import { t } from '../core/i18n.js'

export const renderResourcesPage = (panel: string): string => `
  <div class="resources-page">
    <header class="page-header">
      <div><span class="eyebrow">${t('Operação')}</span><h1>${t('Gerenciador de recursos')}</h1></div>
      <div class="actions"><button class="btn btn--ghost" type="button" data-action="go-dashboard">${icon('arrowLeft')}Dashboard</button></div>
    </header>
    ${panel}
  </div>
`
