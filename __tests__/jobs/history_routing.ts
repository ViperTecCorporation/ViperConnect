jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn() }))
jest.mock('../../src/services/redis', () => ({ getConfig: jest.fn(async () => ({ provider: 'zapo' })) }))
import { amqpPublish } from '../../src/amqp'
import { ListenerAmqp } from '../../src/services/listener_amqp'
import { ListenerJob } from '../../src/jobs/listener'
import { OutgoingAmqp } from '../../src/services/outgoing_amqp'
import { OutgoingJob } from '../../src/jobs/outgoing'
import { isHistoryQueue, withHistoryQueue } from '../../src/services/history_queue_context'
import { packWaMessage, unpackWaMessage } from '../../src/services/wa_message_envelope'
import { UNOAPI_QUEUE_HISTORY_OUTGOING, UNOAPI_SERVER_NAME } from '../../src/defaults'

const phone = '5566999999999'
const webhook = { id: 'test', url: 'https://example.test/webhook', enabled: true, sendTranscribeAudio: true }
const config = jest.fn().mockResolvedValue({ provider: 'zapo', server: UNOAPI_SERVER_NAME, webhooks: [webhook] })
const message = { key: { id: 'id', remoteJid: '123@lid', fromMe: false }, message: { conversation: 'hello' } }
const payload = { entry: [{ changes: [{ value: { messages: [{ id: 'id', from: '551234567890', type: 'text', text: { body: 'hello' } }] } }] }] }
beforeEach(() => { jest.clearAllMocks(); (amqpPublish as jest.Mock).mockResolvedValue(undefined) })

test.each(['history', 'notify', 'message', 'append', 'update', 'delete', 'status', 'qrcode'] as const)(
  'producer only changes destination for %s, preserving envelope and options', async type => {
    await new ListenerAmqp('zapo').process(phone, [message], type)
    const [exchange, queue, routing, data, options] = (amqpPublish as jest.Mock).mock.calls[0]
    expect(exchange).toBe(type === 'history' ? 'unoapi.broker' : 'unoapi.brigde')
    expect(queue).toBe(`unoapi.${type === 'history' ? 'history' : 'listener'}.server_1.zapo`)
    expect(routing).toBe(phone)
    expect(data.type).toBe(type)
    expect(options.type).toBe(type === 'history' ? 'topic' : 'direct')
    expect(data.messages).toHaveLength(1)
    if (['history', 'notify', 'message', 'append', 'qrcode'].includes(type)) {
      expect(unpackWaMessage(data.messages[0]).key?.id).toBe('id')
    } else expect(data.messages).toEqual([message])
    // Historical priority/delay semantics intentionally unchanged in this queue-only change.
    expect(options.priority).toBe(type === 'status' || type === 'update' || type === 'delete' ? 3 : 5)
  },
)

test.each([true, false])('old history envelope splited=%s transfers unchanged without processing, preserving retry budget', async splited => {
  const listener = { process: jest.fn() }
  const job = new ListenerJob(listener as never, {} as never, config)
  const data = { messages: [packWaMessage(message)], type: 'history', splited }
  const snapshot = JSON.stringify(data)
  await job.consume(phone, data, { countRetries: 3, maxRetries: 7, priority: 0 })
  expect(listener.process).not.toHaveBeenCalled()
  expect(amqpPublish).toHaveBeenCalledWith('unoapi.broker', 'unoapi.history.server_1.zapo', phone, data,
    { type: 'topic', countRetries: 2, maxRetries: 7 })
  expect(JSON.stringify(data)).toBe(snapshot)
  ;(amqpPublish as jest.Mock).mockRejectedValueOnce(new Error('broker unavailable'))
  await expect(job.consume(phone, data)).rejects.toThrow('broker unavailable')
  expect(listener.process).not.toHaveBeenCalled()
})

test.each(['history', 'notify'])('splitter keeps all 4922 messages in the correct queue: %s', async type => {
  const job = new ListenerJob({ process: jest.fn() } as never, {} as never, config, true)
  const messages = Array.from({ length: 4922 }, (_, i) => packWaMessage({ ...message, key: { ...message.key, id: `${i}` } }))
  await job.consume(phone, { messages, type })
  expect(amqpPublish).toHaveBeenCalledTimes(4922)
  for (const call of (amqpPublish as jest.Mock).mock.calls) {
    expect(call.slice(0, 3)).toEqual(type === 'history'
      ? ['unoapi.broker', 'unoapi.history.server_1.zapo', phone]
      : ['unoapi.brigde', 'unoapi.listener.server_1.zapo', phone])
    expect(call[3].splited).toBe(true)
  }
  expect(new Set((amqpPublish as jest.Mock).mock.calls.map(c => unpackWaMessage(c[3].messages[0]).key?.id)).size).toBe(4922)
})

test('same handler and same webhook payload run on history, without leaking history into concurrent live events', async () => {
  const outgoing = new OutgoingAmqp(config)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const listener = { process: jest.fn(async (_phone, _messages, type) => {
    if (type === 'history') await pending
    expect(isHistoryQueue()).toBe(type === 'history')
    await outgoing.send(phone, payload)
  }) }
  const history = new ListenerJob(listener as never, {} as never, config, true)
  const live = new ListenerJob(listener as never, {} as never, config)
  const packed = packWaMessage(message)
  const work = history.consume(phone, { messages: [packed], type: 'history', splited: true })
  await live.consume(phone, { messages: [packed], type: 'notify', splited: true })
  expect((amqpPublish as jest.Mock).mock.calls[0][1]).toBe('unoapi.outgoing')
  release()
  await work
  const calls = (amqpPublish as jest.Mock).mock.calls
  expect(calls[1][1]).toBe('unoapi.outgoing.history')
  expect(calls[1][3]).toEqual(calls[0][3])
  expect(calls[1][3].payload).toEqual(payload)
  expect(isHistoryQueue()).toBe(false)
})

test('history processing error leaves original envelope retry-safe', async () => {
  const data = { messages: [packWaMessage(message)], type: 'history', splited: true }
  const snapshot = JSON.stringify(data)
  const job = new ListenerJob({ process: jest.fn().mockRejectedValue(new Error('media failed')) } as never, {} as never, config, true)
  await expect(job.consume(phone, data)).rejects.toThrow('media failed')
  expect(JSON.stringify(data)).toBe(snapshot)
  expect(isHistoryQueue()).toBe(false)
})

test.each([false, true])('webhook fan-out and transcription remain in their own lane: history=%s', async history => {
  const service = { sendHttp: jest.fn() }
  const job = history ? new OutgoingJob(config, service as never, UNOAPI_QUEUE_HISTORY_OUTGOING) : new OutgoingJob(config, service as never)
  const audio = { entry: [{ changes: [{ value: { messages: [{ id: 'id', type: 'audio', audio: { id: 'media' } }] } }] }] }
  await job.consume(phone, { payload: audio, webhooks: [webhook] })
  const calls = (amqpPublish as jest.Mock).mock.calls
  expect(calls[0][1]).toBe(history ? 'unoapi.outgoing.history' : 'unoapi.outgoing')
  expect(calls[1][1]).toBe(history ? 'unoapi.transcribe.history' : 'unoapi.transcribe')
  expect(calls[0][3]).toEqual({ payload: audio, webhook })
  await job.consume(phone, { payload, webhook })
  expect(service.sendHttp).toHaveBeenCalledWith(phone, webhook, payload, {})
})

test('sendHttp and formatAndSend preserve payload and options in history context', async () => {
  const outgoing = new OutgoingAmqp(config)
  await withHistoryQueue(() => outgoing.sendHttp(phone, webhook as never, payload, { countRetries: 2, maxRetries: 5, delay: 1000 }))
  expect(amqpPublish).toHaveBeenLastCalledWith('unoapi.broker', 'unoapi.outgoing.history', phone,
    { webhook, payload, split: false }, { type: 'topic', countRetries: 2, maxRetries: 5, delay: 1000 })
  await withHistoryQueue(() => outgoing.formatAndSend(phone, '551234567890', { messages: [] }))
  expect((amqpPublish as jest.Mock).mock.calls[1][1]).toBe('unoapi.outgoing.history')
})

test('wrong-server events keep the existing discard behavior', async () => {
  const listener = { process: jest.fn() }
  const job = new ListenerJob(listener as never, {} as never, jest.fn().mockResolvedValue({ server: 'other', provider: 'zapo' }), true)
  await job.consume(phone, { messages: [message], type: 'history' })
  expect(amqpPublish).not.toHaveBeenCalled()
  expect(listener.process).not.toHaveBeenCalled()
})
