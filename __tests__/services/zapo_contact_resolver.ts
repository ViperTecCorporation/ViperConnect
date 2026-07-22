import { normalizeZapoPhoneJid, resolveZapoPhoneJid } from '../../src/services/zapo/zapo_contact_resolver'

describe('resolveZapoPhoneJid', () => {
  test('normalizes a persisted BR PN JID to the canonical ninth-digit form', () => {
    expect(normalizeZapoPhoneJid('556699554300@s.whatsapp.net'))
      .toBe('5566999554300@s.whatsapp.net')
  })

  test('ignores non-LID identifiers without querying the contact store', async () => {
    const contacts = { getByJid: jest.fn() }

    await expect(resolveZapoPhoneJid(contacts, '5566999554300@s.whatsapp.net')).resolves.toBeUndefined()
    expect(contacts.getByJid).not.toHaveBeenCalled()
  })

  test('waits for the delayed LID to phone mapping used by device echoes', async () => {
    const contacts = {
      getByJid: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ jid: '11343495192601@lid' })
        .mockResolvedValueOnce({ jid: '11343495192601@lid', phoneNumber: '5566999554300' }),
    }

    await expect(resolveZapoPhoneJid(contacts, '11343495192601@lid', {
      attempts: 3,
      delayMs: 0,
    })).resolves.toBe('5566999554300@s.whatsapp.net')
    expect(contacts.getByJid).toHaveBeenCalledTimes(3)
  })

  test('normalizes a legacy PN returned by the Zapo contact store', async () => {
    const contacts = {
      getByJid: jest.fn().mockResolvedValue({
        jid: '11343495192601@lid',
        phoneNumber: '556699554300@s.whatsapp.net',
      }),
    }

    await expect(resolveZapoPhoneJid(contacts, '11343495192601@lid', {
      attempts: 1,
      delayMs: 0,
    })).resolves.toBe('5566999554300@s.whatsapp.net')
  })

  test('stops after the configured number of attempts when no mapping exists', async () => {
    const contacts = { getByJid: jest.fn().mockResolvedValue(null) }

    await expect(resolveZapoPhoneJid(contacts, '11343495192601@lid', {
      attempts: 2,
      delayMs: 0,
    })).resolves.toBeUndefined()
    expect(contacts.getByJid).toHaveBeenCalledTimes(2)
  })
})
