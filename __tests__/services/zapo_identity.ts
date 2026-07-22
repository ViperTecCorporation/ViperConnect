import { mockDeep } from 'jest-mock-extended'
import type { WaClient, WaStoreSession } from 'zapo-js'
import { ZapoIdentity } from '../../src/services/zapo/zapo_identity'
import type { ZapoUsernameIndex } from '../../src/services/zapo/zapo_username_index'

describe('Zapo canonical identity resolver', () => {
  test('uses the official PN to LID lookup and persists the learned alias in the Zapo store', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    client.profile.getLidsByPhoneNumbers.mockResolvedValue([
      { exists: true, phoneJid: '5511999999999@s.whatsapp.net', lidJid: '987@lid' },
    ] as never)
    const usernames = { resolve: jest.fn() } as unknown as ZapoUsernameIndex
    const identity = new ZapoIdentity(client, store, 'session', usernames)

    await expect(identity.resolve('5511999999999')).resolves.toBe('987@lid')
    expect(store.contacts.upsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ jid: '987@lid', phoneNumber: '5511999999999' }),
    ])
  })

  test('resolves a learned username to LID without fabricating a phone JID', async () => {
    const usernames = { resolve: jest.fn().mockResolvedValue('555@lid') } as unknown as ZapoUsernameIndex
    const identity = new ZapoIdentity(mockDeep<WaClient>(), mockDeep<WaStoreSession>(), 'session', usernames)

    await expect(identity.resolve('@maria')).resolves.toBe('555@lid')
    expect(usernames.resolve).toHaveBeenCalledWith('session', '@maria')
  })

  test('rejects an unknown username explicitly', async () => {
    const usernames = { resolve: jest.fn().mockResolvedValue(undefined) } as unknown as ZapoUsernameIndex
    const identity = new ZapoIdentity(mockDeep<WaClient>(), mockDeep<WaStoreSession>(), 'session', usernames)

    await expect(identity.resolve('desconhecido')).rejects.toThrow('zapo_username_lid_not_cached')
  })
})
