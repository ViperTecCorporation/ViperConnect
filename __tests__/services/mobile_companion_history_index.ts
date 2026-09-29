import { historyThreads } from '../../src/services/mobile_primary/companion_history_index'
test('discovers SDK message indexes without thread rows and rejects other scopes', async () => {
  const store: any = { threads: { list: jest.fn().mockResolvedValue([]), getByJid: jest.fn().mockResolvedValue(null) } }
  const redis = { scan: jest.fn().mockResolvedValue({ cursor: 0, keys: ['unoapi:zapo:msg:idx:999123456789:123@lid', 'unoapi:zapo:msg:idx:999999999999:234@lid', 'unoapi:zapo:auth:999123456789', 'unoapi:zapo:msg:idx:999123456789:status@broadcast'] }) }
  expect(await historyThreads(store, redis, 'unoapi:zapo:', '999123456789')).toEqual([{ jid: '123@lid' }])
  expect(redis.scan).toHaveBeenCalledWith(0, { MATCH: 'unoapi:zapo:msg:idx:999123456789:*', COUNT: 500 })
})
test('retains ephemeral metadata and deduplicates index rows', async () => {
  const thread = { jid: '123@lid', ephemeralExpiration: 3600 }
  const store: any = { threads: { list: jest.fn().mockResolvedValue([thread]), getByJid: jest.fn() } }
  const redis = { scan: jest.fn().mockResolvedValue({ cursor: 0, keys: ['p:msg:idx:999123456789:123@lid'] }) }
  expect(await historyThreads(store, redis, 'p:', '999123456789')).toEqual([thread]); expect(store.threads.getByJid).not.toHaveBeenCalled()
})
test('bounds scanning even with no matching records', async () => {
  const store: any = { threads: { list: jest.fn().mockResolvedValue([]) } }
  const redis = { scan: jest.fn().mockResolvedValue({ cursor: 1, keys: [] }) }
  expect(await historyThreads(store, redis, 'p:', '999123456789')).toEqual([])
  expect(redis.scan).toHaveBeenCalledTimes(100)
  await expect(historyThreads(store, redis, '*', '999123456789')).rejects.toThrow('scope_invalid')
})
