// Regression contracts for the four issues discovered during the pre-release audit.
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))

import { mock } from 'jest-mock-extended'
import { IncomingJob } from '../../src/jobs/incoming'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { DataStore } from '../../src/services/data_store'
import { defaultConfig } from '../../src/services/config'
import { amqpPublish } from '../../src/amqp'
import { apiMessage } from '../../src/services/api_messages'
import { localizeApiError } from '../../src/services/api_error_localization'
import { transcriptionId } from '../../src/services/transcription_reference'
import { getRedis } from '../../src/services/redis'
import { saveReplyWarning } from '../../src/services/reply_warning_outbox'

describe('reply contract regression tests', () => {
  const records = new Map<string, string>()
  beforeEach(() => {
    jest.clearAllMocks()
    records.clear()
    ;(getRedis as jest.Mock).mockResolvedValue({
      set: async (key: string, value: string) => records.set(key, value),
      get: async (key: string) => records.get(key),
      del: async (key: string) => records.delete(key),
    })
  })

  it('preserves the textual error identifier separately from the Portuguese message', () => {
    const output = localizeApiError({ error: 'contact_directory_requires_zapo_provider' })
    expect(output.error).toBe('O diretório de contatos está disponível apenas para sessões Zapo.')
    expect(output.error_code).toBe('contact_directory_requires_zapo_provider')
  })

  it('translates catalogued English messages into the requested language', () => {
    const english = 'Could not find the recipient WhatsApp identifier. Check the number and try again.'
    const portuguese = apiMessage(english, 'pt-BR')
    expect(portuguese).toContain('Não foi possível localizar')
    expect(apiMessage(portuguese, 'en')).toBe(english)
  })

  it('keeps the same transcription ID across PN and LID aliases', () => {
    expect(transcriptionId('session', '5511999999999', 'same-audio'))
      .toBe(transcriptionId('session', '123456789@lid', 'same-audio'))
  })

  it.each(['broker', 'webhook', 'redis', 'key', 'status'])('replays the pending warning even when replay fails at %s, without resending to WhatsApp', async failure => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    let sent = false
    dataStore.loadKey.mockImplementation(async () => sent ? { id: 'provider-id', remoteJid: '5511888888888@s.whatsapp.net', fromMe: true } : undefined)
    incoming.send.mockImplementation(async () => {
      await saveReplyWarning('5511777777777', 'uno-id', { recipientId: '5511888888888', timestamp: '100', warnings: [{ code: 'REPLY_SENT_WITHOUT_QUOTE', message: 'Aviso' }] })
      sent = true
      return { ok: { messages: [{ id: 'provider-id' }], warnings: [{ code: 'REPLY_SENT_WITHOUT_QUOTE', message: 'Aviso' }] } }
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      server: 'server_1', provider: 'zapo', outgoingIdempotency: true,
      webhooks: [{ ...defaultConfig.webhooks[0], sendNewMessages: false, sendUpdateMessages: true }],
      getStore: async () => ({ dataStore }) as any,
    }))
    const request = { id: 'uno-id', payload: { to: '5511888888888', type: 'text', text: { body: 'Resposta' }, context: { message_id: 'old-uuid' } } }
    ;(amqpPublish as jest.Mock).mockRejectedValueOnce(new Error('broker unavailable'))
    await expect(job.consume('5511777777777', request)).rejects.toThrow('broker unavailable')
    if (failure === 'broker') (amqpPublish as jest.Mock).mockRejectedValueOnce(new Error('replay failed'))
    if (failure === 'webhook') outgoing.sendHttp.mockRejectedValueOnce(new Error('replay failed'))
    if (failure === 'redis') (getRedis as jest.Mock).mockRejectedValueOnce(new Error('replay failed'))
    if (failure === 'key') dataStore.loadKey.mockRejectedValueOnce(new Error('replay failed'))
    if (failure === 'status') dataStore.loadStatus.mockRejectedValueOnce(new Error('replay failed'))
    await expect(job.consume('5511777777777', request)).rejects.toThrow('replay failed')
    expect(records.size).toBe(1)
    await expect(job.consume('5511777777777', request)).resolves.toEqual({ ok: { success: true, idempotent: true } })
    expect(incoming.send).toHaveBeenCalledTimes(1)
    expect(outgoing.sendHttp).toHaveBeenCalledTimes(failure === 'webhook' ? 2 : 1)
    expect((outgoing.sendHttp as jest.Mock).mock.calls[0][2].entry[0].changes[0].value.statuses[0])
      .toEqual(expect.objectContaining({ id: 'uno-id', status: 'sent', warnings: [{ code: 'REPLY_SENT_WITHOUT_QUOTE', message: 'Aviso' }] }))
    expect(records.size).toBe(0)
  })
})
