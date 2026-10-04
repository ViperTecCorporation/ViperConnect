import { mockDeep } from 'jest-mock-extended'
import type Redis from 'ioredis'
import { SessionMessages, messagePageLimit, decodeMessageCursor, authorizedSessionMessages, strongestMessageStatus } from '../../src/services/messages/session_messages'
import { SessionMessageIndex } from '../../src/services/messages/session_message_index'
import { managerIdentity } from '../../src/services/manager_identity'
import { defaultConfig } from '../../src/services/config'
import { proto } from 'zapo-js'

jest.mock('../../src/services/manager_identity', () => ({ managerIdentity: { authenticate: jest.fn() } }))
jest.mock('../../src/services/zapo/zapo_store_registry', () => ({ zapoStoreRegistry: { get: jest.fn() } }))

const phone = '5511999999999'; const jid = '123@lid'
const setup = () => {
  const redis = mockDeep<Redis>()
  const index = new SessionMessageIndex(redis, 'test:')
  const service = new SessionMessages(jest.fn().mockResolvedValue({ ...defaultConfig, provider: 'zapo', useRedis: true }))
  jest.spyOn(service, 'index').mockResolvedValue(index)
  jest.spyOn(index, 'ensure').mockResolvedValue(true)
  const pipeline: any = { get: jest.fn().mockReturnThis(), hgetall: jest.fn().mockReturnThis(), getBuffer: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) }
  redis.pipeline.mockReturnValue(pipeline)
  redis.zrevrange.mockResolvedValue([])
  return { redis, index, service, pipeline }
}
describe('session messages bounded queries', () => {
  test('group subjects participate in sidebar name search', async () => {
    const { service, pipeline, redis } = setup()
    redis.zrevrange.mockResolvedValueOnce(['123@g.us']).mockResolvedValue([])
    pipeline.exec.mockResolvedValueOnce([[null, JSON.stringify({ timestamp_ms: Date.now(), id: '123@g.us' })], [null, {}], [null, {}]])
      .mockResolvedValueOnce([[null, JSON.stringify({ subject: 'Equipe Viper' })]])
    expect((await service.conversations(phone, { kind: 'group', search: 'viper' })).data[0].name).toBe('Equipe Viper')
  })
  test('enriches group sender without changing original identity', async () => {
    const { service, index, pipeline } = setup()
    jest.spyOn(index, 'records').mockImplementation(async (_phone, ids) => ids.length ? [{ id: 'ABC', threadJid: '123@g.us', participantJid: '456:17@lid', fromMe: false, timestampMs: Date.now() }] : [])
    pipeline.exec.mockResolvedValueOnce([[null, null], [null, null]])
      .mockResolvedValueOnce([[null, null], [null, null]])
      .mockResolvedValueOnce([[null, '{"subject":"Team"}']])
      .mockResolvedValueOnce([[null, { display_name: 'Ana' }], [null, null], [null, null], [null, null]])
    expect((await service.messages(phone, '123@g.us', { ids: ['ABC'] })).data[0]).toMatchObject({ sender: '456:17@lid', sender_name: 'Ana' })
  })
  test('selects strongest known state without fabricating confirmation', () => {
    expect(strongestMessageStatus('delivered', 'read', 'sent')).toBe('read')
    expect(strongestMessageStatus(undefined, 'unknown')).toBeUndefined()
  })
  test('loads historical statuses by both provider and mapped Uno IDs', async () => {
    const { service, index, pipeline } = setup()
    jest.spyOn(index, 'records').mockImplementation(async (_phone, ids) => ids.length ? [{ id: 'ABC', threadJid: jid, fromMe: true, timestampMs: Date.now() }] : [])
    pipeline.exec.mockResolvedValueOnce([[null, 'UNO'], [null, JSON.stringify({ status: 'delivered' })]]).mockResolvedValueOnce([[null, 'read'], [null, 'sent']])
    expect((await service.messages(phone, jid, { ids: ['ABC'] })).data[0].status).toBe('read')
    expect(pipeline.get).toHaveBeenCalledWith(`unoapi-message-status:${phone}:UNO`)
  })
  test('around loads a bounded window and rejects missing or cross-thread originals', async () => {
    const { service, index, redis } = setup()
    redis.zrevrank.mockResolvedValue(150); redis.zrevrange.mockResolvedValueOnce(['ABC']).mockResolvedValueOnce([])
    jest.spyOn(index, 'records').mockImplementation(async (_phone, ids) => ids.map(id => ({ id, threadJid: jid, fromMe: false })))
    await service.messages(phone, jid, { around: 'ABC', limit: 50 })
    expect(redis.zrevrange).toHaveBeenCalledWith(`test:msg:idx:${phone}:${jid}`, 125, 174)
    expect(redis.scan).not.toHaveBeenCalled()
    redis.zrevrank.mockResolvedValue(null)
    await expect(service.messages(phone, jid, { around: 'gone' })).rejects.toThrow('quoted_message_not_available')
    await expect(service.messages(phone, jid, { around: '../bad' })).rejects.toThrow('invalid_message_around')
  })
  test('resolves previews only from the same conversation and normalizes cached phone JIDs', async () => {
    const { service, index, pipeline, redis } = setup()
    jest.spyOn(index, 'records').mockImplementation(async (_phone, ids) => ids.map(id => ({ id, threadJid: id === 'original' ? '999@lid' : jid, fromMe: false,
      messageBytes: proto.Message.encode({ extendedTextMessage: { text: 'Reply', contextInfo: { stanzaId: 'original', quotedMessage: { conversation: 'Embedded preview' } } } }).finish() })))
    const page = await service.messages(phone, jid, { ids: ['reply'] })
    expect(page.data[0].reply_preview).toMatchObject({ text: 'Embedded preview', available: false })
    redis.zrevrange.mockResolvedValueOnce([jid]).mockResolvedValueOnce([])
    pipeline.exec.mockResolvedValue([[null, JSON.stringify({ id: jid, timestamp_ms: Date.now() })], [null, {}], [null, { phone_number: '556696269251@s.whatsapp.net' }]])
    expect((await service.conversations(phone, {})).data[0].phone_number).toBe('5566996269251')
  })
  test('limit is bounded and invalid values use defaults', () => {
    expect(messagePageLimit(500, 30)).toBe(100); expect(messagePageLimit(-1, 30)).toBe(1); expect(messagePageLimit(NaN, 50)).toBe(50)
  })
  test('cursor is strict and tied to phone/thread/filter', () => {
    expect(() => decodeMessageCursor('nonsense', 'scope')).toThrow('invalid_message_cursor')
    const cursor = Buffer.from(JSON.stringify({ scope: 'other', id: 'a', score: '1' })).toString('base64url')
    expect(() => decodeMessageCursor(cursor, 'scope')).toThrow('invalid_message_cursor')
  })
  test('same timestamp pagination uses rank/id, not timestamp minus one', async () => {
    const { redis, service, index } = setup()
    const now = Date.now()
    redis.zrevrange.mockResolvedValueOnce(['c', 'b']).mockResolvedValueOnce(['a'])
    redis.zscore.mockResolvedValue(String(now))
    jest.spyOn(index, 'records').mockImplementation(async (_phone, ids) => ids.map(id => ({ id, threadJid: jid, fromMe: false, timestampMs: now, messageBytes: proto.Message.encode({ conversation: id }).finish() })))
    const first = await service.messages(phone, jid, { limit: 2 })
    expect(first.data.map(item => item.id)).toEqual(['c', 'b']); expect(first.has_more).toBe(true)
    redis.zrevrank.mockResolvedValue(1)
    redis.zrevrange.mockResolvedValueOnce(['a']).mockResolvedValueOnce([])
    const next = await service.messages(phone, jid, { limit: 2, cursor: first.next_cursor! })
    expect(next.data.map(item => item.id)).toEqual(['a'])
    expect(redis.zrevrange).toHaveBeenCalledWith('test:msg:idx:5511999999999:123@lid', 2, 3)
    expect(redis.scan).not.toHaveBeenCalled(); expect(redis.keys).not.toHaveBeenCalled(); expect(redis.pexpire).not.toHaveBeenCalled()
  })
  test('expired/moved cursor requires explicit reload', async () => {
    const { redis, service } = setup()
    const cursor = Buffer.from(JSON.stringify({ scope: `${phone}:messages:${jid}`, id: 'gone', score: '1' })).toString('base64url')
    redis.zrevrank.mockResolvedValue(null); redis.zscore.mockResolvedValue(null)
    await expect(service.messages(phone, jid, { cursor })).rejects.toThrow('message_cursor_expired_reload')
  })
  test('ID delta never returns messages from another thread', async () => {
    const { index, service } = setup()
    jest.spyOn(index, 'records').mockResolvedValue([{ id: 'secret', threadJid: '999@lid', fromMe: false, timestampMs: Date.now() }])
    expect((await service.messages(phone, jid, { ids: ['secret'] })).data).toEqual([])
  })
  test('invalid IDs, broadcast and short search are rejected', async () => {
    const { service } = setup()
    await expect(service.messages(phone, 'status@broadcast', {})).rejects.toThrow('invalid_conversation_id')
    await expect(service.messages(phone, jid, { ids: ['*'] })).rejects.toThrow('invalid_message_ids')
    await expect(service.conversations(phone, { search: 'ab' })).rejects.toThrow('message_search_requires')
    await expect(service.conversations(phone, { kind: 'invalid' })).rejects.toThrow('invalid_conversation_kind')
  })
  test('summary/contact/thread retrieval is pipelined and capped at 200', async () => {
    const { redis, service, pipeline } = setup()
    redis.zrevrange.mockResolvedValueOnce([jid]).mockResolvedValueOnce([])
    pipeline.exec.mockResolvedValue([[null, JSON.stringify({ id: jid, timestamp_ms: Date.now(), preview: 'test', last_message_id: 'a' })], [null, {}], [null, { display_name: 'Ana', phone_number: '5511222333444' }]])
    redis.zscore.mockResolvedValue('123')
    const page = await service.conversations(phone, { search: 'ana' })
    expect(page.data[0]).toMatchObject({ name: 'Ana', kind: 'direct' })
    expect(redis.zrevrange).toHaveBeenCalledWith('test:panel:5511999999999:conversations', 0, 199)
    expect(pipeline.exec).toHaveBeenCalledTimes(1)
    expect(redis.scan).not.toHaveBeenCalled(); expect(redis.keys).not.toHaveBeenCalled()
  })
  test('no authorization for empty token, invalid phone or revoked assignment', async () => {
    const load = jest.fn().mockResolvedValue({ authToken: 'session-key' })
    expect(await authorizedSessionMessages('', phone, load)).toBe(false)
    expect(await authorizedSessionMessages('session-key', '*', load)).toBe(false)
    expect(await authorizedSessionMessages('session-key', phone, load)).toBe(true)
    expect(await authorizedSessionMessages('wrong-key', phone, load)).toBe(false)
    jest.mocked(managerIdentity.authenticate).mockResolvedValue({ role: 'user', phones: ['999999999999'] } as any)
    expect(await authorizedSessionMessages('mgr_key_test', phone, load)).toBe(false)
    jest.mocked(managerIdentity.authenticate).mockResolvedValue({ role: 'user', phones: [phone] } as any)
    expect(await authorizedSessionMessages('mgr_key_test', phone, load)).toBe(true)
    jest.mocked(managerIdentity.authenticate).mockResolvedValue(undefined)
    expect(await authorizedSessionMessages('mgr_key_test', phone, load)).toBe(false)
  })
})
