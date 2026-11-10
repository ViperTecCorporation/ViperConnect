jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn() }))
jest.mock('node-fetch', () => jest.fn())
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('../../src/services/redis', () => ({
  getConfig: jest.fn(), isWebhookCircuitOpen: jest.fn(), isWebhookCircuitRecovering: jest.fn(),
  acquireWebhookCircuitProbe: jest.fn(), openWebhookCircuit: jest.fn(), closeWebhookCircuit: jest.fn(), bumpWebhookCircuitFailure: jest.fn(),
}))
jest.mock('../../src/defaults', () => ({ ...jest.requireActual('../../src/defaults'), WEBHOOK_CB_ENABLED: true, WEBHOOK_CB_FAILURE_THRESHOLD: 1 }))
jest.mock('../../src/utils/media_to_buffer', () => ({ __esModule: true, default: jest.fn(async () => ({ buffer: Buffer.from('synthetic'), link: 'audio.ogg', mimeType: 'audio/ogg' })) }))
jest.mock('openai', () => ({ __esModule: true, default: jest.fn(), toFile: jest.fn(async () => new Blob(['synthetic'])) }))
jest.mock('../../src/services/transcription_reference', () => ({ saveTranscriptionReference: jest.fn(async () => 'transcription-id') }))

import fetch from 'node-fetch'
import OpenAI from 'openai'
import { amqpPublish } from '../../src/amqp'
import { defaultConfig, type Webhook } from '../../src/services/config'
import * as redis from '../../src/services/redis'
import { currentQueuedWebhooks, readWebhookBindings, WebhookBindingReadError } from '../../src/services/queued_webhook'
import { OutgoingJob } from '../../src/jobs/outgoing'
import { OutgoingCloudApi } from '../../src/services/outgoing_cloud_api'
import { TranscriberJob } from '../../src/jobs/transcriber'
import mediaToBuffer from '../../src/utils/media_to_buffer'
import { saveTranscriptionReference } from '../../src/services/transcription_reference'
import logger from '../../src/services/logger'

const phone = '5566996222471'
const hook = (): Webhook => ({ ...defaultConfig.webhooks[0], id: 'vipererp-status-dev-v1',
  url: '', urlAbsolute: 'https://example.test/status?key=secret', enabled: true, sendTranscribeAudio: true })
const payload = () => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phone },
  messages: [{ id: 'audio-id', from: '5511888888888', type: 'audio', timestamp: '100', audio: { id: 'audio.ogg' } }] } }] }] })
let stored: any
const read = redis.getConfig as jest.Mock
beforeEach(() => {
  jest.resetAllMocks()
  stored = { ...defaultConfig, webhooks: [hook()] }
  read.mockImplementation(async () => stored)
  ;(redis.isWebhookCircuitOpen as jest.Mock).mockResolvedValue(false)
  ;(redis.isWebhookCircuitRecovering as jest.Mock).mockResolvedValue(false)
  ;(redis.bumpWebhookCircuitFailure as jest.Mock).mockResolvedValue(1)
  ;(fetch as unknown as jest.Mock).mockResolvedValue({ ok: true, status: 200 })
  ;(mediaToBuffer as jest.Mock).mockResolvedValue({ buffer: Buffer.from('synthetic'), link: 'audio.ogg', mimeType: 'audio/ogg' })
  ;(saveTranscriptionReference as jest.Mock).mockResolvedValue('transcription-id')
})

test('raw Redis read does not revive an explicitly empty binding list', async () => {
  stored.webhooks = []
  expect(await readWebhookBindings(phone)).toEqual([])
  stored = undefined
  expect(await readWebhookBindings(phone)).toEqual([])
})
test('only sessions without an explicit webhook list may inherit the environment default', async () => {
  stored = {}
  expect((await readWebhookBindings(phone))[0].id).toBe('default')
  stored.webhooks = 'invalid'
  expect(await readWebhookBindings(phone)).toEqual([])
})
test('ambiguous duplicate IDs and missing targets are rejected without exposing URL secrets', () => {
  expect(currentQueuedWebhooks(phone, [hook()], [hook(), hook()])).toEqual([])
  expect(currentQueuedWebhooks(phone, [{ ...hook(), urlAbsolute: '' }], [hook()])).toEqual([])
  expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('secret')
})

describe.each(['unoapi.outgoing', 'unoapi.outgoing.history'])('%s binding lifecycle', queue => {
  const job = (send = jest.fn()) => ({ send, worker: new OutgoingJob(jest.fn(async () => ({ ...defaultConfig })) as any, { sendHttp: send } as any, queue) })
  test.each(['removed', 'disabled', 'legacy-disabled', 'changed-url', 'other-id', 'deleted-session'])('ACK-compatible return without delivery for %s', async change => {
    if (change === 'removed') stored.webhooks = []
    if (change === 'disabled') stored.webhooks[0].enabled = false
    if (change === 'legacy-disabled') stored.webhooks[0].disabled = true
    if (change === 'changed-url') stored.webhooks[0].urlAbsolute = 'https://replacement.test/status'
    if (change === 'other-id') stored.webhooks[0].id = 'different'
    if (change === 'deleted-session') stored = undefined
    const { send, worker } = job()
    await expect(worker.consume(phone, { payload: payload(), webhook: hook() })).resolves.toBeUndefined()
    await expect(worker.consume(phone, { payload: payload(), webhooks: [hook()] })).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled(); expect(amqpPublish).not.toHaveBeenCalled()
  })
  test('valid binding retains payload and uses current credentials and filters', async () => {
    const stale = hook(), input = payload(), before = JSON.stringify(input)
    stored.webhooks[0] = { ...hook(), token: 'new-token', timeoutMs: 1234, sendIncomingMessages: false }
    const { send, worker } = job()
    await worker.consume(phone, { payload: input, webhook: stale })
    expect(send).toHaveBeenCalledWith(phone, expect.objectContaining({ token: 'new-token', timeoutMs: 1234, sendIncomingMessages: false }), input, {})
    expect(JSON.stringify(input)).toBe(before); expect(stale.token).not.toBe('new-token')
  })
  test('fanout never adds new recipients; removed destinations do not reach transcription', async () => {
    stored.webhooks = [{ ...hook(), id: 'keep' }, { ...hook(), id: 'new' }]
    await job().worker.consume(phone, { payload: payload(), webhooks: [hook(), { ...hook(), id: 'keep' }] })
    expect(amqpPublish).toHaveBeenCalledTimes(2)
    expect((amqpPublish as jest.Mock).mock.calls[0][1]).toBe(queue)
    expect((amqpPublish as jest.Mock).mock.calls[1][1]).toBe(queue.endsWith('history') ? 'unoapi.transcribe.history' : 'unoapi.transcribe')
    expect(JSON.stringify((amqpPublish as jest.Mock).mock.calls)).not.toContain('vipererp-status-dev-v1')
    expect(JSON.stringify((amqpPublish as jest.Mock).mock.calls)).not.toContain('"id":"new"')
  })
  test('removal after cached configuration/media preparation is checked again', async () => {
    const service = { sendHttp: jest.fn() }
    const cachedConfig = jest.fn(async () => { stored.webhooks = []; return { ...defaultConfig, webhooks: [hook()] } })
    await new OutgoingJob(cachedConfig as any, service as any, queue).consume(phone, { payload: payload(), webhook: hook() })
    expect(service.sendHttp).not.toHaveBeenCalled()
  })
  test('Redis failure is retryable and does not pretend the binding was removed', async () => {
    read.mockRejectedValue(new Error('redis unavailable secret'))
    const { send, worker } = job()
    await expect(worker.consume(phone, { payload: payload(), webhook: hook() })).rejects.toBeInstanceOf(WebhookBindingReadError)
    expect(send).not.toHaveBeenCalled()
  })
  test('removed retries cannot reach the actual HTTP adapter or an open CB', async () => {
    const snapshot = hook()
    snapshot.id += queue
    stored.webhooks = [snapshot]
    const cachedConfig = jest.fn(async () => ({ ...defaultConfig, webhooks: [snapshot] }))
    const cloud = new OutgoingCloudApi(cachedConfig as any, jest.fn(async () => false), jest.fn())
    const worker = new OutgoingJob(cachedConfig as any, cloud, queue)
    ;(fetch as unknown as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable', text: async () => '' })
    await expect(worker.consume(phone, { payload: payload(), webhook: snapshot })).rejects.toMatchObject({ code: 'WEBHOOK_CB_OPEN' })
    expect(fetch).toHaveBeenCalledTimes(1)
    ;(redis.isWebhookCircuitOpen as jest.Mock).mockClear().mockResolvedValue(true)
    stored.webhooks = []
    await expect(worker.consume(phone, { payload: payload(), webhook: snapshot })).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(redis.isWebhookCircuitOpen).not.toHaveBeenCalled()
    expect(amqpPublish).not.toHaveBeenCalled()
  })
})

describe('transcription binding lifecycle', () => {
  const setup = (during?: () => void) => {
    const create = jest.fn(async () => { during?.(); return { text: 'synthetic transcription' } })
    ;(OpenAI as unknown as jest.Mock).mockImplementation(() => ({ audio: { transcriptions: { create } } }))
    const sendHttp = jest.fn()
    const config = { ...defaultConfig, openaiApiKey: 'synthetic-key', authToken: 'synthetic-token', getStore: async () => ({}) }
    return { create, sendHttp, worker: new TranscriberJob({ sendHttp } as any, jest.fn(async () => config) as any) }
  }
  test.each(['removed', 'disabled', 'changed-url', 'transcription-disabled'])('skips %s before media/provider calls', async change => {
    if (change === 'removed') stored.webhooks = []
    if (change === 'disabled') stored.webhooks[0].enabled = false
    if (change === 'changed-url') stored.webhooks[0].urlAbsolute = 'https://replacement.test/'
    if (change === 'transcription-disabled') stored.webhooks[0].sendTranscribeAudio = false
    const { worker, create, sendHttp } = setup()
    await worker.consume(phone, { payload: payload(), webhooks: [hook()] })
    expect(mediaToBuffer).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(sendHttp).not.toHaveBeenCalled()
  })
  test('removal while provider is processing prevents reference creation and delivery', async () => {
    const { worker, sendHttp, create } = setup(() => { stored.webhooks = [] })
    await worker.consume(phone, { payload: payload(), webhooks: [hook()] })
    expect(create).toHaveBeenCalledTimes(1); expect(saveTranscriptionReference).not.toHaveBeenCalled(); expect(sendHttp).not.toHaveBeenCalled()
  })
  test('removal during reference persistence is checked again before publishing', async () => {
    const { worker, sendHttp } = setup()
    ;(saveTranscriptionReference as jest.Mock).mockImplementation(async () => { stored.webhooks = []; return 'ref' })
    await worker.consume(phone, { payload: payload(), webhooks: [hook()] })
    expect(saveTranscriptionReference).toHaveBeenCalledTimes(1); expect(sendHttp).not.toHaveBeenCalled()
  })
  test('valid transcription uses current credentials without mutating input', async () => {
    stored.webhooks[0].token = 'rotated'
    const { worker, sendHttp } = setup(), input = payload(), before = JSON.stringify(input)
    await worker.consume(phone, { payload: input, webhooks: [hook()] })
    expect(sendHttp).toHaveBeenCalledWith(phone, expect.objectContaining({ token: 'rotated' }), expect.any(Object), {})
    expect(JSON.stringify(input)).toBe(before)
  })
  test.each([1, 2, 3])('binding read failure at boundary %s propagates for retry without delivery', async boundary => {
    let reads = 0
    read.mockImplementation(async () => { if (++reads === boundary) throw new Error('unavailable'); return stored })
    const { worker, sendHttp } = setup()
    await expect(worker.consume(phone, { payload: payload(), webhooks: [hook()] })).rejects.toBeInstanceOf(WebhookBindingReadError)
    expect(sendHttp).not.toHaveBeenCalled()
  })
})
