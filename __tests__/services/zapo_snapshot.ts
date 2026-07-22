import { mockDeep } from 'jest-mock-extended'
import type { WaStoreSession } from 'zapo-js'
import type { ZapoStoreSnapshot } from 'wa-store-migrate/zapo'
import { writeZapoSnapshot } from '../../src/services/zapo/zapo_snapshot'

describe('Zapo snapshot writer', () => {
  test('writes every migrated domain through the public Zapo store contracts', async () => {
    const store = mockDeep<WaStoreSession>()
    const snapshot = {
      credentials: { meJid: '5566@s.whatsapp.net' },
      preKeys: [{ keyId: 1 }],
      identities: [{ address: { user: '1', device: 0 }, identityKey: new Uint8Array([1]) }],
      sessions: [{ address: { user: '1', device: 0 }, record: { session: true } }],
      senderKeys: [{ record: { senderKey: true } }],
      appState: { keys: [{ keyId: new Uint8Array([1]), keyData: new Uint8Array([2]), timestamp: 1 }], collections: {} },
      privacyTokens: [{ jid: '1@s.whatsapp.net', updatedAtMs: 1 }],
      deviceLists: [{ userJid: '1@s.whatsapp.net', deviceJids: [], updatedAtMs: 1 }],
      contacts: [{ jid: '1@s.whatsapp.net', lastUpdatedMs: 1 }],
      messageSecrets: [{ messageId: 'm1', senderJid: '1@s.whatsapp.net', secret: new Uint8Array([3]) }],
    } as unknown as ZapoStoreSnapshot

    await writeZapoSnapshot(store, snapshot)

    expect(store.auth.save).toHaveBeenCalledWith(snapshot.credentials)
    expect(store.preKey.putPreKey).toHaveBeenCalledWith(snapshot.preKeys?.[0])
    expect(store.identity.setRemoteIdentities).toHaveBeenCalledTimes(1)
    expect(store.session.setSessionsBatch).toHaveBeenCalledTimes(1)
    expect(store.senderKey.upsertSenderKey).toHaveBeenCalledTimes(1)
    expect(store.appState.upsertSyncKeys).toHaveBeenCalledTimes(1)
    expect(store.privacyToken.upsertBatch).toHaveBeenCalledTimes(1)
    expect(store.deviceList.upsertUserDevicesBatch).toHaveBeenCalledTimes(1)
    expect(store.contacts.upsertBatch).toHaveBeenCalledTimes(1)
    expect(store.messageSecret.setBatch).toHaveBeenCalledTimes(1)
  })
})
