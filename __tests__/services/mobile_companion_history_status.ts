import { proto } from 'zapo-js'
import { applyHistoryStatus } from '../../src/services/mobile_primary/companion_history_status'
import { streamCompanionHistory } from '../../src/services/mobile_primary/companion_history_stream'
import { inflateSync } from 'node:zlib'

test.each([['sent', 2], ['delivered', 3], ['read', 4], ['played', 5], ['failed', 0], ['scheduled', undefined], [undefined, undefined]])('exports only known persisted status %s', async (status, expected) => {
  const message: proto.IWebMessageInfo = { key: { id: 'provider', fromMe: true }, message: { conversation: 'test' } }
  const loadUno = jest.fn(async () => 'uno'), loadStatus = jest.fn(async () => status as string | undefined)
  await applyHistoryStatus([{ id: '1@lid', messages: [{ message }] }], loadUno, loadStatus)
  expect(message.status).toBe(expected)
  expect(message.key!.id).toBe('provider')
  expect(loadStatus).toHaveBeenCalledWith('uno')
})

test('does not look up received messages; unmapped sends use their original ID', async () => {
  const loadUno = jest.fn(async () => undefined), loadStatus = jest.fn(async () => 'delivered')
  const incoming: proto.IWebMessageInfo = { key: { id: 'incoming', fromMe: false } }
  const outgoing: proto.IWebMessageInfo = { key: { id: 'outgoing', fromMe: true } }
  await applyHistoryStatus([{ id: '1@lid', messages: [{ message: incoming }, { message: outgoing }] }], loadUno, loadStatus)
  expect(incoming.status).toBeUndefined()
  expect(loadStatus.mock.calls).toEqual([['outgoing']])
  expect(outgoing.status).toBe(3)
})

test('lookup errors fail explicitly rather than claiming delivery', async () => {
  await expect(applyHistoryStatus([{ id: '1@lid', messages: [{ message: { key: { id: 'id', fromMe: true } } }] }],
    async () => { throw new Error('redis unavailable') }, async () => 'read')).rejects.toThrow('redis unavailable')
})

test('stream includes verified status in encoded history without changing provider ID', async () => {
  const jid = '123@lid', phone = '999123456789'
  const record = { id: 'provider', threadJid: jid, fromMe: true, timestampMs: Date.now() - 1000, messageBytes: proto.Message.encode({ conversation: 'test' }).finish() }
  const store: any = { threads: { getByJid: async () => null }, messages: { getById: async () => record } }
  const redis = { scan: async () => ({ cursor: 0, keys: [`p:msg:idx:${phone}:${jid}`] }), zRange: async (_k: string, start: number) => start ? [] : ['provider'] }
  const result = await streamCompanionHistory(store, redis, 'p:', phone, false,
    chats => applyHistoryStatus(chats, async () => 'uno', async () => 'read')).next()
  const h = proto.HistorySync.decode(inflateSync(result.value!.message.historySyncNotification!.initialHistBootstrapInlinePayload!))
  expect(h.conversations[0].messages[0].message!.status).toBe(4)
  expect(h.conversations[0].messages[0].message!.key!.id).toBe('provider')
})
