import { renderSessionPage } from '../../frontend/pages/session'
import { renderConfirmDeregisterModal } from '../../frontend/features/session_modals'
import { renderMobileCompanions } from '../../frontend/features/mobile_companions'

const base: any = { session: { phone: '999123456789', mobilePrimaryDraftId: 'draft', status: 'online' }, tab: 'overview', contacts: [], contactsHasMore: false, contactCount: 0, contactsQuery: '', groups: [], groupsHasMore: false, groupsQuery: '', loadingSection: false, sectionError: '' }
test('mobile has connected devices next to overview and no misleading QR/disconnect wording', () => {
  const html = renderSessionPage(base)
  expect(html.indexOf('data-tab="overview"')).toBeLessThan(html.indexOf('data-tab="devices"'))
  expect(html.indexOf('data-tab="devices"')).toBeLessThan(html.indexOf('data-tab="config"'))
  expect(html).not.toContain('QR Code ou código de pareamento')
  expect(html).not.toContain('Remover vínculo e exigir novo pareamento')
  expect(html).toContain('Visão geral do dispositivo')
  const modal = renderConfirmDeregisterModal(base.session)
  expect(modal).toContain('credenciais do dispositivo principal serão preservadas')
  expect(modal).toContain('webhooks ativos serão removidos')
  expect(modal).not.toContain('exigirá um novo pareamento')
})
test('ordinary sessions keep their pairing flow and no mobile tab', () => {
  const session = { phone: '999123456789', status: 'online' }
  expect(renderSessionPage({ ...base, session })).not.toContain('data-tab="devices"')
  expect(renderSessionPage({ ...base, session })).toContain('QR Code ou código de pareamento')
  expect(renderConfirmDeregisterModal(session)).toContain('exigirá um novo pareamento')
  expect(renderMobileCompanions(session, false)).toBe('')
})
test('F6 unavailable controls never pretend the remote list is empty or request camera', () => {
  const html = renderSessionPage({ ...base, tab: 'devices' })
  expect(html).toContain('ainda não foi consultada')
  expect(html.match(/disabled/g)).toHaveLength(3)
  expect(html).not.toContain('Nenhum dispositivo conectado')
  expect(renderMobileCompanions(base.session, true)).toContain('reservado ao administrador')
})
