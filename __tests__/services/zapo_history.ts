import { proto, type WaStoreSession } from 'zapo-js'
import { mockDeep } from 'jest-mock-extended'
import {
  loadZapoHistoryMessages,
  normalizeHistoryMaxAgeDays,
  toUnoHistoryMessage,
  consumeZapoHistoryBatches,
  registerZapoHistoryReader,
} from '../../src/services/zapo/zapo_history'

describe('Zapo history', () => {
  test('normalizes the configured history window', () => {
    expect(normalizeHistoryMaxAgeDays('7')).toBe(7)
    expect(normalizeHistoryMaxAgeDays(0)).toBe(30)
    expect(normalizeHistoryMaxAgeDays(50_000)).toBe(3_650)
  })

  test('decodes a stored Zapo message into the Uno listener contract', () => {
    const message = toUnoHistoryMessage({
      id: 'history-1',
      threadJid: '120363@g.us',
      senderJid: '123@lid',
      fromMe: false,
      timestampMs: 2_000,
      messageBytes: proto.Message.encode({ conversation: 'histórico' }).finish(),
    })

    expect(message).toEqual({
      key: {
        remoteJid: '120363@g.us',
        id: 'history-1',
        fromMe: false,
        participant: '123@lid',
      },
      messageTimestamp: 2,
      message: expect.objectContaining({ conversation: 'histórico' }),
    })
  })

  test('prefers the participant persisted by Zapo 1.8.1 for group history', () => {
    const message = toUnoHistoryMessage({
      id: 'history-participant-1',
      threadJid: '120363@g.us',
      senderJid: undefined,
      participantJid: '456@lid',
      fromMe: false,
      timestampMs: 3_000,
      messageBytes: proto.Message.encode({ conversation: 'com autor' }).finish(),
    })

    expect(message?.key).toEqual({
      remoteJid: '120363@g.us',
      id: 'history-participant-1',
      fromMe: false,
      participant: '456@lid',
    })
  })

  test('loads only unseen messages inside the configured day window', async () => {
    const store = mockDeep<WaStoreSession>()
    const now = Date.UTC(2026, 6, 22)
    store.threads.list.mockResolvedValue([{ jid: '123@lid' }])
    store.messages.listByThread.mockResolvedValue([
      {
        id: 'new',
        threadJid: '123@lid',
        fromMe: false,
        timestampMs: now - 2 * 24 * 60 * 60 * 1_000,
        messageBytes: proto.Message.encode({ conversation: 'nova' }).finish(),
      },
      {
        id: 'old',
        threadJid: '123@lid',
        fromMe: false,
        timestampMs: now - 10 * 24 * 60 * 60 * 1_000,
        messageBytes: proto.Message.encode({ conversation: 'antiga' }).finish(),
      },
    ])

    const seen = new Set(['already-seen'])
    const messages = await loadZapoHistoryMessages(store, 7, seen, now)

    expect(messages.map((message) => message.key.id)).toEqual(['new'])
    expect(seen).toEqual(new Set(['already-seen']))
  })

  test('the official Redis-style timestamp traversal is unchanged while delivery callbacks stay at 200', async () => {
    const store = mockDeep<WaStoreSession>(), now = Date.now(), sizes: number[] = []
    const records = Array.from({ length: 1205 }, (_, i) => ({ id: `redis-${i}`, threadJid: '123@lid', fromMe: false, timestampMs: now - i - 1, messageBytes: proto.Message.encode({ conversation: 'synthetic' }).finish() }))
    store.threads.list.mockResolvedValue([{ jid: '123@lid' }])
    store.messages.listByThread.mockResolvedValueOnce(records.slice(0, 1000)).mockResolvedValueOnce(records.slice(1000))
    const ids: string[] = []
    expect(await consumeZapoHistoryBatches(store, 7, async batch => { sizes.push(batch.length); ids.push(...batch.map(message => message.key.id)) }, [], now)).toBe(1205)
    expect(sizes).toEqual([200, 200, 200, 200, 200, 200, 5])
    expect(ids).toEqual([...records].sort((left, right) => Math.floor(left.timestampMs / 1000) - Math.floor(right.timestampMs / 1000)).map(record => record.id))
    expect(store.threads.list).toHaveBeenCalledWith(10000)
    expect(store.messages.listByThread.mock.calls).toEqual([['123@lid', 1000, undefined], ['123@lid', 1000, records[999].timestampMs]])
  })

  test('internal oversized pages and non-advancing cursors are explicit errors, never truncation or infinite retry', async () => {
    const store = mockDeep<WaStoreSession>(), now = Date.now(), consume = jest.fn()
    const record = { id: 'same', threadJid: '123@lid', fromMe: false, timestampMs: now, messageBytes: proto.Message.encode({ conversation: 'synthetic' }).finish() }
    registerZapoHistoryReader(store, async () => ({ records: Array(201).fill(record) }))
    await expect(consumeZapoHistoryBatches(store, 7, consume, [], now)).rejects.toThrow('page_too_large')
    expect(consume).not.toHaveBeenCalled()
    registerZapoHistoryReader(store, async () => ({ records: [], next: { timestampMs: now, id: 'same' } }))
    await expect(consumeZapoHistoryBatches(store, 7, consume, [], now)).rejects.toThrow('cursor_not_advancing')
  })
})
