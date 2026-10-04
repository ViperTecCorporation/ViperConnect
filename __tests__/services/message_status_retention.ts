import { proto } from 'zapo-js/proto'
import { setRetainedMessageStatus, SET_RETAINED_STATUS_LUA } from '../../src/services/messages/message_status_retention'

const ttlMs = 30 * 86400000
const options = { ttlMs, nativeTtlMs: ttlMs, nativePrefix: 'native:' }
const setup = () => {
  const values = new Map<string, string>()
  const redis = { mGet: jest.fn(async (keys: string[]) => keys.map(key => values.get(key) ?? null)), eval: jest.fn().mockResolvedValue(1) }
  return { values, redis }
}
describe('message status fixed retention', () => {
  test('unknown/scheduled/failed messages use a bounded first-status window without scans', async () => {
    const { redis } = setup()
    const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await setRetainedMessageStatus(redis, '123', 'a', 'scheduled', options)
      expect(redis.mGet).toHaveBeenCalledTimes(2)
      expect(redis.eval.mock.calls[0][1]).toMatchObject({ keys: ['unoapi-message-status:123:a', 'native:msg:123:a'], arguments: [String(now), String(now + ttlMs), 'scheduled', '[1]', '[2]', String(ttlMs), '3'] })
      expect(SET_RETAINED_STATUS_LUA).toContain('deadline=math.min(deadline,now+remaining)')
    } finally { jest.restoreAllMocks() }
  })
  test.each(['json', 'protobuf'])('aligns to original copy date and both ID aliases (%s)', async encoding => {
    const { redis, values } = setup()
    const timestamp = Math.floor(Date.now() / 1000) - 20 * 86400
    values.set('unoapi-id_rev:123:UNO', 'PROVIDER')
    values.set('unoapi-key:123:UNO', JSON.stringify({ id: 'PROVIDER', remoteJid: '456@lid' }))
    const message = { messageTimestamp: timestamp }
    values.set('unoapi-message:123:456@lid:PROVIDER', encoding === 'json' ? JSON.stringify(message) : Buffer.from(proto.WebMessageInfo.encode(message).finish()).toString('base64'))
    await setRetainedMessageStatus(redis, '123', 'UNO', 'read', options)
    const call = redis.eval.mock.calls[0][1]
    expect(call.arguments[1]).toBe(String(timestamp * 1000 + ttlMs))
    expect(call.keys).toContain('unoapi-message-status:123:PROVIDER')
    expect(call.keys).toContain('native:msg:123:PROVIDER')
    expect(call.keys).toContain('unoapi-message:123:456@lid:PROVIDER')
    expect(redis.mGet).toHaveBeenCalledTimes(3)
  })
  test('reverse aliases, corrupt metadata and content remain bounded', async () => {
    const { redis, values } = setup()
    values.set('unoapi-id:123:PROVIDER', 'UNO')
    values.set('unoapi-key:123:PROVIDER', '{broken')
    values.set('unoapi-key:123:UNO', JSON.stringify({ remoteJid: '456@lid' }))
    values.set('unoapi-message:123:456@lid:UNO', 'invalid')
    await setRetainedMessageStatus(redis, '123', 'PROVIDER', 'failed', options)
    expect(redis.eval.mock.calls[0][1].keys).toContain('unoapi-message-status:123:UNO')
  })
  test('Redis failures propagate instead of falling back to a refreshed TTL', async () => {
    const { redis } = setup()
    redis.eval.mockRejectedValueOnce(new Error('redis down'))
    await expect(setRetainedMessageStatus(redis, '123', 'a', 'read', options)).rejects.toThrow('redis down')
  })
})
