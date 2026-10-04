import { accountEmailRequest, renderAccountEmail } from '../../frontend/features/profile_email'
import { renderOwnProfile, OwnProfilePanel } from '../../frontend/features/own_profile'

const p: any = { name: '', about: '', picture: null, business_account: false, warnings: [], mobile_primary: true }
test('email tab is mobile-primary only and independent of Business', () => {
  expect(renderOwnProfile(p)).toContain('data-profile-tab="email"')
  expect(renderOwnProfile({ ...p, mobile_primary: false })).not.toContain('profile-email-set')
  expect(renderAccountEmail({ email: '<private>', verified: true, confirmed: false })).toContain('&lt;private&gt;')
})
test('builds read and explicit mutations without unrelated fields', () => {
  const data = new FormData(); data.set('email', ' me@example.com '); data.set('code', '123456')
  expect(accountEmailRequest('email-get', data)).toEqual({ method: 'GET' })
  expect(JSON.parse(accountEmailRequest('email-set', data).body!)).toEqual({ value: { operation: 'set', email: 'me@example.com' } })
  expect(JSON.parse(accountEmailRequest('email-verify', data).body!)).toEqual({ value: { operation: 'verify', code: '123456' } })
  expect(() => accountEmailRequest('email-delete', data)).toThrow()
})
test('panel queries email only explicitly and does not auto-send verification', async () => {
  const api = { request: jest.fn().mockResolvedValue(p) }; const panel = new OwnProfilePanel(api as any, jest.fn())
  await panel.open('5511000000000'); expect(api.request).toHaveBeenCalledTimes(1)
  api.request.mockResolvedValue({ success: true, email: 'me@example.com', verified: false, confirmed: false } as any)
  const data = new FormData(); data.set('email', 'me@example.com')
  await panel.submit('email-set', data)
  expect(api.request).toHaveBeenCalledTimes(2)
  expect(api.request).toHaveBeenLastCalledWith('/5511000000000/profile/account_email', { method: 'PUT', body: '{"value":{"operation":"set","email":"me@example.com"}}' })
  panel.reset()
})
