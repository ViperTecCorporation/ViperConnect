import { randomUUID } from 'node:crypto'
import { publishOwnedSqliteConnectionState, OWNED_SQLITE_CONNECTION_STATE_LUA } from '../../src/services/session_storage/connection_state'
import { sessionLifecycleIdentity } from '../../src/services/session_storage/lifecycle_transition'

const phone = '999123456789', storage = { backend: 'sqlite' as const, storageId: randomUUID(), generation: 2, owner: 'server_1', state: 'offline' as const }
test('connection status updates carry the socket lease and immutable generation, never a new database generation', async () => {
  const redis = { get: jest.fn(), eval: jest.fn(async () => 1) }, ownership = { key: `unoapi-lease:zapo-session:${phone}`, token: randomUUID() }
  expect(await publishOwnedSqliteConnectionState(redis, phone, storage, ownership, 'online')).toBe(true)
  expect(redis.eval).toHaveBeenCalledWith(OWNED_SQLITE_CONNECTION_STATE_LUA, { keys: [`unoapi-config:${phone}`, `unoapi-status:${phone}`, ownership.key], arguments: [ownership.token, storage.owner, storage.storageId, '2', 'online', phone] })
  redis.eval.mockResolvedValueOnce(0); expect(await publishOwnedSqliteConnectionState(redis, phone, storage, ownership, 'offline')).toBe(false)
  // Operational state must not flush the live metadata resolver/config cache.
  expect(OWNED_SQLITE_CONNECTION_STATE_LUA).not.toContain('unoapi-config:update')
  await expect(publishOwnedSqliteConnectionState(redis, phone, storage, { ...ownership, key: 'another-session' }, 'online')).rejects.toThrow('connection_state_invalid')
})

test('active/offline connection changes do not invalidate a running lifecycle identity, but cutovers do', () => {
  const config: any = { provider: 'zapo', server: 'server_1', sessionStorage: storage }
  expect(sessionLifecycleIdentity(config)).toBe(sessionLifecycleIdentity({ ...config, sessionStorage: { ...storage, state: 'active' } }))
  for (const patch of [{ generation: 3 }, { storageId: randomUUID() }, { state: 'restoring' }, { owner: 'server_2' }]) {
    expect(sessionLifecycleIdentity(config)).not.toBe(sessionLifecycleIdentity({ ...config, sessionStorage: { ...storage, ...patch } }))
  }
})
