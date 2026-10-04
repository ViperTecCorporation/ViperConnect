import { mockDeep } from 'jest-mock-extended'
import type Redis from 'ioredis'
import { SessionMessageIndex, decorateMessageBackend } from '../../src/services/messages/session_message_index'
import { proto } from 'zapo-js'

const setup = () => {
  const redis = mockDeep<Redis>()
  const pipe: any = { eval: jest.fn().mockReturnThis(), hgetall: jest.fn().mockReturnThis(), getBuffer: jest.fn().mockReturnThis(), zrevrange: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([[null, 1]]) }
  redis.pipeline.mockReturnValue(pipe)
  const index = new SessionMessageIndex(redis, 'test:', 100000)
  return { redis, pipe, index }
}
describe('session message persistence indexes', () => {
  test('projects only recent direct/group records and atomically compares score/ID', async () => {
    const { index, pipe, redis } = setup(); const now = Date.now()
    await index.update('5511999999999', [
      { id: 'a', threadJid: '123@lid', fromMe: false, timestampMs: now, messageBytes: proto.Message.encode({ conversation: 'hello' }).finish() },
      { id: 'b', threadJid: '123@lid', fromMe: false, timestampMs: now },
      { id: 'old', threadJid: '456@lid', fromMe: false, timestampMs: now - 200000 },
      { id: 'status', threadJid: 'status@broadcast', fromMe: false, timestampMs: now },
    ])
    expect(pipe.eval).toHaveBeenCalledTimes(1)
    expect(pipe.eval.mock.calls[0][0]).toContain('s.timestamp_ms>')
    expect(pipe.eval.mock.calls[0][5]).toBe('b')
    expect(redis.publish).toHaveBeenCalledTimes(1)
  })
  test('records read metadata/bodies in one pipeline, skipping expired refs', async () => {
    const { index, pipe } = setup()
    pipe.exec.mockResolvedValue([[null, { id: 'a', thread_jid: '123@lid', timestamp_ms: String(Date.now()), from_me: '1' }], [null, Buffer.from('data')], [null, {}], [null, null]])
    expect((await index.records('5511999999999', ['a', 'expired']))[0]).toMatchObject({ id: 'a', threadJid: '123@lid', fromMe: true })
    expect(pipe.exec).toHaveBeenCalledTimes(1)
  })
  test('state overlay does not change native retention keys', async () => {
    const { index, pipe } = setup()
    jest.spyOn(index, 'records').mockResolvedValue([{ id: 'a', threadJid: '123@lid', timestampMs: Date.now(), fromMe: false }])
    await index.state('5511999999999', ['a'], { edited: true, text: 'changed' })
    expect(pipe.eval.mock.calls[0][2]).toContain('panel:5511999999999:state:a')
    expect(pipe.eval.mock.calls[0][0]).not.toContain('msg:idx')
  })
  test('initialization is locked and background, ready requests never scan', async () => {
    const { index, redis } = setup(); const backfill = jest.spyOn(index, 'backfill').mockResolvedValue()
    redis.get.mockResolvedValueOnce('1')
    expect(await index.ensure('5511999999999')).toBe(true); expect(redis.scan).not.toHaveBeenCalled()
    redis.get.mockResolvedValue(null); redis.set.mockResolvedValueOnce('OK')
    expect(await index.ensure('5511999999999')).toBe(false); expect(backfill).toHaveBeenCalledTimes(1)
    redis.set.mockResolvedValueOnce(null)
    expect(await index.ensure('5511999999999')).toBe(false); expect(backfill).toHaveBeenCalledTimes(1)
  })
  test('backfill scans native indexes once in bounded batches and marks ready', async () => {
    const { index, redis, pipe } = setup()
    redis.scan.mockResolvedValue(['0', ['test:msg:idx:5511999999999:123@lid']])
    redis.eval.mockResolvedValue(1); pipe.exec.mockResolvedValue([[null, ['a']]])
    jest.spyOn(index, 'records').mockResolvedValue([]); const update = jest.spyOn(index, 'update').mockResolvedValue()
    await index.backfill('5511999999999', 'owner')
    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'test:msg:idx:5511999999999:*', 'COUNT', 200)
    expect(update).toHaveBeenCalled(); expect(redis.set).toHaveBeenCalledWith('test:panel:5511999999999:ready', '1', 'PX', 100000)
  })
  test('clear only unlinks the owning session auxiliary prefix', async () => {
    const { index, redis } = setup()
    redis.scan.mockResolvedValue(['0', ['test:panel:5511999999999:ready']])
    await index.clear('5511999999999')
    expect(redis.unlink).toHaveBeenCalledWith('test:panel:5511999999999:ready')
    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'test:panel:5511999999999:*', 'COUNT', 200)
  })
  test('decorator delegates native reads/writes and cleanup, preserves successful write on index failure', async () => {
    const { redis } = setup()
    redis.publish.mockResolvedValue(1); redis.scan.mockResolvedValue(['0', []])
    const native: any = { upsert: jest.fn(), upsertBatch: jest.fn(), getById: jest.fn().mockResolvedValue({ id: 'a', threadJid: '123@lid' }), listByThread: jest.fn().mockResolvedValue([]), deleteById: jest.fn().mockResolvedValue(1), clear: jest.fn() }
    const backend = decorateMessageBackend({ stores: { messages: () => native }, caches: {} } as any, redis, 'test:')
    const store = backend.stores.messages('5511999999999')
    await store.upsert({ id: 'a', threadJid: '123@lid', fromMe: false })
    await store.upsertBatch([]); await store.getById('a'); await store.listByThread('123@lid', 10)
    expect(await store.deleteById('a')).toBe(1); await store.clear()
    expect(native.upsert).not.toHaveBeenCalled(); expect(redis.pipeline).toHaveBeenCalled(); expect(native.clear).toHaveBeenCalledTimes(1)
  })
})
