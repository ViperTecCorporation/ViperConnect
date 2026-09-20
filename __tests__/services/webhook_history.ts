import { WebhookHistory, publicWebhookHistory, ARCHIVE_WEBHOOKS_LUA, RESTORE_WEBHOOKS_LUA } from '../../src/services/webhook_history'
import logger from '../../src/services/logger'
jest.mock('../../src/services/redis', () => ({ configKey: (phone: string) => `unoapi-config:${phone}`, getRedis: jest.fn(), publishConfigUpdate: jest.fn() }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }))
const previous = { server: 'server_1', authToken: 'session-secret', webhooks: [{ id: 'old', url: 'https://user:pass@example.com/secret?token=hidden', token: 'private', sendNewMessages: true }] }
const snapshot = { id: 'snapshot', server: 'server_1', reason: 'removed', archived_at: '2026-09-19T12:00:00Z', webhooks: previous.webhooks }
const setup = (config: any = { server: 'server_1', label: 'Preserve', webhooks: [{ id: 'other' }] }) => {
  const redis = { get: jest.fn().mockResolvedValue(JSON.stringify(config)), eval: jest.fn().mockResolvedValue(1), lRange: jest.fn().mockResolvedValue([JSON.stringify(snapshot)]) }
  const invalidate = jest.fn().mockResolvedValue(undefined)
  return { redis, invalidate, service: new WebhookHistory(async () => redis, invalidate) }
}
describe('webhook history', () => {
  test('captures only webhook configuration and bounds persistent history to 20 snapshots', async () => {
    const { service, redis } = setup()
    expect(service.capture('5511999999', previous, 'removed')).toBeUndefined()
    await new Promise(setImmediate)
    const [script, options] = redis.eval.mock.calls[0]
    expect(script).toBe(ARCHIVE_WEBHOOKS_LUA)
    expect(script).toContain('0, 19')
    expect(script).toContain('PERSIST')
    expect(options.keys).toEqual(['unoapi-webhook-history:5511999999'])
    const stored = JSON.parse(options.arguments[0])
    expect(stored.webhooks[0].token).toBe('private')
    expect(options.arguments[0]).not.toContain('session-secret')
  })
  test('ignores empty snapshots and never waits for archive persistence', () => {
    const { service, redis } = setup()
    service.capture('5511999999', {}, 'removed')
    expect(redis.eval).not.toHaveBeenCalled()
    const blocked = new WebhookHistory(() => new Promise(() => {}))
    expect(blocked.capture('5511999999', previous, 'removed')).toBeUndefined()
  })
  test('logs failures without credentials or rejected background promises', async () => {
    const { service, redis } = setup()
    redis.eval.mockRejectedValue(new Error('password=secret'))
    service.capture('5511999999', previous, 'updated')
    await new Promise(setImmediate)
    expect(logger.warn).toHaveBeenCalledWith({ phone: '5511999999' }, 'WEBHOOK_HISTORY_ARCHIVE_FAILED')
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('password')
  })
  test('redacts tokens and all URL credentials, paths and query strings from listing', () => {
    const value = publicWebhookHistory(snapshot)
    expect(value.webhooks[0]).toEqual({ id: 'old', destination: 'https://example.com', has_credentials: true, events: ['sendNewMessages'] })
    expect(JSON.stringify(value)).not.toMatch(/private|hidden|pass|secret/)
  })
  test('restores selected IDs disabled, preserves other config and uses atomic CAS with TTL preservation', async () => {
    const { service, redis, invalidate } = setup()
    await service.restore('5511999999', 'snapshot', ['old'], false)
    const [script, options] = redis.eval.mock.calls[0]
    expect(script).toBe(RESTORE_WEBHOOKS_LUA)
    expect(script).toContain('KEEPTTL')
    const config = JSON.parse(options.arguments[1])
    expect(config.label).toBe('Preserve')
    expect(config.webhooks).toEqual([{ id: 'other' }, { ...previous.webhooks[0], enabled: false, disabled: false }])
    expect(invalidate).toHaveBeenCalledWith('5511999999')
  })
  test('requires explicit replacement on ID conflict', async () => {
    const { service, redis } = setup(previous)
    await expect(service.restore('5511999999', 'snapshot', ['old'], false)).rejects.toThrow('webhook_id_conflict')
    expect(redis.eval).not.toHaveBeenCalled()
    await service.restore('5511999999', 'snapshot', ['old'], true)
    expect(JSON.parse(redis.eval.mock.calls[0][1].arguments[1]).webhooks).toHaveLength(1)
  })
  test.each(['missing_session', 'missing_snapshot', 'server', 'id', 'concurrent'])('rejects unsafe restoration: %s', async kind => {
    const { service, redis, invalidate } = setup()
    if (kind === 'missing_session') redis.get.mockResolvedValue(null)
    if (kind === 'missing_snapshot') redis.lRange.mockResolvedValue([])
    if (kind === 'server') redis.get.mockResolvedValue(JSON.stringify({ server: 'server_2' }))
    if (kind === 'concurrent') redis.eval.mockResolvedValue(0)
    await expect(service.restore('5511999999', 'snapshot', [kind === 'id' ? 'missing' : 'old'], true)).rejects.toThrow()
    expect(invalidate).not.toHaveBeenCalled()
  })
})
