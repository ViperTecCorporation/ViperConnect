jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
import { getRedis } from '../../src/services/redis'
import { saveReplyWarning, loadReplyWarning, completeReplyWarning, replyWarningStatus } from '../../src/services/reply_warning_outbox'

describe('reply warning persistence', () => {
  const values = new Map<string, string>()
  const redis = { set: jest.fn(async (key, value) => { values.set(key, value) }),
    get: jest.fn(async key => values.get(key)), del: jest.fn(async key => values.delete(key)) }
  const pending = { recipientId: 'group@g.us', timestamp: '100', warnings: [{ code: 'REPLY_SENT_WITHOUT_QUOTE', message: 'Aviso' }] }
  beforeEach(() => { values.clear(); jest.clearAllMocks(); (getRedis as jest.Mock).mockResolvedValue(redis) })
  it('persists without TTL and isolates session/message IDs', async () => {
    await saveReplyWarning('session', 'id', pending)
    expect(redis.set.mock.calls[0]).toHaveLength(2)
    expect(await loadReplyWarning('session', 'id')).toEqual(pending)
    expect(await loadReplyWarning('other', 'id')).toBeUndefined()
    expect(await loadReplyWarning('session', 'other')).toBeUndefined()
    await completeReplyWarning('session', 'id')
    expect(await loadReplyWarning('session', 'id')).toBeUndefined()
  })
  it('rejects invalid identities and corrupted storage', async () => {
    await expect(saveReplyWarning('', 'id', pending)).rejects.toThrow('reply_warning_identity_required')
    values.set('unoapi-reply-warning:session:id', JSON.stringify({ ...pending, warnings: [{ code: 'INVALID' }] }))
    await expect(loadReplyWarning('session', 'id')).rejects.toThrow('invalid_reply_warning')
  })
  it('propagates Redis failures for retry instead of declaring completion', async () => {
    ;(getRedis as jest.Mock).mockRejectedValue(new Error('redis down'))
    await expect(saveReplyWarning('session', 'id', pending)).rejects.toThrow('redis down')
    await expect(loadReplyWarning('session', 'id')).rejects.toThrow('redis down')
    await expect(completeReplyWarning('session', 'id')).rejects.toThrow('redis down')
  })
  it.each([undefined, 'sent', 'delivered', 'read', 'deleted'])('preserves status progression for %s', previous => {
    const status = replyWarningStatus('session', 'id', pending, previous).entry[0].changes[0].value.statuses[0]
    expect(status).toEqual({ id: 'id', recipient_id: 'group@g.us', status: previous || 'sent', timestamp: '100', warnings: pending.warnings })
  })
})
