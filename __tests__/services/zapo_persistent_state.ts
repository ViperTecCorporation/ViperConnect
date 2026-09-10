import type Redis from 'ioredis'
import type { WaStore } from 'zapo-js'
import { persistZapoState, prepareZapoState, registerZapoStatePreparation } from '../../src/services/zapo/zapo_persistent_state'

describe('Zapo persistent state migration', () => {
  const prefix = 'unoapi:zapo:'
  let scan: jest.Mock
  let persist: jest.Mock
  let exec: jest.Mock
  let redis: Pick<Redis, 'scan' | 'pipeline'>
  beforeEach(() => {
    scan = jest.fn().mockResolvedValue(['0', []])
    persist = jest.fn()
    exec = jest.fn().mockResolvedValue([[null, 1]])
    redis = { scan, pipeline: jest.fn(() => ({ persist, exec })) } as unknown as typeof redis
  })

  test('selects only known state families including binary and index keys across pages', async () => {
    const state = ['signal:reg:123:pub', 'signal:spk:123:sig', 'signal:meta:123',
      'signal:sess:123:u:s:1', 'signal:ident:123:u:s:1', 'signal:pk:avail:123',
      'sk:123:g:u:s:1', 'sk:grp:123:g', 'skd:123:g', 'appstate:key:123:x:data',
      'appstate:key:idx:123', 'appstate:idx:set:123:c', 'appstate:col:123:c:hash',
      'privtoken:123:u:tc_token', 'privtoken:123:u:nct_salt']
    scan.mockResolvedValueOnce(['7', [...state.map((key) => prefix + key),
      prefix + 'msg:123:x', prefix + 'contact:123:u', prefix + 'retry:123:x',
      prefix + 'msgsecret:123:x', prefix + 'device_list:123:x', prefix + 'signal:unknown:123',
      'other:signal:reg:123', prefix + 'auth:123']]).mockResolvedValueOnce(['0', []])
    exec.mockResolvedValueOnce(state.map(() => [null, 1]))
    expect(await persistZapoState(redis, prefix)).toBe(state.length)
    expect(persist.mock.calls.flat()).toEqual(state.map((key) => prefix + key))
    expect(scan).toHaveBeenLastCalledWith('7', 'MATCH', prefix + '*', 'COUNT', 250)
  })

  test('bounds pipelines, accepts already persistent or disappeared keys and custom prefix', async () => {
    scan.mockResolvedValue(['0', Array.from({ length: 201 }, (_, i) => `custom:privtoken:s:${i}`)])
    exec.mockResolvedValue([[null, 0]])
    expect(await persistZapoState(redis, 'custom:')).toBe(0)
    expect(redis.pipeline).toHaveBeenCalledTimes(3)
    expect(persist).toHaveBeenCalledTimes(201)
  })

  test.each(['', '*', 'prefix[1]:'])('rejects unsafe prefix %s', async (value) => {
    await expect(persistZapoState(redis, value)).rejects.toThrow('Invalid Zapo persistence prefix')
    expect(scan).not.toHaveBeenCalled()
  })

  test.each([null, [[new Error('redis failed'), null]]])('propagates pipeline failures', async (results) => {
    scan.mockResolvedValue(['0', [prefix + 'privtoken:s:u']])
    exec.mockResolvedValue(results)
    await expect(persistZapoState(redis, prefix)).rejects.toThrow()
  })

  test('preparation shares work, retries after failure and skips non-Redis stores', async () => {
    const store = {} as WaStore
    await prepareZapoState(store)
    registerZapoStatePreparation(store, redis, prefix)
    scan.mockRejectedValueOnce(new Error('scan failed'))
    await expect(prepareZapoState(store)).rejects.toThrow('scan failed')
    await Promise.all([prepareZapoState(store), prepareZapoState(store)])
    await prepareZapoState(store)
    expect(scan).toHaveBeenCalledTimes(2)
  })
})
