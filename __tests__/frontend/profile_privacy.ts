import { renderPrivacy, privacyCommands, PrivacyState } from '../../frontend/features/profile_privacy'
import { renderOwnProfile, OwnProfilePanel } from '../../frontend/features/own_profile'
import { privacyListDelta } from '../../frontend/features/privacy_list_modal'
const state: PrivacyState = { settings: { lastSeen: 'none', online: 'match_last_seen', readReceipts: 'all' }, blocked: [], duration: 0, exceptions: { lastSeen: [] }, warnings: [] }
const profile: any = { name: '', warnings: [], mobile_primary: true }
test('exception dialogs use normalized deltas and remove the detached exceptions form', () => {
  const delta = privacyListDelta(['12345@lid'], '5511999999999, 5511999999999@s.whatsapp.net')
  expect(delta.add).toEqual(['5511999999999@s.whatsapp.net']); expect(delta.remove).toEqual(['12345@lid'])
  expect(() => privacyListDelta([], '<script>')).toThrow()
  const html = renderPrivacy(state)
  expect(html).toContain('data-privacy-list'); expect(html).not.toContain('data-form="profile-privacy-exceptions"')
  const form = new FormData(); form.set('lastSeen', 'contact_blacklist'); form.set('exceptions_lastSeen', JSON.stringify(delta))
  expect(privacyCommands('privacy-settings', form, state)).toEqual([{ operation: 'exceptions', setting: 'lastSeen', add: delta.add, remove: delta.remove }])
})
test('entering privacy refreshes externally without writing', async () => {
  const panels = [{ dataset: { profilePanel: 'privacy' }, hidden: true }]
  const root = { addEventListener: jest.fn(), querySelectorAll: jest.fn((selector: string) => selector === '[data-profile-panel]' ? panels : []) }
  const api = { request: jest.fn().mockResolvedValue(profile) }
  const panel = new OwnProfilePanel(api as any, jest.fn(), root as any)
  await panel.open('5511999999999')
  api.request.mockResolvedValue(state as any)
  panel.selectTab('privacy')
  await new Promise(resolve => setImmediate(resolve))
  expect(api.request).toHaveBeenLastCalledWith('/5511999999999/profile/privacy')
  expect(api.request).toHaveBeenCalledTimes(2)
  panel.reset()
})
test('privacy follows account email and remains available on linked sessions', () => {
  const html = renderOwnProfile(profile)
  expect(html.indexOf('data-profile-tab="privacy"')).toBeGreaterThan(html.indexOf('data-profile-tab="email"'))
  expect(renderOwnProfile({ ...profile, mobile_primary: false })).toContain('data-profile-tab="privacy"')
})
test('matches official labels, unknown is not empty and output escapes JIDs', () => {
  const html = renderPrivacy(state)
  expect(html).toContain('Visto por último e online'); expect(html).toContain('Ativadas')
  expect(html).not.toContain('Ninguém / desativado')
  expect(renderPrivacy({ ...state, blocked: ['<script>'], warnings: ['blocked'] })).toContain('&lt;script&gt;')
  expect(renderPrivacy()).not.toContain('profile-privacy-settings')
  expect(renderPrivacy({ ...state, settings: null })).toContain('disabled')
})
test('delta submits only changes; exceptions, timer and block remain distinct', () => {
  const data = new FormData(); data.set('lastSeen', 'contacts'); data.set('online', 'match_last_seen'); data.set('pix', 'all')
  expect(privacyCommands('privacy-settings', data, state)).toEqual([{ operation: 'setting', setting: 'lastSeen', value: 'contacts' }])
  data.set('duration', '0'); expect(privacyCommands('privacy-timer', data)).toEqual([{ operation: 'timer', duration: 0 }])
  data.set('setting', 'lastSeen'); data.set('add', '12345@lid, 5511999999999')
  expect(privacyCommands('privacy-exceptions', data)[0].add).toEqual(['12345@lid', '5511999999999'])
  data.set('jid', '12345@lid'); data.set('operation', 'unblock'); expect(privacyCommands('privacy-block', data)[0].operation).toBe('unblock')
  expect(() => privacyCommands('invalid', data)).toThrow()
})
test('no automatic write; partial saves identify completed settings and stop', async () => {
  const api = { request: jest.fn().mockResolvedValue(profile) }; const panel = new OwnProfilePanel(api as any, jest.fn())
  await panel.open('5511999999999')
  expect(api.request).toHaveBeenCalledTimes(1)
  api.request.mockResolvedValueOnce(state)
  await panel.submit('privacy-get', new FormData())
  api.request.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('offline'))
  const data = new FormData(); data.set('lastSeen', 'contacts'); data.set('online', 'all')
  await expect(panel.submit('privacy-settings', data)).rejects.toThrow('Já confirmado: lastSeen')
  expect(api.request).toHaveBeenCalledTimes(4)
  panel.reset()
})

test('cancelled block confirmation sends nothing', async () => {
  const previous = (globalThis as any).window
  ;(globalThis as any).window = { confirm: jest.fn().mockReturnValue(false) }
  try {
    const api = { request: jest.fn().mockResolvedValue(profile) }; const panel = new OwnProfilePanel(api as any, jest.fn())
    await panel.open('5511999999999')
    const data = new FormData(); data.set('operation', 'block'); data.set('jid', '12345@lid')
    await panel.submit('privacy-block', data)
    expect(api.request).toHaveBeenCalledTimes(1)
    panel.reset()
  } finally { (globalThis as any).window = previous }
})

test('status audience has explicit selection and no unsupported feature notice', () => {
  const html = renderPrivacy(state)
  expect(html).toContain('profile-privacy-status')
  expect(html).toContain('Selecione um novo público')
  expect(html).not.toContain('Recursos do aplicativo não disponíveis')
  const data = new FormData()
  expect(() => privacyCommands('privacy-status', data)).toThrow()
  data.set('mode', 'CONTACTS')
  expect(privacyCommands('privacy-status', data)).toEqual([{ operation: 'status', mode: 'CONTACTS', userJids: [] }])
  data.set('mode', 'ALLOW_LIST'); data.set('userJids', '12345@lid, 5511999999999')
  expect(privacyCommands('privacy-status', data)[0].userJids).toEqual(['12345@lid', '5511999999999'])
})
