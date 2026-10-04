jest.mock('../../src/services/zapo/zapo_username_index', () => ({
  zapoUsernameIndex: {
    removeByLid: jest.fn().mockResolvedValue(undefined),
  },
}))

import { ZapoContactBook } from '../../src/services/zapo/zapo_contact_book'
import { zapoUsernameIndex } from '../../src/services/zapo/zapo_username_index'

const contactStore = (records: Record<string, any> = {}) => {
  const values = new Map(Object.entries(records))
  return {
    getByJid: jest.fn(async (jid: string) => values.get(jid) || null),
    getByPhoneNumber: jest.fn(async (phone: string) => {
      const digits = `${phone}`.split('@')[0]
      return [...values.values()].find((record) => `${record.phoneNumber || ''}`.split('@')[0] === digits) || null
    }),
    upsertBatch: jest.fn(async (items: any[]) => {
      for (const item of items) values.set(item.jid, item)
    }),
    upsert: jest.fn(async (item: any) => {
      values.set(item.jid, item)
    }),
    deleteByJid: jest.fn(async (jid: string) => values.delete(jid) ? 1 : 0),
  }
}

describe('ZapoContactBook', () => {
  test.each(['invalid', 'unavailable'])('does not save a new contact when verification is %s', async outcome => {
    const contacts = contactStore()
    const lookup = jest.fn()
    if (outcome === 'unavailable') lookup.mockRejectedValue(new Error('network unavailable'))
    else lookup.mockResolvedValue([{ queriedJid: '5511999999999@s.whatsapp.net', exists: false, invalid: true }])
    const set = jest.fn()
    const service = new ZapoContactBook({ chat: { set }, profile: { getLidsByPhoneNumbers: lookup } } as never, { contacts } as never, 'session')
    await expect(service.save({ phone_number: '5511999999999', full_name: 'Maria' })).rejects.toThrow()
    expect(lookup).toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(contacts.upsert).not.toHaveBeenCalled()
    expect(contacts.upsertBatch).not.toHaveBeenCalled()
  })
  test('uses the exact PN stored for a supplied LID and saves the official Contact mutation', async () => {
    const contacts = contactStore({
      '53515477086263@lid': {
        jid: '53515477086263@lid',
        lid: '53515477086263@lid',
        phoneNumber: '556699069708',
        lastUpdatedMs: Date.now(),
      },
    })
    const set = jest.fn().mockResolvedValue(undefined)
    const profileLookup = jest.fn()
    const client = { chat: { set }, profile: { getLidsByPhoneNumbers: profileLookup } }
    const service = new ZapoContactBook(client as never, { contacts } as never, '5566999554300')

    await expect(service.save({
      phone_number: '5566999069708',
      full_name: 'Fran Fernandes',
      first_name: 'Fran',
      user_id: '53515477086263@lid',
      username: '@fran',
    })).resolves.toEqual({
      success: true,
      contact: {
        phone_number: '5566999069708',
        full_name: 'Fran Fernandes',
        first_name: 'Fran',
        user_id: '53515477086263@lid',
        username: 'fran',
      },
    })

    expect(profileLookup).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith({
      schema: 'Contact',
      id: '556699069708@s.whatsapp.net',
      fullName: 'Fran Fernandes',
      firstName: 'Fran',
      lidJid: '53515477086263@lid',
      pnJid: '556699069708@s.whatsapp.net',
      saveOnPrimaryAddressbook: true,
      username: 'fran',
    })
    expect(contacts.upsert).toHaveBeenCalledWith(expect.objectContaining({
      jid: '53515477086263@lid',
      phoneNumber: '556699069708',
      displayName: 'Fran Fernandes',
    }))
  })

  test('resolves a missing LID through Zapo and derives the first name', async () => {
    const contacts = contactStore()
    const set = jest.fn().mockResolvedValue(undefined)
    const client = {
      chat: { set },
      profile: {
        getLidsByPhoneNumbers: jest.fn().mockResolvedValue([{
          queriedJid: '5511988887777@s.whatsapp.net',
          phoneJid: '5511988887777@s.whatsapp.net',
          lidJid: '123456789@lid',
          exists: true,
        }]),
      },
    }
    const service = new ZapoContactBook(client as never, { contacts } as never, '5566999554300')

    const result = await service.save({
      phone_number: '+55 11 98888-7777',
      full_name: 'Maria Silva',
    })

    expect(result.contact).toEqual({
      phone_number: '5511988887777',
      full_name: 'Maria Silva',
      first_name: 'Maria',
      user_id: '123456789@lid',
    })
    expect(set).toHaveBeenCalledTimes(1)
  })

  test('does not invent a PN when the supplied LID is absent from the Zapo store', async () => {
    const contacts = contactStore()
    const profileLookup = jest.fn().mockResolvedValue([{
      queriedJid: '5566999069708@s.whatsapp.net',
      phoneJid: '5566999069708@s.whatsapp.net',
      lidJid: null,
      exists: false,
      invalid: false,
    }])
    const service = new ZapoContactBook(
      { chat: { set: jest.fn() }, profile: { getLidsByPhoneNumbers: profileLookup } } as never,
      { contacts } as never,
      '5566999554300',
    )

    await expect(service.save({
      phone_number: '5566999069708',
      full_name: 'Fran',
      user_id: '53515477086263@lid',
    })).rejects.toThrow('zapo_contact_phone_not_found')
  })

  test('replaces a stale supplied LID with the canonical network LID and removes only the matching alias', async () => {
    const contacts = contactStore({
      '111@lid': {
        jid: '111@lid',
        lid: '111@lid',
        phoneNumber: '556699554300',
        displayName: 'Nome antigo',
        lastUpdatedMs: 1,
      },
    })
    const set = jest.fn().mockResolvedValue(undefined)
    const persistMapping = jest.fn().mockResolvedValue(undefined)
    const removeMapping = jest.fn().mockResolvedValue(undefined)
    const client = {
      chat: { set },
      profile: {
        getLidsByPhoneNumbers: jest.fn().mockResolvedValue([{
          queriedJid: '5566999554300@s.whatsapp.net',
          phoneJid: '556699554300@s.whatsapp.net',
          lidJid: '222@lid',
          exists: true,
          invalid: false,
        }]),
      },
    }
    const service = new ZapoContactBook(client as never, { contacts } as never, 'session', persistMapping, removeMapping)

    await expect(service.save({
      phone_number: '5566999554300',
      full_name: 'Nome novo',
      user_id: '111@lid',
    })).resolves.toEqual({
      success: true,
      contact: {
        phone_number: '5566999554300',
        full_name: 'Nome novo',
        first_name: 'Nome',
        user_id: '222@lid',
      },
    })
    expect(contacts.deleteByJid).toHaveBeenCalledWith('111@lid')
    expect(zapoUsernameIndex.removeByLid).toHaveBeenCalledWith('session', '111@lid')
    expect(persistMapping).toHaveBeenCalledWith('556699554300@s.whatsapp.net', '222@lid')
    expect(removeMapping).toHaveBeenCalledWith('556699554300@s.whatsapp.net', '111@lid')
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ lidJid: '222@lid' }))
  })

  test('does not remove a supplied LID alias that belongs to another phone', async () => {
    const contacts = contactStore({
      '111@lid': {
        jid: '111@lid',
        lid: '111@lid',
        phoneNumber: '5511988887777',
        lastUpdatedMs: 1,
      },
    })
    const client = {
      chat: { set: jest.fn().mockResolvedValue(undefined) },
      profile: {
        getLidsByPhoneNumbers: jest.fn().mockResolvedValue([{
          queriedJid: '5566999554300@s.whatsapp.net',
          phoneJid: '556699554300@s.whatsapp.net',
          lidJid: '222@lid',
          exists: true,
          invalid: false,
        }]),
      },
    }
    const service = new ZapoContactBook(client as never, { contacts } as never, 'session')

    await service.save({ phone_number: '5566999554300', full_name: 'Maria', user_id: '111@lid' })

    expect(contacts.deleteByJid).not.toHaveBeenCalled()
  })

  test('skips address-book and store writes when phone, LID and name are unchanged', async () => {
    const contacts = contactStore({
      '222@lid': {
        jid: '222@lid',
        lid: '222@lid',
        phoneNumber: '556699554300',
        displayName: 'Maria Silva',
        lastUpdatedMs: Date.now(),
      },
    })
    const set = jest.fn()
    const profileLookup = jest.fn()
    const service = new ZapoContactBook(
      { chat: { set }, profile: { getLidsByPhoneNumbers: profileLookup } } as never,
      { contacts } as never,
      'session',
    )

    await expect(service.save({
      phone_number: '5566999554300',
      full_name: 'Maria Silva',
      user_id: '222@lid',
    })).resolves.toEqual(expect.objectContaining({
      contact: expect.objectContaining({ user_id: '222@lid', phone_number: '5566999554300' }),
    }))
    expect(profileLookup).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(contacts.upsert).not.toHaveBeenCalled()
    expect(contacts.upsertBatch).not.toHaveBeenCalled()
  })

  test('rejects an empty name even when called outside the HTTP controller', async () => {
    const contacts = contactStore()
    const service = new ZapoContactBook(
      { chat: { set: jest.fn() }, profile: { getLidsByPhoneNumbers: jest.fn() } } as never,
      { contacts } as never,
      '5566999554300',
    )
    await expect(service.save({ phone_number: '5511988887777', full_name: '' }))
      .rejects.toThrow('contact_full_name_is_required')
  })
})
