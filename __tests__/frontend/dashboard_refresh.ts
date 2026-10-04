import { renderDashboard } from '../../frontend/pages/dashboard'

const base = { sessions: [], query: '', status: 'all', loading: false, refreshIn: 15, visibleLimit: 30 }
test('one shared refresh control precedes both lists', () => {
  const html = renderDashboard({ ...base, mobileGrid: '<section id="mobile-list">Dispositivos principais</section>' })
  expect(html).toContain('Atualização automática de dispositivos e sessões em')
  expect(html.match(/data-refresh-countdown/g)).toHaveLength(1)
  expect(html.match(/data-action="refresh"/g)).toHaveLength(1)
  expect(html.indexOf('data-action="refresh"')).toBeLessThan(html.indexOf('id="mobile-list"'))
  expect(html.indexOf('id="mobile-list"')).toBeLessThan(html.indexOf('<h2>Sessões</h2>'))
  expect(html).toContain('data-refresh-countdown>15s')
})
test.each([{}, { canCreate: false, mobileGrid: '<div>hidden-mobile-list</div>' }])('session-only dashboards keep accurate refresh wording %j', options => {
  const html = renderDashboard({ ...base, ...options })
  expect(html).toContain('Atualização automática de sessões em')
  expect(html).not.toContain('dispositivos e sessões')
  expect(html).not.toContain('hidden-mobile-list')
})
test('loading shows progress once and disables the shared button', () => {
  const html = renderDashboard({ ...base, loading: true, mobileGrid: '<section>devices</section>' })
  expect(html.match(/Atualizando…/g)).toHaveLength(1)
  expect(html).toContain('data-action="refresh" disabled')
  expect(html).not.toContain('data-refresh-countdown')
})
