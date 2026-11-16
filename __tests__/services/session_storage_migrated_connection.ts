import { randomUUID } from 'node:crypto'
import { migrationResumeIntent, reconnectMigratedSession, RESTORE_MIGRATION_INTENT_LUA } from '../../src/services/session_storage/migrated_connection'

const phone = '999123456789'
function fixture() {
  const storage = { backend: 'sqlite' as const, storageId: randomUUID(), owner: 'worker_1', generation: 2, state: 'offline' as const }
  const config: any = { provider: 'zapo', server: 'worker_1', autoConnect: false, sessionStorage: storage }
  const values = new Map<string, string>([[`unoapi-config:${phone}`, JSON.stringify(config)]])
  const events: string[] = []
  const redis = { get: jest.fn(async (key: string) => values.get(key) || null), eval: jest.fn(async (script: string, input: any) => {
    expect(script).toBe(RESTORE_MIGRATION_INTENT_LUA)
    const [key, lease] = input.keys, [owner, id, generation] = input.arguments, c = JSON.parse(values.get(key) || 'null'), s = c?.sessionStorage
    if (values.has(lease) || !c || c.provider !== 'zapo' || c.server !== owner || c.autoConnect !== false || c.sessionStorageTaskId || c.sessionStorageUnlinked || c.mobilePrimaryDeleting || !s
      || s.backend !== 'sqlite' || s.state !== 'offline' || s.fixture || s.owner !== owner || s.storageId !== id || s.generation !== Number(generation)) return 0
    c.autoConnect = true; values.set(key, JSON.stringify(c)); events.push('intent_restored'); return 1
  }) }
  const dispatch = jest.fn(async () => { events.push('dispatch') }), effectsAllowed = jest.fn(), hasClient = jest.fn(() => false)
  return { storage, config, values, events, redis, deps: { redis, dispatch, effectsAllowed, hasClient } }
}

test.each([
  ['online', true, true, true], ['connecting', true, true, true], ['offline', true, true, false], ['online', false, true, false], ['online', true, false, false], ['disconnected', true, true, false],
])('prior status=%s autoConnect=%s client=%s is eligible=%s', (status, autoConnect, hasClient, eligible) => {
  expect(migrationResumeIntent({ autoConnect, sessionStorage: undefined }, status as string, hasClient as boolean)).toEqual({ eligible, fixture: false })
})

test('restores intent only on the committed generation after release and requests the normal pipeline without claiming online', async () => {
  const f = fixture()
  const result = await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, f.deps)
  expect(result).toEqual({ autoConnect: true, reconnect: { status: 'requested' } })
  expect(f.events).toEqual(['intent_restored', 'dispatch']); expect(f.deps.dispatch).toHaveBeenCalledWith(phone)
  expect(JSON.parse(f.values.get(`unoapi-config:${phone}`)!)).toEqual({ ...f.config, autoConnect: true })
  expect(f.values.has(`unoapi-status:${phone}`)).toBe(false)
})

test('a retained socket lease proves release has not completed and forbids restoring autoConnect/dispatch', async () => {
  const f = fixture(); f.values.set(`unoapi-lease:zapo-session:${phone}`, 'still-owned')
  expect(await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, f.deps)).toEqual({ autoConnect: false, reconnect: { status: 'skipped', reason: 'configuration_or_ownership_changed' } })
  expect(f.deps.dispatch).not.toHaveBeenCalled(); expect(JSON.parse(f.values.get(`unoapi-config:${phone}`)!).autoConnect).toBe(false)
})

test.each(['generation', 'owner', 'storageId', 'autoConnect', 'task', 'unlink', 'deleting'])('a concurrent %s change cannot be replaced by the captured old resume intent', async change => {
  const f = fixture(), c = { ...f.config, sessionStorage: { ...f.storage } }
  if (change === 'generation') c.sessionStorage.generation++
  else if (change === 'owner') c.sessionStorage.owner = 'worker_2'
  else if (change === 'storageId') c.sessionStorage.storageId = randomUUID()
  else if (change === 'autoConnect') c.autoConnect = true
  else if (change === 'task') c.sessionStorageTaskId = randomUUID()
  else if (change === 'unlink') c.sessionStorageUnlinked = true
  else c.mobilePrimaryDeleting = true
  f.values.set(`unoapi-config:${phone}`, JSON.stringify(c))
  expect((await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, f.deps)).reconnect.status).toBe('skipped')
  expect(f.deps.dispatch).not.toHaveBeenCalled()
})

test('previously offline sessions and every fixture remain paused without touching configuration', async () => {
  const f = fixture()
  for (const [storage, intent, reason] of [[f.storage, { eligible: false, fixture: false }, 'previously_offline'], [f.storage, { eligible: true, fixture: true }, 'fixture'], [{ ...f.storage, fixture: true }, { eligible: true, fixture: false }, 'fixture']] as const) {
    expect((await reconnectMigratedSession(phone, storage, intent, f.deps)).reconnect).toEqual({ status: 'skipped', reason })
  }
  expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.deps.dispatch).not.toHaveBeenCalled()
})

test('the real global synthetic guard still blocks a live session without removing or overriding the ENV', async () => {
  const f = fixture(), previous = process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'
  try {
    const { effectsAllowed: _ignored, ...deps } = f.deps
    expect((await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, deps)).reconnect).toEqual({ status: 'skipped', reason: 'external_effects_blocked' })
    expect(process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY).toBe('true'); expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.deps.dispatch).not.toHaveBeenCalled()
  } finally { if (previous === undefined) delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY; else process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = previous }
})

test('an ambiguous dispatch preserves committed SQLite and restored intent, reporting failed connection request only', async () => {
  const f = fixture(); f.deps.dispatch.mockRejectedValueOnce(new Error('private broker credentials'))
  const result = await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, f.deps)
  expect(result).toEqual({ autoConnect: true, reconnect: { status: 'failed', reason: 'dispatch_failed' } })
  expect(f.redis.eval).toHaveBeenCalledTimes(1); expect(f.deps.dispatch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.values.get(`unoapi-config:${phone}`)!).sessionStorage).toEqual(f.storage)
  expect(JSON.stringify(result)).not.toContain('private')
})

test('intent persistence failure or a new client cannot dispatch or turn a committed migration into rollback', async () => {
  const f = fixture(); f.redis.eval.mockRejectedValueOnce(new Error('redis unavailable'))
  expect((await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, f.deps)).reconnect).toEqual({ status: 'failed', reason: 'intent_restore_failed' })
  f.deps.hasClient.mockReturnValue(true)
  expect((await reconnectMigratedSession(phone, f.storage, { eligible: true, fixture: false }, f.deps)).reconnect).toEqual({ status: 'skipped', reason: 'client_already_present' })
  expect(f.deps.dispatch).not.toHaveBeenCalled()
})
