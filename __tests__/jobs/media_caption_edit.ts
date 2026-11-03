jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../src/services/reply_warning_outbox', () => ({
  ...jest.requireActual('../../src/services/reply_warning_outbox'),
  loadReplyWarning: jest.fn(async () => undefined), completeReplyWarning: jest.fn(async () => undefined),
}))

import { mock, mockDeep } from 'jest-mock-extended'
import type { WaClient } from 'zapo-js'
import { IncomingJob } from '../../src/jobs/incoming'
import { defaultConfig } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import type { Incoming } from '../../src/services/incoming'
import type { Outgoing } from '../../src/services/outgoing'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'

describe('media caption edit through the incoming worker job', () => {
  const setup = () => {
    const cache = mockDeep<DataStore>(), client = mockDeep<WaClient>(), incoming = mock<Incoming>(), outgoing = mock<Outgoing>()
    cache.loadProviderId.mockImplementation(async id => id === 'uno-original' ? 'provider-original' : undefined)
    cache.loadKey.mockResolvedValue({ id: 'provider-original', remoteJid: '123@lid', fromMe: true })
    const service = new ZapoMessages(client, cache)
    incoming.send.mockImplementation(async (_phone, payload, options) => service.send(payload, options as never))
    const job = new IncomingJob(incoming, outgoing, async () => ({ ...defaultConfig, provider: 'zapo', server: 'server_1', outgoingIdempotency: false,
      webhooks: ['https://chatwoot.example.test/webhooks/whatsapp/5511888888888', 'https://example.test/hooks']
        .map(urlAbsolute => ({ ...defaultConfig.webhooks[0], url: '', urlAbsolute, sendUpdateMessages: true, sendNewMessages: true })),
      getStore: async () => ({ dataStore: cache }) as never,
    }))
    const input = { id: 'uno-edit-event', payload: { to: '123@lid', type: 'message_edit', context: { message_id: 'uno-original' }, text: { body: 'Nova legenda' } }, options: { endpoint: 'messages' } }
    return { cache, client, outgoing, job, input }
  }
  test('reports a missing original as failed without an edit echo or SDK send', async () => {
    const { client, outgoing, job, input } = setup()
    await job.consume('5511888888888', input)
    expect(client.message.send).not.toHaveBeenCalled()
    const values = outgoing.sendHttp.mock.calls.map(call => (call[2] as any).entry[0].changes[0].value)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(value.messages || []).toHaveLength(0)
      expect(value.message_echoes || []).toHaveLength(0)
      expect(value.statuses[0]).toMatchObject({ id: 'uno-edit-event', status: 'failed', errors: [expect.objectContaining({ error_data: expect.objectContaining({ reason: 'message_edit_original_content_not_found' }) })] })
    }
  })
  test('keeps the ViperChat edit-event contract while actually giving media to the SDK', async () => {
    const { client, cache, outgoing, job, input } = setup()
    const image = { caption: 'Antiga', url: 'https://example.test/image.enc', mediaKey: new Uint8Array(32).fill(1),
      fileSha256: new Uint8Array(32).fill(2), fileEncSha256: new Uint8Array(32).fill(3), mimetype: 'image/jpeg' }
    cache.loadMessage.mockResolvedValue({ message: { imageMessage: image } })
    client.message.send.mockResolvedValue({ id: 'provider-edit' } as never)
    await job.consume('5511888888888', input)
    expect(client.message.send.mock.calls[0][1]).toHaveProperty('imageMessage.caption', 'Nova legenda')
    expect(client.message.send.mock.calls[0][2].editKey).toEqual({ id: 'provider-original' })
    const values = outgoing.sendHttp.mock.calls.map(call => (call[2] as any).entry[0].changes[0].value).filter(value => value.messages?.length || value.message_echoes?.length)
    expect(values).toHaveLength(2)
    for (const value of values) expect((value.messages || value.message_echoes)[0]).toMatchObject({ id: 'uno-edit-event', type: 'text', text: { body: 'Nova legenda' }, message_type: 'message_edit', context: { id: 'uno-original' } })
    expect(image.caption).toBe('Antiga')
  })
})
