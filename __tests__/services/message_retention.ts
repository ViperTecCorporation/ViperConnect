import { DEFAULT_MESSAGE_RETENTION_MS, messageRetentionMs, messageTimestampMs, messageIsExpired, SET_RETAINED_MESSAGE_LUA } from '../../src/services/messages/message_retention'
import { RedisMessageRetention, UPSERT_RETAINED_MESSAGE_LUA } from '../../src/services/messages/redis_message_retention'

const now = 1800000000000
const ttl = DEFAULT_MESSAGE_RETENTION_MS
describe('original message age retention', () => {
  test('normalizes protobuf seconds/milliseconds and invalid configuration', () => {
    expect(messageTimestampMs({ toString: () => '1800000000' }, true)).toBe(now)
    expect(messageTimestampMs(now)).toBe(now)
    for (const value of [undefined, null, 0, -1, 'invalid']) expect(messageTimestampMs(value)).toBeUndefined()
    expect(messageRetentionMs(-1)).toBe(ttl)
    expect(messageRetentionMs(1234)).toBe(1234)
    expect(messageIsExpired((now - ttl) / 1000, ttl, true, now)).toBe(true)
    expect(messageIsExpired(now - ttl + 1, ttl, false, now)).toBe(false)
    expect(messageIsExpired(undefined, ttl, false, now)).toBe(false)
  })
  const setup = () => {
    const pipe: any = { eval: jest.fn().mockReturnThis(), exec: jest.fn() }
    const redis: any = { pipeline: jest.fn().mockReturnValue(pipe) }
    const native: any = { getById: jest.fn(), listByThread: jest.fn() }
    return { pipe, native, retention: new RedisMessageRetention(redis, 'audit:', '123', native, ttl) }
  }
  test('atomic writer keeps binary schema, prunes indexes, clamps earlier deadlines', async () => {
    const { pipe, retention } = setup()
    pipe.exec.mockResolvedValue([[null, now]])
    const record = { id: 'a', threadJid: 'group@g.us', fromMe: false, senderJid: '456@lid', participantJid: '456@lid', timestampMs: now, messageBytes: Buffer.from([0, 255, 1]) }
    expect(await retention.write([record])).toEqual([record])
    const args = pipe.eval.mock.calls[0]
    expect(args.slice(1, 6)).toEqual([4, 'audit:msg:123:a', 'audit:msg:123:a:message_bytes', 'audit:msg:123:a:plaintext', 'audit:msg:idx:123:group@g.us'])
    expect(args.at(-1)).toEqual(record.messageBytes)
    expect(UPSERT_RETAINED_MESSAGE_LUA).toContain("'ZREMRANGEBYSCORE'")
    expect(SET_RETAINED_MESSAGE_LUA).toContain('math.min(deadline,now+remaining)')
    expect(UPSERT_RETAINED_MESSAGE_LUA).toContain('stamp=math.min(stamp,previous)')
  })
  test('batch pipelines are bounded and expired records are not indexed', async () => {
    const { pipe, retention } = setup()
    const rows = Array.from({ length: 201 }, (_, i) => ({ id: String(i), threadJid: '456@lid', fromMe: true }))
    pipe.exec.mockResolvedValueOnce(Array.from({ length: 200 }, () => [null, 0])).mockResolvedValueOnce([[null, now]])
    expect(await retention.write(rows)).toEqual([{ ...rows[200], timestampMs: now }])
    expect(pipe.exec).toHaveBeenCalledTimes(2)
  })
  test('Redis errors propagate, not silently acknowledged as successful writes', async () => {
    const { pipe, retention } = setup()
    pipe.exec.mockResolvedValue([[new Error('denied'), null]])
    await expect(retention.write([{ id: 'a', threadJid: '456@lid', fromMe: false }])).rejects.toThrow('message_retention_write_failed')
  })
  test('native reads hide old preexisting sliding-TTL messages without deleting credentials', async () => {
    const { retention, native } = setup()
    const recent = { id: 'a', timestampMs: Date.now(), threadJid: '456@lid', fromMe: false }
    const old = { ...recent, id: 'b', timestampMs: Date.now() - ttl - 1000 }
    native.getById.mockResolvedValueOnce(old).mockResolvedValueOnce(recent)
    expect(await retention.getById('b')).toBeNull()
    expect(await retention.getById('a')).toEqual(recent)
    native.listByThread.mockResolvedValue([recent, old])
    expect(await retention.listByThread('456@lid', 10)).toEqual([recent])
  })
})
