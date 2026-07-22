import type { WaStoreSession } from 'zapo-js'
import type { ZapoStoreSnapshot } from 'wa-store-migrate/zapo'

export const writeZapoSnapshot = async (store: WaStoreSession, snapshot: ZapoStoreSnapshot) => {
  await store.auth.save(snapshot.credentials)
  await Promise.all((snapshot.preKeys || []).map((key) => store.preKey.putPreKey(key)))
  if (snapshot.identities?.length) {
    await store.identity.setRemoteIdentities(
      snapshot.identities.map((identity) => ({
        address: identity.address,
        identityKey: identity.identityKey,
      })),
    )
  }
  if (snapshot.sessions?.length) {
    await store.session.setSessionsBatch(
      snapshot.sessions.map((session) => ({
        address: session.address,
        session: session.record as never,
      })),
    )
  }
  for (const senderKey of snapshot.senderKeys || []) {
    await store.senderKey.upsertSenderKey(senderKey.record as never)
  }
  if (snapshot.appState?.keys?.length) await store.appState.upsertSyncKeys(snapshot.appState.keys as never)
  if (snapshot.privacyTokens?.length) await store.privacyToken.upsertBatch(snapshot.privacyTokens)
  if (snapshot.deviceLists?.length) await store.deviceList.upsertUserDevicesBatch(snapshot.deviceLists)
  if (snapshot.contacts?.length) await store.contacts.upsertBatch(snapshot.contacts)
  if (snapshot.messageSecrets?.length) {
    await store.messageSecret.setBatch(
      snapshot.messageSecrets.map((secret) => ({
        messageId: secret.messageId,
        entry: { senderJid: secret.senderJid, secret: secret.secret },
      })),
    )
  }
}
