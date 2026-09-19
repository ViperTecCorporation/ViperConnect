import { createHmac } from 'crypto'
import { validateSessionDestination, publicSessionDestination } from '../../src/services/session_webhook_contract'
import { sessionEvent, SessionWebhookStore, SESSION_WEBHOOK_KEYS, SESSION_EVENT_LUA } from '../../src/services/session_webhook_store'
import { SessionLifecycleObserver } from '../../src/services/session_lifecycle_observer'
import { SessionWebhooksJob, startSessionWebhooks } from '../../src/jobs/session_webhooks'
import { amqpConsume } from '../../src/amqp'

jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn(), amqpConsume: jest.fn() }))
jest.mock('../../src/services/redis', () => ({
  getRedis: jest.fn(), configKey: (phone: string) => `unoapi-config:${phone}`, sessionPhoneIndexKey: () => 'unoapi-sessions:index',
}))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }))

const input = () => ({ name: 'Chat', url: 'https://chat.example.com/hook', server: 'server_1', enabled: true,
  session_ids: ['5511999999999'], auto_include_new_sessions: false, events: ['session.connected'], signing_secret: 'a'.repeat(32) })

describe('session webhook contract', () => {
  test.each([undefined, ''])('allows unsigned creation with secret %j and explicit removal', signing_secret => {
    const value = validateSessionDestination({ ...input(), signing_secret })
    expect(value.signing_secret).toBe('')
    expect(publicSessionDestination(value).has_signing_secret).toBe(false)
    const signed = validateSessionDestination(input())
    const cleared = validateSessionDestination({ ...input(), signing_secret: '' }, signed)
    expect(cleared.signing_secret).toBe('')
    expect(cleared.revision).not.toBe(signed.revision)
    expect(validateSessionDestination(input(), cleared).signing_secret).toBe(input().signing_secret)
  })
  test('creates identities and redacts secrets; omission preserves and empty Bearer clears', () => {
    const value = validateSessionDestination({ ...input(), bearer_token: 'private' })
    expect(publicSessionDestination(value)).toEqual(expect.objectContaining({ has_bearer_token: true, has_signing_secret: true }))
    expect(JSON.stringify(publicSessionDestination(value))).not.toContain('private')
    const update = { ...input(), signing_secret: undefined, bearer_token: '' }
    expect(validateSessionDestination(update, value)).toEqual(expect.objectContaining({ id: value.id, bearer_token: '', signing_secret: value.signing_secret }))
    expect(validateSessionDestination(update, value).revision).not.toBe(value.revision)
  })
  test.each([
    { url: 'file:///tmp/a' }, { url: 'https://user:secret@example.com' }, { url: 'bad' }, { url: 'https://example.com/#secret' },
    { enabled: 'false' }, { auto_include_new_sessions: 1 }, { session_ids: ['test@lid'] }, { events: ['message'] },
    { signing_secret: 'short' }, { bearer_token: 'abc\r\nheader' }, { name: '' }, { server: '' }, { events: [] },
    { heartbeat_interval_seconds: 59 }, { heartbeat_interval_seconds: 86401 }, { session_ids: Array(1001).fill('5511999999999') },
  ])('rejects invalid configuration %j', patch => expect(() => validateSessionDestination({ ...input(), ...patch })).toThrow('invalid_'))
  test('deduplicates members and events; never invents a connection reason', () => {
    const value = validateSessionDestination({ ...input(), session_ids: ['5511999999999', '5511999999999'] })
    expect(value.session_ids).toHaveLength(1)
    expect(sessionEvent('5511999999999', 'unavailable').connection.is_logout).toBeNull()
    expect(sessionEvent('5511999999999', 'removed').last_verified_at).toBeNull()
  })
})

describe('session lifecycle persistence boundary', () => {
  test('uses one atomic operation with exact configuration and index keys', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) }
    const store = new SessionWebhookStore(async () => redis)
    const event = sessionEvent('5511999999999', 'removed')
    await store.record('remove', event)
    expect(redis.eval).toHaveBeenCalledWith(SESSION_EVENT_LUA, {
      keys: [SESSION_WEBHOOK_KEYS.destinations, SESSION_WEBHOOK_KEYS.states, SESSION_WEBHOOK_KEYS.outbox, SESSION_WEBHOOK_KEYS.heartbeat, 'unoapi-config:5511999999999', 'unoapi-sessions:index'],
      arguments: ['remove', '5511999999999', JSON.stringify(event), '', `${Date.parse(event.occurred_at)}`],
    })
    redis.eval.mockRejectedValueOnce(new Error('redis down'))
    await expect(store.record('observe', event)).rejects.toThrow('redis down')
  })
  test('reads, saves and deletes destinations; normalizes Lua empty arrays; pages and ACKs only named outbox item', async () => {
    const destination = validateSessionDestination(input())
    const event = sessionEvent('5511999999999', 'connected')
    const delivery = { destination_id: destination.id, revision: destination.revision, event }
    const redis = { hGetAll: jest.fn().mockResolvedValue({ x: JSON.stringify({ ...destination, session_ids: {} }) }), hSet: jest.fn(), hDel: jest.fn(),
      hScan: jest.fn().mockResolvedValue({ cursor: '17', tuples: [{ field: 'outbox-id', value: JSON.stringify(delivery) }] }) }
    const store = new SessionWebhookStore(async () => redis)
    expect((await store.destinations())[0].session_ids).toEqual([])
    await store.save(destination)
    expect(redis.hSet).toHaveBeenCalledWith(SESSION_WEBHOOK_KEYS.destinations, destination.id, JSON.stringify(destination))
    await store.removeDestination(destination.id)
    expect(redis.hDel).toHaveBeenCalledWith(SESSION_WEBHOOK_KEYS.destinations, destination.id)
    redis.hGetAll.mockResolvedValue({ x: JSON.stringify(event) })
    expect(await store.states()).toEqual([event])
    expect(await store.pending()).toEqual({ cursor: 17, entries: [{ id: 'outbox-id', delivery }] })
    await store.acknowledge('outbox-id')
    expect(redis.hDel).toHaveBeenCalledWith(SESSION_WEBHOOK_KEYS.outbox, 'outbox-id')
  })
})

describe('provider observer', () => {
  afterEach(() => jest.useRealTimers())
  test('serializes open/close without blocking callback; stops heartbeat after logout', async () => {
    jest.useFakeTimers()
    const record = jest.fn().mockResolvedValue(undefined)
    const observer = new SessionLifecycleObserver({ record })
    observer.observe('5511999999999', true)
    await observer.flush()
    await jest.advanceTimersByTimeAsync(30_000)
    await observer.flush()
    expect(record.mock.calls[1][1].event).toBe('session.heartbeat')
    observer.observe('5511999999999', false, { is_logout: true, reason: 'device_removed' })
    await observer.flush()
    expect(record.mock.calls[2][1].event).toBe('session.unlinked')
    observer.observe('5511999999999', false, { intentional: true }, false)
    await observer.flush()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(record).toHaveBeenCalledTimes(3)
    observer.stop()
  })
  test('coalesces pending heartbeat writes during slow persistence and does not claim a local close is provider proof', async () => {
    jest.useFakeTimers()
    let release: () => void = () => undefined
    const record = jest.fn().mockReturnValueOnce(new Promise<void>(resolve => { release = resolve })).mockResolvedValue(undefined)
    const observer = new SessionLifecycleObserver({ record })
    observer.observe('5511999999999', true)
    await jest.advanceTimersByTimeAsync(300_000)
    expect(record).toHaveBeenCalledTimes(1)
    release()
    await observer.flush()
    expect(record).toHaveBeenCalledTimes(2)
    observer.observe('5511999999999', false, { intentional: true }, false)
    await observer.flush()
    expect(record.mock.calls[2][1].last_verified_at).toBeNull()
    observer.stop()
  })
  test('persistence rejection does not prevent the next observation', async () => {
    const record = jest.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValue(undefined)
    const observer = new SessionLifecycleObserver({ record })
    observer.observe('5511999999999', false)
    observer.observe('5511999999999', false)
    await observer.flush()
    expect(record).toHaveBeenCalledTimes(2)
  })
})

describe('isolated lifecycle delivery job', () => {
  const setup = () => {
    const destination = validateSessionDestination({ ...input(), bearer_token: 'bearer' })
    const event = sessionEvent('5511999999999', 'connected')
    event.destination_id = destination.id
    const delivery = { destination_id: destination.id, revision: destination.revision, event }
    const store = { destinations: jest.fn().mockResolvedValue([destination]), states: jest.fn().mockResolvedValue([]),
      pending: jest.fn().mockResolvedValue({ cursor: 0, entries: [{ id: 'item', delivery }] }), acknowledge: jest.fn(), record: jest.fn() }
    const publish = jest.fn().mockResolvedValue(undefined)
    const request = jest.fn().mockResolvedValue({ ok: true, body: { cancel: jest.fn() } })
    return { destination, delivery, store, publish, request, job: new SessionWebhooksJob(store as unknown as SessionWebhookStore, publish, request) }
  }
  test('signs exact bytes, sends Bearer, never follows redirects', async () => {
    const { job, request, destination, delivery } = setup()
    await job.consume('', delivery)
    const options = request.mock.calls[0][1]
    const signature = createHmac('sha256', destination.signing_secret).update(`${options.headers['X-ViperConnect-Timestamp']}.${options.body}`).digest('hex')
    expect(options.headers['X-ViperConnect-Signature']).toBe(`sha256=${signature}`)
    expect(options.headers.Authorization).toBe('Bearer bearer')
    expect(options.redirect).toBe('error')
    expect(JSON.parse(options.body)).toEqual(delivery.event)
  })
  test.each(['', 'bearer'])('delivers unsigned with independent Bearer %j', bearer_token => {
    const { job, request, destination, delivery } = setup()
    destination.signing_secret = ''
    destination.bearer_token = bearer_token
    return job.consume('', delivery).then(() => {
      const options = request.mock.calls[0][1]
      expect(options.headers).not.toHaveProperty('X-ViperConnect-Signature')
      expect(options.headers['X-ViperConnect-Timestamp']).toMatch(/^\d+$/)
      expect(options.headers['X-ViperConnect-Event-Id']).toBe(delivery.event.event_id)
      expect(options.headers.Authorization).toBe(bearer_token ? 'Bearer bearer' : undefined)
      expect(JSON.parse(options.body)).toEqual(delivery.event)
    })
  })
  test.each(['disabled', 'deleted', 'edited'])('cancels %s destination without HTTP', async kind => {
    const { job, store, destination, request, delivery } = setup()
    store.destinations.mockResolvedValue(kind === 'deleted' ? [] : [{ ...destination, enabled: kind !== 'disabled', revision: kind === 'edited' ? 'new' : destination.revision }])
    await job.consume('', delivery)
    expect(request).not.toHaveBeenCalled()
  })
  test.each([400, 429, 500])('non-2xx %s retries using a sanitized error', async status => {
    const { job, request, delivery } = setup()
    request.mockResolvedValue({ ok: false, status })
    await expect(job.consume('', delivery)).rejects.toThrow('session_webhook_delivery_failed')
    request.mockRejectedValue(new Error('secret URL'))
    await expect(job.consume('', delivery)).rejects.toThrow('session_webhook_delivery_failed')
  })
  test('retains outbox on publish failure; ACK only after confirmation', async () => {
    const { job, store, publish } = setup()
    publish.mockRejectedValueOnce(new Error('nack'))
    await expect(job.tick()).rejects.toThrow('nack')
    expect(store.acknowledge).not.toHaveBeenCalled()
    let resolve: () => void = () => undefined
    publish.mockReturnValueOnce(new Promise<void>(done => { resolve = done }))
    const pending = job.tick()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    await job.tick()
    expect(store.acknowledge).not.toHaveBeenCalled()
    resolve()
    await pending
    expect(store.acknowledge).toHaveBeenCalledWith('item')
  })
  test('marks only stale connected observations unavailable with compare-and-set fence', async () => {
    const { job, store } = setup()
    const previous = sessionEvent('5511999999999', 'connected', {}, '2026-09-19T00:00:00.000Z')
    store.states.mockResolvedValue([previous, sessionEvent('5511888888888', 'unlinked', {}, previous.occurred_at)])
    await job.tick(Date.parse('2026-09-19T00:03:00.000Z'))
    expect(store.record).toHaveBeenCalledTimes(1)
    expect(store.record).toHaveBeenCalledWith('observe', expect.objectContaining({ event: 'session.unavailable' }), previous.last_observed_at)
  })
  test('starts isolated consumer and a stoppable polling timer', async () => {
    jest.useFakeTimers()
    const tick = jest.spyOn(SessionWebhooksJob.prototype, 'tick').mockResolvedValue(undefined)
    const timer = await startSessionWebhooks()
    expect(amqpConsume).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('session.events'), '*', expect.any(Function), expect.objectContaining({ prefetch: 2, notifyFailedMessages: false }))
    await jest.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
    clearInterval(timer)
    tick.mockRestore()
    jest.useRealTimers()
  })
})
