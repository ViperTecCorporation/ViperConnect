import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mockDeep } from 'jest-mock-extended'
import { createStore, proto, type WaStoreSession } from 'zapo-js'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { closeAllSessionDatabases, getSessionSqlitePath, openSessionDatabase } from '../../src/services/session_storage/database'
import { unlinkSqlitePrimary } from '../../src/services/session_storage/primary_unlink'
import { ZapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'
import { sqliteSdkConnection } from '../../src/services/session_storage/native_migration'

jest.mock('../../src/services/session_storage/change_events', () => ({ publishSqliteMessageChange: jest.fn() }))
const phone = '999123456789', draft = randomUUID(), token = randomUUID(), fence = { key: `unoapi-lease:zapo-session:${phone}`, token }
let directory: string, config: any, previous: NodeJS.ProcessEnv
beforeEach(() => {
  previous = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'synthetic_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID
  directory = mkdtempSync(join(tmpdir(), 'viper-primary-unlink-'))
  config = { provider: 'zapo', baseStore: directory, useRedis: true, autoConnect: false, mobilePrimaryDraftId: draft, mobilePrimaryDeleting: true,
    sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'synthetic_owner', generation: 1, state: 'offline', fixture: true } }
  openSessionDatabase(phone, config, { create: true })
})
afterEach(() => { closeAllSessionDatabases(); process.env = previous; rmSync(directory, { recursive: true, force: true }); jest.restoreAllMocks() })
const setup = () => {
  const session = mockDeep<WaStoreSession>()
  const deps = { readLease: jest.fn(async () => token), hasClient: jest.fn(() => false), session: jest.fn(() => session), release: jest.fn(async () => {}) }
  return { session, deps }
}

test('worker-native SQLite cleanup deletes auth but keeps historical native messages, public IDs and the file', async () => {
  const backend = createSqliteStore({ connection: sqliteSdkConnection(openSessionDatabase(phone, config)) })
  const registry = new ZapoStoreRegistry(() => createStore({ backends: { sqlite: backend },
    providers: { auth: 'sqlite', signal: 'sqlite', preKey: 'sqlite', session: 'sqlite', identity: 'sqlite', senderKey: 'sqlite', appState: 'sqlite', privacyToken: 'sqlite', messages: 'sqlite', threads: 'sqlite', contacts: 'sqlite' },
    cacheProviders: { retry: 'sqlite', groupMetadata: 'sqlite', chatMetadata: 'sqlite', deviceList: 'sqlite', messageSecret: 'sqlite' } })),
    session = registry.get(config, phone).session(phone), bytes = Buffer.alloc(32, 7)
  try {
    await session.auth.save({ noiseKeyPair: { pubKey: bytes, privKey: bytes }, registrationInfo: { registrationId: 1, identityKeyPair: { pubKey: bytes, privKey: bytes } }, signedPreKey: { keyId: 1, keyPair: { pubKey: bytes, privKey: bytes }, signature: bytes, uploaded: false }, advSecretKey: bytes, meJid: `${phone}@s.whatsapp.net` })
    await session.messages.upsert({ id: 'provider', threadJid: '123@lid', fromMe: true, timestampMs: Date.now(), messageBytes: proto.Message.encode({ conversation: 'synthetic' }).finish() })
    const db = openSessionDatabase(phone, config); db.putValue(`unoapi-id:${phone}:provider`, 'uno'); db.putValue(`unoapi-id_rev:${phone}:uno`, 'provider')
    expect(await session.auth.load()).not.toBeNull()
    const result = await unlinkSqlitePrimary(phone, config, draft, fence, { readLease: async () => token, hasClient: () => false, session: () => session, release: value => registry.release(value) })
    expect(result).toEqual({ cleared: true, historyPreserved: true, storagePreserved: true })
    expect(db.get('SELECT COUNT(*) AS n FROM auth_credentials WHERE session_id=?', [phone])?.n).toBe(0)
    expect(db.get('SELECT COUNT(*) AS n FROM mailbox_messages WHERE session_id=?', [phone])?.n).toBe(1)
    expect(db.getValue(`unoapi-id:${phone}:provider`)?.toString()).toBe('uno')
    expect(db.getValue(`unoapi-id_rev:${phone}:uno`)?.toString()).toBe('provider')
    expect(existsSync(getSessionSqlitePath(phone, config))).toBe(true)
  } finally { await registry.destroy() }
})

test.each(['connected', 'wrong-draft', 'not-deleting', 'autoconnect', 'transition', 'redis'])('rejects unsafe cleanup (%s) before touching native auth', async reason => {
  const { deps, session } = setup()
  if (reason === 'connected') deps.hasClient.mockReturnValue(true)
  if (reason === 'not-deleting') config.mobilePrimaryDeleting = false
  if (reason === 'autoconnect') config.autoConnect = true
  if (reason === 'transition') config.sessionStorage.state = 'restoring'
  if (reason === 'redis') config.sessionStorage.backend = 'redis'
  await expect(unlinkSqlitePrimary(phone, config, reason === 'wrong-draft' ? 'foreign' : draft, fence, deps)).rejects.toThrow('requires_suspension')
  expect(session.auth.clear).not.toHaveBeenCalled()
})

test('owner and lease fencing reject remote/nonowner callers and token changes; cleanup failure stays explicit', async () => {
  const { deps, session } = setup()
  config.sessionStorage.owner = 'other'
  await expect(unlinkSqlitePrimary(phone, config, draft, fence, deps)).rejects.toThrow('wrong_owner')
  config.sessionStorage.owner = 'synthetic_owner'
  deps.readLease.mockResolvedValueOnce('foreign')
  await expect(unlinkSqlitePrimary(phone, config, draft, fence, deps)).rejects.toThrow('lease_lost')
  deps.readLease.mockResolvedValueOnce(token).mockResolvedValueOnce('foreign')
  await expect(unlinkSqlitePrimary(phone, config, draft, fence, deps)).rejects.toThrow('lease_lost')
  expect(deps.release).toHaveBeenCalledTimes(1)
  session.auth.clear.mockRejectedValueOnce(new Error('synthetic auth error'))
  await expect(unlinkSqlitePrimary(phone, config, draft, fence, deps)).rejects.toThrow('zapo_session_clear_failed: auth')
})
