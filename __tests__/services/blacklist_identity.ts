import { blacklistTargets, normalizeBlacklistIdentity, resolveBlacklistAliases } from '../../src/services/blacklist_identity'

test.each([
  ['50113712017501:2@lid', '50113712017501@lid'],
  ['+5566996269251@s.whatsapp.net', '5566996269251'],
  ['+55 (66) 99626-9251', '5566996269251'],
  ['120363426717231138@g.us', '120363426717231138@g.us'],
  [undefined, ''],
])('normalizes %s without fabricating PN from LID', (input, expected) => {
  expect(normalizeBlacklistIdentity(input)).toBe(expected)
})
const event = (value: object) => ({ entry: [{ changes: [{ value }] }] })
test('extracts contact, message, echo and status identities', () => {
  expect(blacklistTargets(event({ contacts: [{ wa_id: '551234567890', user_id: '123456789' }] })))
    .toEqual(['551234567890', '123456789@lid'])
  expect(blacklistTargets(event({ messages: [{ from_user_id: '123456789@lid' }] }))).toEqual(['123456789@lid'])
  expect(blacklistTargets(event({ statuses: [{ recipient_id: '551234567890', recipient_user_id: '123456789' }] })))
    .toEqual(['551234567890', '123456789@lid'])
  expect(blacklistTargets(event({ smb_message_echoes: [{ to: '551234567890' }] }))).toEqual(['551234567890'])
  expect(blacklistTargets({})).toEqual([])
})
test('group routing never treats the participant as a group alias', () => {
  expect(blacklistTargets(event({ contacts: [{ wa_id: '551234567890', group_id: '123@g.us' }] }))).toEqual(['123@g.us'])
})
test('outgoing echo does not select the session phone over its recipient', () => {
  expect(blacklistTargets(event({ contacts: [{ wa_id: '551234567890' }], messages: [{ from: '559999999999' }] })))
    .toEqual(['551234567890'])
  expect(blacklistTargets(event({ contacts: [{ wa_id: '551234567890', user_id: '123@lid' }],
    messages: [{ from: '559999999999', from_user_id: '999@lid' }] })))
    .toEqual(['551234567890', '123@lid'])
})
test('production-shaped mapping bridges Brazilian presentation and legacy keys in both directions', async () => {
  const stored = { jid: '94047083475061@lid', phoneNumber: '556696269251@s.whatsapp.net' }
  const contacts = {
    getByJid: jest.fn().mockResolvedValue(stored),
    getByPhoneNumber: jest.fn(async (pn: string) => pn === stored.phoneNumber ? stored : null),
  }
  for (const id of ['5566996269251', '94047083475061@lid']) {
    expect(await resolveBlacklistAliases('session', [id], async () => contacts))
      .toEqual(expect.arrayContaining(['5566996269251', '556696269251', '94047083475061@lid']))
  }
  const other = { jid: '999@lid', phoneNumber: '5566996269251' }
  contacts.getByPhoneNumber.mockImplementation(async pn => pn === '5566996269251' ? other : pn === stored.phoneNumber ? stored : null)
  expect(await resolveBlacklistAliases('session', ['94047083475061@lid'], async () => contacts)).not.toContain('5566996269251')
  expect(await resolveBlacklistAliases('session', ['5566996269251'], async () => contacts)).not.toContain('94047083475061@lid')
})
test('resolves only stored relationships within the requested session', async () => {
  const lookup = jest.fn().mockResolvedValue({
    getByJid: jest.fn().mockResolvedValue({ jid: '123@lid', phoneNumber: '551234567890' }),
    getByPhoneNumber: jest.fn().mockResolvedValue({ lid: '123@lid', phoneNumber: '551234567890' }),
  })
  for (const id of ['123@lid', '551234567890']) {
    expect(await resolveBlacklistAliases('session', [id], lookup))
      .toEqual(expect.arrayContaining(['123@lid', '551234567890', '551234567890@s.whatsapp.net']))
  }
  expect(lookup).toHaveBeenCalledWith('session')
  expect(await resolveBlacklistAliases('session', ['123@lid'], async () => undefined)).toEqual(['123@lid'])
  lookup.mockClear()
  expect(await resolveBlacklistAliases('session', ['123@g.us'], lookup)).toEqual(['123@g.us'])
  expect(lookup).not.toHaveBeenCalled()
})
