import { mockDeep } from 'jest-mock-extended'
import type { WaIncomingMessageEvent, WaStoreSession } from 'zapo-js'
import { persistMobileContactName } from '../../src/services/zapo/zapo_mobile_contact_names'

describe('mobile primary contact names', () => {
  const event = (key = {}, pushName: unknown = ' Maria Silva ') => ({
    key: { remoteJid: '123@lid', fromMe: false, ...key }, pushName,
  }) as WaIncomingMessageEvent

  it('persists the profile name without replacing imported name, phone or username', async () => {
    const contacts = mockDeep<WaStoreSession['contacts']>()
    contacts.getByJid.mockResolvedValue({ jid: '123@lid', displayName: 'Cliente VIP', phoneNumber: '55119999', username: 'cliente' })
    await persistMobileContactName(contacts, event())
    expect(contacts.upsert).toHaveBeenCalledWith({ jid: '123@lid', pushName: 'Maria Silva', lastUpdatedMs: expect.any(Number) })
  })

  it.each([
    [{ remoteJid: '55119999@s.whatsapp.net', remoteJidAlt: '123@lid' }, '123@lid'],
    [{ remoteJid: '123:2@lid' }, '123@lid'],
    [{ remoteJid: '123@g.us', participant: '456@lid', participantAlt: '55118888@s.whatsapp.net' }, '456@lid'],
    [{ remoteJid: '55119999@s.whatsapp.net' }, '55119999@s.whatsapp.net'],
  ])('uses the sender, not the group or recipient: %j', async (key, jid) => {
    const contacts = mockDeep<WaStoreSession['contacts']>()
    await persistMobileContactName(contacts, event(key))
    expect(contacts.upsert).toHaveBeenCalledWith(expect.objectContaining({ jid, pushName: 'Maria Silva' }))
  })

  it('resolves PN through the existing canonical contact without network access', async () => {
    const contacts = mockDeep<WaStoreSession['contacts']>()
    contacts.getByJid.mockResolvedValue({ jid: '456@lid' })
    await persistMobileContactName(contacts, event({ remoteJid: '55119999@s.whatsapp.net' }))
    expect(contacts.upsert).toHaveBeenCalledWith(expect.objectContaining({ jid: '456@lid' }))
  })

  it.each([
    [{ fromMe: true }, 'Maria'], [{ isNewsletter: true }, 'Maria'],
    [{ remoteJid: 'status@broadcast' }, 'Maria'], [{ remoteJid: '123@g.us' }, 'Maria'],
    [{}, '  '], [{}, undefined], [{}, 123],
  ])('ignores unsuitable events %j %s', async (key, name) => {
    const contacts = mockDeep<WaStoreSession['contacts']>()
    const incoming = event(key); incoming.pushName = name as string
    await persistMobileContactName(contacts, incoming)
    expect(contacts.upsert).not.toHaveBeenCalled()
  })

  it('does not rewrite an unchanged name', async () => {
    const contacts = mockDeep<WaStoreSession['contacts']>()
    contacts.getByJid.mockResolvedValue({ jid: '123@lid', pushName: 'Maria Silva' })
    await persistMobileContactName(contacts, event())
    expect(contacts.upsert).not.toHaveBeenCalled()
  })

  it('allows a missing store and propagates storage errors to the guarded caller', async () => {
    await expect(persistMobileContactName(undefined, event())).resolves.toBeUndefined()
    const contacts = mockDeep<WaStoreSession['contacts']>()
    contacts.upsert.mockRejectedValue(new Error('offline'))
    await expect(persistMobileContactName(contacts, event())).rejects.toThrow('offline')
  })
})
