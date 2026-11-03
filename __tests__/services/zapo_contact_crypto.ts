import { mockDeep } from 'jest-mock-extended'
import type { WaClient, WaStoreSession } from 'zapo-js'
import { ZapoContactCrypto, reserveContactCryptoRecovery } from '../../src/services/zapo/zapo_contact_crypto'
import { getRedis } from '../../src/services/redis'
import { contactCryptoUserId } from '../../src/services/contacts/contact_crypto'

jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))

describe('manual contact encryption recovery', () => {
  const client = mockDeep<WaClient>()
  const contacts = mockDeep<WaStoreSession['contacts']>()
  const reserve = jest.fn()
  const service = new ZapoContactCrypto(client, contacts, '5511999999999', reserve)
  beforeEach(() => {
    jest.clearAllMocks()
    contacts.getByJid.mockResolvedValue({ jid: '123@lid' } as never)
    reserve.mockResolvedValue(true)
    client.message.syncSignalSession.mockResolvedValue(undefined)
  })
  test.each(['123@g.us', 'status@broadcast', '123@s.whatsapp.net', '123:2@lid', '', null, {}, '1'.repeat(33) + '@lid'])('rejects unsafe identity %p', async value => {
    expect(() => contactCryptoUserId(value)).toThrow('400:')
    await expect(service.recover(value)).rejects.toThrow('400:')
    expect(reserve).not.toHaveBeenCalled()
    expect(client.message.syncSignalSession).not.toHaveBeenCalled()
  })
  test('uses the official 1.11.0 options API for this LID only, without identity override or resend', async () => {
    expect(contactCryptoUserId('123@lid')).toBe('123@lid')
    await expect(service.recover('123@lid')).resolves.toEqual({ success: true, user_id: '123@lid', resent: false, cooldown_seconds: 300 })
    expect(reserve).toHaveBeenCalledWith('5511999999999', '123@lid')
    expect(client.message.syncSignalSession).toHaveBeenCalledTimes(1)
    expect(client.message.syncSignalSession).toHaveBeenCalledWith('123@lid', { force: true })
    expect(client.message.send).not.toHaveBeenCalled()
    expect(client.logout).not.toHaveBeenCalled()
  })
  test('rejects unknown contacts before any mutation', async () => {
    contacts.getByJid.mockResolvedValue(null)
    await expect(service.recover('123@lid')).rejects.toThrow('404: contact_not_found')
    expect(reserve).not.toHaveBeenCalled()
  })
  test('rejects overlapping or repeated requests', async () => {
    reserve.mockResolvedValue(false)
    await expect(service.recover('123@lid')).rejects.toThrow('429: contact_crypto_recovery_cooldown')
    expect(client.message.syncSignalSession).not.toHaveBeenCalled()
  })
  test('fails closed if Redis cannot reserve the target', async () => {
    reserve.mockRejectedValue(new Error('redis down'))
    await expect(service.recover('123@lid')).rejects.toThrow('redis down')
    expect(client.message.syncSignalSession).not.toHaveBeenCalled()
  })
  test('reports SDK failure without automatic retry or exposing provider details', async () => {
    client.message.syncSignalSession.mockRejectedValue(new Error('secret detail'))
    await expect(service.recover('123@lid')).rejects.toThrow('502: contact_crypto_recovery_failed')
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(client.message.syncSignalSession).toHaveBeenCalledTimes(1)
  })
  test('reserves atomically in Redis per session/contact for five minutes', async () => {
    const set = jest.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null)
    ;(getRedis as jest.Mock).mockResolvedValue({ set })
    expect(await reserveContactCryptoRecovery('5511999999999', '123@lid')).toBe(true)
    expect(await reserveContactCryptoRecovery('5511999999999', '123@lid')).toBe(false)
    expect(set).toHaveBeenCalledWith('unoapi:contact-crypto:5511999999999:123@lid', '1', { NX: true, EX: 300 })
  })
})
