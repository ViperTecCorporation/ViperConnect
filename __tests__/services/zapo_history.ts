import { proto, type WaStoreSession } from 'zapo-js'
import { mockDeep } from 'jest-mock-extended'
import {
  loadZapoHistoryMessages,
  normalizeHistoryMaxAgeDays,
  toUnoHistoryMessage,
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
})
