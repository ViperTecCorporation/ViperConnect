import { createClient } from '@redis/client'
import { SessionWebhookStore, sessionEvent } from '../../src/services/session_webhook_store'
import { validateSessionDestination } from '../../src/services/session_webhook_contract'
import { SessionWebhooksJob } from '../../src/jobs/session_webhooks'

// Opt-in only. Refuse production endpoints and require the disposable server's
// exact directory before clearing its otherwise isolated test database.
const url = process.env.SESSION_WEBHOOK_TEST_REDIS_URL
const integration = url ? describe : describe.skip
integration('lifecycle Lua on disposable Redis', () => {
  const client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } })
  const store = new SessionWebhookStore(async () => client)
  const phone = '5511999999999'
  const old = '5511888888888'
  const config = { provider: 'zapo', server: 'server_1', label: 'Atendimento' }
  const now = '2026-09-19T00:00:00.000Z'
  const destination = (patch: Record<string, unknown> = {}) => validateSessionDestination({
    name: 'test', url: 'https://example.com/hook', server: 'server_1', enabled: true, session_ids: [],
    auto_include_new_sessions: true, events: ['session.connected', 'session.unlinked', 'session.disconnected', 'session.removed', 'session.unavailable', 'session.heartbeat'],
    signing_secret: 'x'.repeat(32), heartbeat_interval_seconds: 60, ...patch,
  })
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/15') throw new Error('isolated_local_redis_db15_required')
    await client.connect()
    const directory = (await client.configGet('dir')).dir
    if (!/\/unoapi-session-webhooks-[a-zA-Z0-9-]+$/.test(directory)) throw new Error('disposable_test_directory_required')
  })
  beforeEach(async () => { await client.flushDb() })
  afterAll(async () => { if (client.isOpen) await client.quit() })

  test('auto enrollment is atomic with creation, not retroactive, scoped, idempotent and preserved when disabled', async () => {
    await store.saveConfig(old, config, -1)
    const d = destination()
    const other = destination({ server: 'server_2' })
    await store.save(d); await store.save(other)
    await Promise.all([store.saveConfig(phone, config, -1), store.saveConfig(phone, config, -1)])
    await store.saveConfig(old, config, -1)
    expect((await store.destinations()).find(item => item.id === d.id)?.session_ids).toEqual([phone])
    expect((await store.destinations()).find(item => item.id === other.id)?.session_ids).toEqual([])
    const enrolled = (await store.destinations()).find(item => item.id === d.id)!
    await store.save({ ...enrolled, auto_include_new_sessions: false })
    await store.saveConfig('5511777777777', config, -1)
    expect((await store.destinations()).find(item => item.id === d.id)?.session_ids).toEqual([phone])
    expect(await client.ttl(`unoapi-config:${phone}`)).toBe(-1)
    expect(await client.sMembers('unoapi-sessions:index')).toContain(phone)
  })

  test('captures each destination, suppresses duplicate transitions, and deletes config atomically with removed snapshots', async () => {
    const a = destination(), b = destination()
    await store.save(a); await store.save(b)
    await store.saveConfig(phone, config, 600)
    expect(await client.ttl(`unoapi-config:${phone}`)).toBeGreaterThan(0)
    await store.record('observe', sessionEvent(phone, 'connected', {}, now))
    await store.record('observe', sessionEvent(phone, 'connected', {}, now))
    let page = await store.pending()
    expect(page.entries).toHaveLength(2)
    expect(page.entries.map(item => item.delivery.event.session.label)).toEqual(['Atendimento', 'Atendimento'])
    await store.record('remove', sessionEvent(phone, 'removed', {}, '2026-09-19T00:00:10.000Z'))
    expect(await client.get(`unoapi-config:${phone}`)).toBeNull()
    expect(await client.sMembers('unoapi-sessions:index')).not.toContain(phone)
    expect((await store.destinations()).every(d => d.session_ids.length === 0)).toBe(true)
    page = await store.pending()
    expect(page.entries.filter(item => item.delivery.event.event === 'session.removed')).toHaveLength(2)
    await store.record('observe', sessionEvent(phone, 'connected', {}, '2026-09-19T00:00:11.000Z'))
    expect((await store.states())[0].state.current).toBe('removed')
    await store.record('remove', sessionEvent(phone, 'removed'))
    expect((await store.pending()).entries).toHaveLength(4)
  })

  test('heartbeat is throttled per destination, does not renew proof, CAS prevents stale unavailable', async () => {
    await store.save(destination())
    await store.saveConfig(phone, config, -1)
    await store.record('observe', sessionEvent(phone, 'connected', {}, now))
    const heartbeat = sessionEvent(phone, 'connected', {}, '2026-09-19T00:00:30.000Z')
    heartbeat.event = 'session.heartbeat'
    await store.record('observe', heartbeat)
    await store.record('observe', { ...heartbeat, event_id: 'other-id', occurred_at: '2026-09-19T00:00:45.000Z', last_observed_at: '2026-09-19T00:00:45.000Z' })
    expect((await store.pending()).entries.filter(item => item.delivery.event.event === 'session.heartbeat')).toHaveLength(1)
    expect((await store.states())[0].last_verified_at).toBe(now)
    expect((await store.states())[0].state.changed_at).toBe(now)
    await store.record('observe', sessionEvent(phone, 'unavailable', {}, '2026-09-19T00:03:00.000Z'), now)
    expect((await store.states())[0].state.current).toBe('connected')
    await store.record('observe', sessionEvent(phone, 'unavailable', {}, '2026-09-19T00:03:00.000Z'), '2026-09-19T00:00:45.000Z')
    expect((await store.states())[0].state.current).toBe('unavailable')
    expect((await store.states())[0].last_verified_at).toBe(now)
    expect((await store.states())[0].last_observed_at).toBe('2026-09-19T00:00:45.000Z')
    const resumed = sessionEvent(phone, 'connected', {}, '2026-09-19T00:03:30.000Z')
    resumed.event = 'session.heartbeat'
    await store.record('observe', resumed)
    expect((await store.states())[0].state.current).toBe('connected')
    expect((await store.states())[0].event).toBe('session.connected')
    expect((await store.states())[0].last_verified_at).toBe(now)
  })

  test('restart dispatcher retains stable event IDs after nack and drains after confirmed publish', async () => {
    await store.save(destination())
    await store.saveConfig(phone, config, -1)
    await store.record('observe', sessionEvent(phone, 'unlinked', { is_logout: true }, now))
    const original = (await store.pending()).entries[0].delivery.event.event_id
    const publish = jest.fn().mockRejectedValueOnce(new Error('nack')).mockResolvedValue(undefined)
    await expect(new SessionWebhooksJob(store, publish).tick()).rejects.toThrow('nack')
    await new SessionWebhooksJob(store, publish).tick()
    expect(publish.mock.calls[1][3].event.event_id).toBe(original)
    expect((await store.pending()).entries).toHaveLength(0)
  })

  test('recreation preserves sequence and rejects old callbacks; legacy provider is not auto-enrolled', async () => {
    await store.save(destination())
    await store.saveConfig(phone, config, -1)
    await store.record('remove', sessionEvent(phone, 'removed', {}, now))
    const seq = (await store.states())[0].state.sequence
    await store.saveConfig(phone, config, -1)
    await store.record('observe', sessionEvent(phone, 'unlinked', {}, now))
    expect((await store.states())[0].state.current).toBe('unavailable')
    expect((await store.states())[0].connection.reason).toBe('session_registered_pending_observation')
    await store.record('observe', sessionEvent(phone, 'connected'))
    expect((await store.states())[0].state.sequence).toBeGreaterThan(seq)
    await store.saveConfig(old, { ...config, provider: 'baileys' }, -1)
    expect((await store.destinations())[0].session_ids).not.toContain(old)
  })
})
