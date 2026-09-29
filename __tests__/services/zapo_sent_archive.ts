import { mockDeep } from 'jest-mock-extended'
import { proto, type WaStoreSession } from 'zapo-js'
import type { DataStore } from '../../src/services/data_store'
import { ZapoSentArchive } from '../../src/services/zapo/zapo_sent_archive'

test('captures without writes, then persists provider ID and timestamp without changing UnoID mapping', async () => {
  const archive = new ZapoSentArchive(), cache = mockDeep<DataStore>(), store = mockDeep<WaStoreSession>()
  archive.capture({ id: 'zapo-id', to: '123@lid', message: { conversation: 'Oi' } })
  expect(store.messages.upsert).not.toHaveBeenCalled()
  expect(await archive.commit('zapo-id', cache, store)).toBe(true)
  const record = store.messages.upsert.mock.calls[0][0]
  expect(record).toMatchObject({ id: 'zapo-id', threadJid: '123@lid', fromMe: true, timestampMs: expect.any(Number) })
  expect(proto.Message.decode(record.messageBytes!).conversation).toBe('Oi')
  expect(cache.setMessage).toHaveBeenCalledWith('123@lid', expect.objectContaining({ messageTimestamp: Math.floor(record.timestampMs! / 1000) }))
  expect(cache.setUnoId).not.toHaveBeenCalled()
  expect(await archive.commit('zapo-id', cache, store)).toBe(false)
})

test('missing captures never overwrite an existing cache record', async () => {
  const archive = new ZapoSentArchive(), cache = mockDeep<DataStore>()
  archive.capture({ id: '', to: '123@lid', message: {} })
  expect(await archive.commit('missing', cache)).toBe(false)
  expect(cache.setMessage).not.toHaveBeenCalled()
})

test('preserves existing timestamp and media protobuf; cache-only mode is supported', async () => {
  const archive = new ZapoSentArchive(), cache = mockDeep<DataStore>(), store = mockDeep<WaStoreSession>()
  store.messages.getById.mockResolvedValue({ id: 'id', threadJid: '123@lid', fromMe: true, timestampMs: 1700000000000 })
  archive.capture({ id: 'id', to: '123@lid', message: { imageMessage: { directPath: '/test', mediaKey: Buffer.alloc(32) } } })
  await archive.commit('id', cache, store)
  expect(store.messages.upsert.mock.calls[0][0].timestampMs).toBe(1700000000000)
  archive.capture({ id: 'other', to: '123@lid', message: { conversation: 'text' } })
  expect(await archive.commit('other', cache)).toBe(true)
})

test('bounds pending captures and expires stale events without timers', async () => {
  const time = jest.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const archive = new ZapoSentArchive(), cache = mockDeep<DataStore>()
    for (let i = 0; i <= 100; i++) archive.capture({ id: String(i), to: '123@lid', message: { conversation: 't' } })
    expect(await archive.commit('0', cache)).toBe(false)
    time.mockReturnValue(400000)
    archive.capture({ id: 'new', to: '123@lid', message: { conversation: 't' } })
    expect(await archive.commit('100', cache)).toBe(false)
  } finally { time.mockRestore() }
})
