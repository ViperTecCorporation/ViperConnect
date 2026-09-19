jest.mock('../../src/services/transcription_reference', () => ({ loadTranscriptionReference: jest.fn(async () => undefined) }))
jest.mock('../../src/services/reply_warning_outbox', () => ({ saveReplyWarning: jest.fn(async () => undefined), completeReplyWarning: jest.fn(async () => undefined) }))
import { mockDeep } from 'jest-mock-extended'
import type { WaClient } from 'zapo-js'
import type { DataStore } from '../../src/services/data_store'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'
import { loadTranscriptionReference } from '../../src/services/transcription_reference'
import { saveReplyWarning, completeReplyWarning } from '../../src/services/reply_warning_outbox'

describe('reply reference fallback', () => {
  const setup = () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<DataStore>()
    client.message.send.mockResolvedValue({ id: 'sent' } as never)
    return { client, store, messages: new ZapoMessages(client, store, { phone: 'session' }) }
  }
  const payload = (id = 'old-uuid') => ({ to: 'group@g.us', type: 'text', text: { body: 'Resposta' }, context: { message_id: id } })
  beforeEach(() => { jest.clearAllMocks(); (loadTranscriptionReference as jest.Mock).mockResolvedValue(undefined) })
  it('sends an old unresolved UUID once, without a quote and with a warning', async () => {
    const { client, messages } = setup()
    const result = await messages.send(payload())
    expect(result.ok.warnings[0].code).toBe('REPLY_SENT_WITHOUT_QUOTE')
    expect(client.message.send).toHaveBeenCalledTimes(1)
    expect(client.message.send).toHaveBeenCalledWith('group@g.us', { type: 'text', text: 'Resposta' }, {})
  })
  it('persists a queued warning before calling WhatsApp', async () => {
    const { client, messages } = setup()
    await messages.send(payload(), { unoMessageId: 'uno-id' })
    expect(saveReplyWarning).toHaveBeenCalledWith('session', 'uno-id', expect.objectContaining({ recipientId: 'group@g.us' }))
    expect((saveReplyWarning as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(client.message.send.mock.invocationCallOrder[0])
  })
  it('does not send when warning persistence is unavailable', async () => {
    const { client, messages } = setup()
    ;(saveReplyWarning as jest.Mock).mockRejectedValueOnce(new Error('redis down'))
    await expect(messages.send(payload(), { unoMessageId: 'uno-id' })).rejects.toThrow('redis down')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  it('quotes the mapped original audio', async () => {
    const { client, store, messages } = setup()
    ;(loadTranscriptionReference as jest.Mock).mockResolvedValue('audio')
    store.loadKey.mockResolvedValue({ id: 'audio', remoteJid: 'group@g.us', fromMe: false })
    expect((await messages.send(payload('uno-transcription:test'))).ok.warnings).toBeUndefined()
    expect(client.message.send).toHaveBeenCalledWith('group@g.us', expect.anything(), expect.objectContaining({ quote: expect.objectContaining({ id: 'audio' }) }))
  })
  it('clears an obsolete warning before a retried message gains a valid quote', async () => {
    const { client, store, messages } = setup()
    store.loadKey.mockResolvedValue({ id: 'audio', remoteJid: 'group@g.us', fromMe: false })
    await messages.send(payload(), { unoMessageId: 'uno-id' })
    expect(completeReplyWarning).toHaveBeenCalledWith('session', 'uno-id')
    expect((completeReplyWarning as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(client.message.send.mock.invocationCallOrder[0])
    expect(saveReplyWarning).not.toHaveBeenCalled()
  })
  it('does not redirect a reply into another conversation', async () => {
    const { client, store, messages } = setup()
    store.loadKey.mockResolvedValue({ id: 'audio', remoteJid: 'other@g.us', fromMe: false })
    expect((await messages.send(payload())).ok.warnings).toHaveLength(1)
    expect(client.message.send.mock.calls[0][0]).toBe('group@g.us')
    expect(client.message.send.mock.calls[0][2]).not.toHaveProperty('quote')
  })
  it('preserves valid ordinary quotes', async () => {
    const { client, store, messages } = setup()
    store.loadKey.mockResolvedValue({ id: 'normal', remoteJid: 'group@g.us', fromMe: true })
    await messages.send(payload('normal'))
    expect(client.message.send.mock.calls[0][2]).toHaveProperty('quote.id', 'normal')
  })
  it('preserves media and its caption when sending without a quote', async () => {
    const { client, messages } = setup()
    const result = await messages.send({ ...payload(), type: 'image', image: { link: '/test/image.jpeg', mime_type: 'image/jpeg', caption: 'Legenda' } })
    expect(result.ok.warnings).toHaveLength(1)
    expect(client.message.send).toHaveBeenCalledWith('group@g.us', expect.objectContaining({ type: 'image', media: '/test/image.jpeg', caption: 'Legenda' }), {})
  })
  it('sends a one-to-one reply without quote when its reference is missing', async () => {
    const { client, messages } = setup()
    await messages.send({ ...payload(), to: '5511222222222' })
    expect(client.message.send.mock.calls[0][0]).toBe('5511222222222@s.whatsapp.net')
    expect(client.message.send.mock.calls[0][2]).not.toHaveProperty('quote')
  })
  it('does not resend a generic provider rejection without the quote', async () => {
    const { client, store, messages } = setup()
    store.loadKey.mockResolvedValue({ id: 'audio', remoteJid: 'group@g.us', fromMe: false })
    client.message.send.mockRejectedValue(new Error('provider rejected'))
    await expect(messages.send(payload())).rejects.toThrow('provider rejected')
    expect(client.message.send).toHaveBeenCalledTimes(1)
  })
  it('does not treat a store outage as a missing reference', async () => {
    const { client, store, messages } = setup()
    store.loadKey.mockRejectedValue(new Error('store offline'))
    await expect(messages.send(payload())).rejects.toThrow('store offline')
    expect(client.message.send).not.toHaveBeenCalled()
  })
  it('preserves errors for edits and reactions', async () => {
    const { client, messages } = setup()
    await expect(messages.send({ ...payload(), type: 'message_edit' })).rejects.toThrow('message_not_found')
    await expect(messages.send({ ...payload(), type: 'reaction', reaction: { message_id: 'old', emoji: '👍' } })).rejects.toThrow('message_not_found')
    expect(client.message.send).not.toHaveBeenCalled()
  })
})
