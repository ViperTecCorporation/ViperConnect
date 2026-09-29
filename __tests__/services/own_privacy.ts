import { ZapoOwnProfile } from '../../src/services/zapo/zapo_own_profile'
import { validateProfileCommand } from '../../src/services/profile_input'
import { privacyValues, privacyExceptions } from '../../src/services/profile_privacy_input'

function fixture() {
  const privacy = { getPrivacySettings: jest.fn().mockResolvedValue({ lastSeen: 'none', online: 'match_last_seen', bad: 'secret', pix: 'error' }),
    getBlocklist: jest.fn().mockResolvedValue({ jids: ['12345@lid'] }), getDisallowedList: jest.fn().mockResolvedValue({ jids: [] }),
    setPrivacySetting: jest.fn(), setDisallowedList: jest.fn(), blockUser: jest.fn(), unblockUser: jest.fn() }
  const client = { privacy, status: { setPrivacy: jest.fn() }, getCredentials: () => ({ meJid: '5511999999999:2@s.whatsapp.net' }), getState: () => ({ connected: true }),
    profile: { getDisappearingMode: jest.fn().mockResolvedValue([{ duration: 0 }]), setDisappearingMode: jest.fn() } }
  return { client, privacy, service: new ZapoOwnProfile(client as any) }
}
test('reads own privacy on linked sessions, preserves zero and omits unknown settings', async () => {
  const { service, client } = fixture()
  expect(await service.execute({ action: 'get', field: 'privacy' })).toMatchObject({ settings: { lastSeen: 'none', online: 'match_last_seen' }, duration: 0, blocked: ['12345@lid'], warnings: [] })
  expect(client.profile.getDisappearingMode).toHaveBeenCalledWith(['5511999999999@s.whatsapp.net'])
  expect(client.privacy.getDisallowedList).toHaveBeenCalledTimes(6)
  expect(client.privacy.setPrivacySetting).not.toHaveBeenCalled()
})
test('partial errors stay unknown, never invent empty lists or disabled timers', async () => {
  const { service, client, privacy } = fixture()
  privacy.getPrivacySettings.mockRejectedValue(new Error('secret'))
  privacy.getBlocklist.mockRejectedValue(new Error('secret'))
  privacy.getDisallowedList.mockRejectedValue(new Error('secret'))
  client.profile.getDisappearingMode.mockRejectedValue(new Error('secret'))
  const result: any = await service.execute({ action: 'get', field: 'privacy' })
  expect(result.settings).toBeNull(); expect(result.blocked).toBeNull(); expect(result.duration).toBeNull()
  expect(result.warnings).toHaveLength(9); expect(result.exceptions.lastSeen).toBeNull()
  expect(JSON.stringify(result)).not.toContain('secret')
})
test.each(Object.entries(privacyValues).flatMap(([setting, values]) => values.map(value => [setting, value])))('sets only %s=%s', async (setting, value) => {
  const { service, privacy } = fixture()
  await expect(service.execute({ action: 'set', field: 'privacy', value: { operation: 'setting', setting, value } })).resolves.toEqual({ success: true })
  expect(privacy.setPrivacySetting).toHaveBeenCalledWith(setting, value)
})
test.each(privacyExceptions)('exception delta uses official signature for %s', async setting => {
  const { service, privacy } = fixture()
  await service.execute({ action: 'set', field: 'privacy', value: { operation: 'exceptions', setting, add: ['12345@lid'], remove: ['5511999999999'] } })
  expect(privacy.setDisallowedList).toHaveBeenCalledWith(setting, { add: ['12345@lid'], remove: ['5511999999999'] })
})
test.each(['block', 'unblock'])('%s preserves LID', async operation => {
  const { service, privacy } = fixture()
  await service.execute({ action: 'set', field: 'privacy', value: { operation, jid: '12345@lid' } })
  expect(privacy[`${operation}User`]).toHaveBeenCalledWith('12345@lid')
})
test.each([0, 86400, 604800, 7776000])('timer %s calls only default timer', async duration => {
  const { service, client } = fixture()
  await service.execute({ action: 'set', field: 'privacy', value: { operation: 'timer', duration } })
  expect(client.profile.setDisappearingMode).toHaveBeenCalledWith(duration)
})
test.each([
  { operation: 'setting', setting: 'online', value: 'contacts' }, { operation: 'setting', setting: '__proto__', value: 'all' },
  { operation: 'toString' }, { operation: 'timer', duration: -1 }, { operation: 'timer', duration: '0' },
  { operation: 'block', jid: '1@g.us' }, { operation: 'block', jid: '12345@lid', extra: true },
  { operation: 'exceptions', setting: 'lastSeen', add: ['12345@lid'], remove: ['12345@lid'] },
  { operation: 'exceptions', setting: 'online', add: ['12345@lid'] }, { operation: 'exceptions', setting: 'lastSeen', add: [] },
])('rejects invalid input %j', value => {
  expect(() => validateProfileCommand({ action: 'set', field: 'privacy', value })).toThrow()
})
test('mutations sanitize provider errors, offline rejects before SDK', async () => {
  const { service, client, privacy } = fixture()
  privacy.blockUser.mockRejectedValue(new Error('private token'))
  await expect(service.execute({ action: 'set', field: 'privacy', value: { operation: 'block', jid: '12345@lid' } })).rejects.toMatchObject({ code: 502 })
  client.getState = () => ({ connected: false })
  await expect(service.execute({ action: 'get', field: 'privacy' })).rejects.toMatchObject({ code: 409 })
  expect(privacy.getPrivacySettings).not.toHaveBeenCalled()
})

test('missing provider capability is explicit and delete is rejected', async () => {
  const { service, client } = fixture()
  ;(client as any).privacy = undefined
  await expect(service.execute({ action: 'get', field: 'privacy' })).rejects.toMatchObject({ code: 501 })
  expect(() => validateProfileCommand({ action: 'delete', field: 'privacy' })).toThrow()
})

test.each(['CONTACTS', 'DENY_LIST', 'ALLOW_LIST'])('status %s uses official enum and full list without social flags', async mode => {
  const { service, client } = fixture()
  const userJids = mode === 'CONTACTS' ? [] : ['5511999999999', '5511999999999@s.whatsapp.net', '12345@lid']
  await service.execute({ action: 'set', field: 'privacy', value: { operation: 'status', mode, userJids } })
  expect(client.status.setPrivacy).toHaveBeenCalledWith({ mode, userJids: mode === 'CONTACTS' ? [] : ['5511999999999@s.whatsapp.net', '12345@lid'] })
})
test.each([
  { mode: 'UNKNOWN', userJids: [] }, { mode: 'ALLOW_LIST', userJids: [] },
  { mode: 'CONTACTS', userJids: ['12345@lid'] }, { mode: 'DENY_LIST', userJids: ['12345@g.us'] },
  { mode: 'DENY_LIST', userJids: Array(101).fill('12345@lid') }, { mode: 'CONTACTS', userJids: [], shareToFB: true },
])('rejects unsafe status input %j', value => {
  expect(() => validateProfileCommand({ action: 'set', field: 'privacy', value: { operation: 'status', ...value } })).toThrow()
})
