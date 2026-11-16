jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../src/services/messages/session_message_status', () => ({ recordSessionWebhookStatuses: jest.fn().mockResolvedValue(undefined) }))
import { mock } from 'jest-mock-extended'
import { IncomingJob } from '../../src/jobs/incoming'
import type { Incoming } from '../../src/services/incoming'
import type { Outgoing } from '../../src/services/outgoing'
import type { DataStore } from '../../src/services/data_store'
import { defaultConfig } from '../../src/services/config'
import { recordSessionWebhookStatuses } from '../../src/services/messages/session_message_status'
import { UNOAPI_SERVER_NAME } from '../../src/defaults'

beforeEach(() => jest.clearAllMocks())

test.each([false, true])('confirmed provider send records local sent state even with webhooks=%s', async enabled => {
  const incoming = mock<Incoming>(), outgoing = mock<Outgoing>(), dataStore = mock<DataStore>()
  dataStore.loadProviderId.mockResolvedValue('NATIVE_ID'); dataStore.setUnoId.mockResolvedValue('PUBLIC_ID')
  incoming.send.mockResolvedValue({ ok: { messages: [{ id: 'PUBLIC_ID' }] } })
  const config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, outgoingIdempotency: true,
    webhooks: enabled ? [{ ...defaultConfig.webhooks[0], enabled: true, urlAbsolute: 'https://lab.invalid/webhook' }] : [],
    getStore: async () => ({ dataStore }) as any }
  await new IncomingJob(incoming, outgoing, async () => config).consume('5566000000111', {
    id: 'PUBLIC_ID', payload: { to: '5566000000222', type: 'text', text: { body: 'synthetic' } }, options: {},
  })
  expect(incoming.send).toHaveBeenCalledTimes(1)
  expect(recordSessionWebhookStatuses).toHaveBeenCalledTimes(1)
  const [phone, payload, selected] = (recordSessionWebhookStatuses as jest.Mock).mock.calls[0]
  expect(phone).toBe('5566000000111'); expect(selected).toBe(config)
  expect(payload.entry[0].changes[0].value.statuses[0]).toMatchObject({ id: 'PUBLIC_ID', provider_message_id: 'NATIVE_ID', status: 'sent' })
})

test('status failure after provider ACK is repaired on redelivery without another network send', async () => {
  const incoming = mock<Incoming>(), outgoing = mock<Outgoing>(), dataStore = mock<DataStore>()
  let committed = false
  dataStore.loadKey.mockImplementation(async () => committed ? { id: 'NATIVE_ID', remoteJid: '111@lid', fromMe: true } : undefined)
  dataStore.loadProviderId.mockResolvedValue('NATIVE_ID'); dataStore.setUnoId.mockResolvedValue('PUBLIC_ID')
  incoming.send.mockImplementation(async () => { committed = true; return { ok: { messages: [{ id: 'PUBLIC_ID' }] } } })
  ;(recordSessionWebhookStatuses as jest.Mock).mockRejectedValueOnce(new Error('projection_unavailable')).mockResolvedValue(undefined)
  const config = { ...defaultConfig, provider: 'zapo' as const, server: UNOAPI_SERVER_NAME, outgoingIdempotency: true, webhooks: [], getStore: async () => ({ dataStore }) as any }
  const job = new IncomingJob(incoming, outgoing, async () => config)
  const envelope = { id: 'PUBLIC_ID', payload: { to: '5566000000222', type: 'text', text: { body: 'synthetic' } }, options: {} }
  await expect(job.consume('5566000000111', envelope)).rejects.toThrow('projection_unavailable')
  await expect(job.consume('5566000000111', envelope)).resolves.toMatchObject({ ok: { idempotent: true } })
  expect(incoming.send).toHaveBeenCalledTimes(1)
  expect(recordSessionWebhookStatuses).toHaveBeenCalledTimes(2)
  expect((recordSessionWebhookStatuses as jest.Mock).mock.calls[1][1].entry[0].changes[0].value.statuses[0]).toEqual({ id: 'PUBLIC_ID', status: 'sent' })
})
