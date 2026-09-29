import { normalizeZapoContactCards } from '../../src/services/zapo/zapo_contact_cards'

const payload = () => ({ to: 'recipient@lid', type: 'contacts', contacts: [{ name: { formatted_name: 'José' }, phones: [{ phone: '+55 66 99955-4300', wa_id: '5566999554300', type: 'CELL' }] }] })

test('canonicalizes card phone and wa_id without mutating input or recipient', async () => {
  const input = payload(), original = JSON.stringify(input)
  const resolve = jest.fn().mockResolvedValue('556699554300@s.whatsapp.net')
  const result = await normalizeZapoContactCards(input, resolve)
  expect(result.contacts[0].phones[0]).toEqual({ phone: '+556699554300', wa_id: '556699554300', type: 'CELL' })
  expect(result.to).toBe(input.to)
  expect(result.contacts[0].name).toEqual(input.contacts[0].name)
  expect(JSON.stringify(input)).toBe(original)
})
test.each([undefined, '999@lid', '5511988887777@s.whatsapp.net', '5566999554300@s.whatsapp.net'])('preserves original for unavailable, unrelated or unchanged PN %s', async pn => {
  const input = payload()
  expect(await normalizeZapoContactCards(input, async () => pn as string)).toEqual(input)
})
test('lookup error preserves contact and does not block sharing', async () => {
  const input = payload()
  expect(await normalizeZapoContactCards(input, async () => { throw new Error('offline') })).toEqual(input)
})
test('deduplicates lookups across multiple cards and phone entries', async () => {
  const input = payload(); input.contacts.push(input.contacts[0])
  const resolve = jest.fn().mockResolvedValue('556699554300@s.whatsapp.net')
  const result = await normalizeZapoContactCards(input, resolve)
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(result.contacts).toHaveLength(2)
  expect(result.contacts[1].phones[0].wa_id).toBe('556699554300')
})
test.each(['556635411234', '12025551234', 'invalid'])('does not query landlines, foreign or malformed numbers %s', async phone => {
  const input = payload(); input.contacts[0].phones = [{ phone, wa_id: phone, type: 'CELL' }]
  const resolve = jest.fn()
  expect(await normalizeZapoContactCards(input, resolve)).toEqual(input)
  expect(resolve).not.toHaveBeenCalled()
})
test('non-contact payload does not query identities', async () => {
  const input = { type: 'text', text: { body: 'hello' } }, resolve = jest.fn()
  expect(await normalizeZapoContactCards(input, resolve)).toBe(input)
  expect(resolve).not.toHaveBeenCalled()
})
