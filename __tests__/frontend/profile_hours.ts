import { renderProfileHours } from '../../frontend/features/profile_hours'
import { businessFormValue } from '../../frontend/features/own_profile'

test.each(['open_24h', 'appointment_only', 'specific_hours'])('global mode %s excludes disabled days and only sends times when needed', mode => {
  const data = new FormData()
  data.set('hours-mode', mode); data.set('mon-enabled', 'on'); data.set('mon-open', '09:00'); data.set('mon-close', '18:00'); data.set('timezone', 'America/Cuiaba')
  const result = businessFormValue('hours', data)
  expect(result.businessHours.config).toEqual([{ dayOfWeek: 'mon', mode, ...(mode === 'specific_hours' ? { openTime: 540, closeTime: 1080 } : {}) }])
})

test('renders one global selector and seven switches, and preserves mixed server schedule', () => {
  const html = renderProfileHours({ config: [{ dayOfWeek: 'mon', mode: 'open_24h' }, { dayOfWeek: 'tue', mode: 'appointment_only' }] })
  expect(html.match(/role="switch"/g)).toHaveLength(7)
  expect(html).toContain('value="mixed" selected')
  expect(html).toContain('name="mon-enabled" data-hours-control checked')
  const data = new FormData(); data.set('hours-mode', 'mixed'); data.set('mon-enabled', 'on'); data.set('mon-mode', 'open_24h'); data.set('tue-enabled', 'on'); data.set('tue-mode', 'appointment_only')
  expect(businessFormValue('hours', data).businessHours.config).toEqual([{ dayOfWeek: 'mon', mode: 'open_24h' }, { dayOfWeek: 'tue', mode: 'appointment_only' }])
})
