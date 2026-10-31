import { mock } from 'jest-mock-extended'
import { clients, type Client } from '../../src/services/client'
import { IncomingProvider } from '../../src/services/incoming_baileys'
import type { Listener } from '../../src/services/listener'
import { defaultConfig } from '../../src/services/config'

describe('contact crypto worker provider', () => {
  const getClient = jest.fn()
  const provider = new IncomingProvider(mock<Listener>(), async () => defaultConfig, getClient, async () => undefined)
  afterEach(() => { clients.delete('5511999999999'); jest.clearAllMocks() })
  test('does not open or pair an absent session', async () => {
    await expect(provider.recoverContactCrypto('5511999999999', '123@lid')).rejects.toThrow('409: zapo_client_not_connected')
    expect(getClient).not.toHaveBeenCalled()
  })
  test('requires explicit client capability', async () => {
    clients.set('5511999999999', {} as Client)
    await expect(provider.recoverContactCrypto('5511999999999', '123@lid')).rejects.toThrow('409: contact_crypto_requires_zapo')
  })
  test('delegates only to the existing owning client', async () => {
    const client = mock<Client>()
    client.recoverContactCrypto!.mockResolvedValue({ success: true, user_id: '123@lid', resent: false, cooldown_seconds: 300 })
    clients.set('5511999999999', client)
    await expect(provider.recoverContactCrypto('5511999999999', '123@lid')).resolves.toEqual(expect.objectContaining({ resent: false }))
    expect(client.recoverContactCrypto).toHaveBeenCalledWith('123@lid')
    expect(getClient).not.toHaveBeenCalled()
  })
})
