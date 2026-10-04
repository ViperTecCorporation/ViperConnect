import { mobileGridSession, renderMobileDeviceGrid } from '../../frontend/features/mobile_device_grid'
import { MobileDevicesPanel, MobileDraft } from '../../frontend/features/mobile_devices'
import { renderDashboard } from '../../frontend/pages/dashboard'

const draft: MobileDraft = { id: 'device-a', phone: '5511000000000', name: 'Laboratório', platform: 'ios', accountType: 'business', state: 'draft', connectionMode: 'mobile_primary', createdAt: '' }
const primary = { id: '5511222222222', label: 'Principal', mobilePrimaryDraftId: draft.id, status: 'online', server: 'mobile_lab' }
const companion = { id: draft.phone, label: 'Companion', status: 'online' }

test('matches by ownership ID and never hides a same-phone companion for a draft', () => {
  expect(mobileGridSession(draft, [companion])).toBeUndefined()
  expect(mobileGridSession(draft, [companion, primary])).toBe(primary)
  const panel = new MobileDevicesPanel({} as any, jest.fn()); panel.enabled = true; panel.devices = [draft]
  expect(panel.listedSessionPhones([companion, primary])).toEqual([primary.id])
  panel.enabled = false; expect(panel.listedSessionPhones([primary])).toEqual([])
})

test('device table has search, independent status and existing manage/send actions', () => {
  const html = renderMobileDeviceGrid([draft], [primary], '', 'all')
  expect(html).toContain('class="session-table"')
  expect(html).toContain('data-filter="mobile-query"')
  expect(html).toContain(`data-action="manage-session" data-phone="${primary.id}"`)
  expect(html).toContain('data-action="test-message"')
  expect(html).toContain('Visão geral do dispositivo')
  expect(html).toContain('Excluir dispositivo')
  expect(html).not.toContain('disabled')
  expect(renderMobileDeviceGrid([draft], [], '', 'all')).toContain('disabled')
  expect(renderMobileDeviceGrid([draft], [primary], 'inexistente', 'all')).toContain('Nenhum dispositivo encontrado')
  expect(renderMobileDeviceGrid([draft], [primary], '', 'offline')).toContain('Nenhum dispositivo encontrado')
  expect(renderMobileDeviceGrid([draft], [primary], '222222', 'online')).toContain('Principal')
  expect(renderMobileDeviceGrid([{ ...draft, state: 'deleting' }], [primary], '', 'all')).toContain('Exclusão em andamento')
  expect(renderMobileDeviceGrid([{ ...draft, name: '<script>bad</script>' }], [], '', 'all')).not.toContain('<script>')
})

test('dashboard keeps both lists but omits primary only from lower list; search cannot bring it back', () => {
  const options = { sessions: [primary, companion], query: '', status: 'all', loading: false, refreshIn: 10, visibleLimit: 20, mobileGrid: '<section>Device list</section>', mobileSessionPhones: [primary.id] }
  const html = renderDashboard(options)
  expect(html).toContain('Device list')
  expect(html).toContain('Companion')
  expect(html).not.toContain('Principal')
  expect(renderDashboard({ ...options, query: 'Principal' })).not.toContain('data-action="manage-session"')
  // Without access to the admin device grid, assigned sessions remain visible.
  expect(renderDashboard({ ...options, canCreate: false })).toContain('Principal')
})
