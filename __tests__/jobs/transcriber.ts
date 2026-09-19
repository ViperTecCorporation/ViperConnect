jest.mock('audio2textjs', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    runWhisper: jest.fn(async () => ({ output: '' })),
  })),
}))
jest.mock('../../src/services/transcription_reference', () => ({ saveTranscriptionReference: jest.fn(async () => 'uno-transcription:test') }))

jest.mock('../../src/utils/media_to_buffer', () => ({ __esModule: true, default: jest.fn(async () => ({ buffer: Buffer.from('audio'), link: 'test.ogg', mimeType: 'audio/ogg' })) }))
jest.mock('fs', () => ({ ...jest.requireActual('fs'), writeFileSync: jest.fn(), rmSync: jest.fn(), mkdirSync: jest.fn() }))
jest.mock('openai', () => ({ __esModule: true, default: jest.fn(), toFile: jest.fn(async () => new Blob(['audio'])) }))
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import Audio2TextJS from 'audio2textjs'
import OpenAI from 'openai'
import mediaToBuffer from '../../src/utils/media_to_buffer'
import { saveTranscriptionReference } from '../../src/services/transcription_reference'
import { TranscriberJob, extractTranscriptionDestiny } from '../../src/jobs/transcriber'

describe('TranscriberJob helpers', () => {
  it('uses group or lid identifiers when the audio payload has no wa_id/from phone', () => {
    const payload = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '5566996269251' },
            contacts: [{
              profile: { name: 'Carlos Uebel' },
              group_id: '120363385315015048@g.us',
              wa_id: '',
              user_id: '248923637706980@lid',
            }],
            messages: [{
              from: '',
              from_user_id: '248923637706980@lid',
              group_id: '120363385315015048@g.us',
              type: 'audio',
            }],
          },
        }],
      }],
    }

    const destiny = extractTranscriptionDestiny(
      payload,
      payload.entry[0].changes[0].value.messages[0],
    )

    expect(destiny).toBe('120363385315015048@g.us')
  })
})

describe('external transcription only', () => {
  const payload = () => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '5511999999999' }, messages: [{ from: '5511888888888', id: 'audio-id', type: 'audio', timestamp: '100', audio: { id: 'test/audio.ogg' } }] } }] }] })
  const makeJob = (keys = {}) => {
    const service = { sendHttp: jest.fn() }
    const config = { authToken: 'test', getStore: async () => ({}), ...keys }
    return { service, job: new TranscriberJob(service as any, jest.fn(async () => config) as any) }
  }
  const create = jest.fn()
  beforeEach(() => {
    jest.clearAllMocks()
    create.mockReset().mockResolvedValue({ text: 'Olá mundo.' })
    ;(OpenAI as unknown as jest.Mock).mockImplementation(() => ({ audio: { transcriptions: { create } } }))
  })
  afterEach(() => jest.restoreAllMocks())

  it('skips before downloading audio when no external provider is configured', async () => {
    const { service, job } = makeJob()
    await job.consume('5511999999999', { payload: payload(), webhooks: [{ id: 'default' }] })
    expect(service.sendHttp).not.toHaveBeenCalled()
    expect(mediaToBuffer).not.toHaveBeenCalled()
    expect(Audio2TextJS).not.toHaveBeenCalled()
  })
  it('does not fall back locally on OpenAI failure', async () => {
    create.mockRejectedValue(new Error('provider failed'))
    const { service, job } = makeJob({ openaiApiKey: 'test' })
    await job.consume('5511999999999', { payload: payload(), webhooks: [{ id: 'default' }] })
    expect(service.sendHttp).not.toHaveBeenCalled()
    expect(Audio2TextJS).not.toHaveBeenCalled()
  })
  it('preserves OpenAI transcription delivery', async () => {
    const { service, job } = makeJob({ openaiApiKey: 'test' })
    await job.consume('5511999999999', { payload: payload(), webhooks: [{ id: 'default' }] })
    expect(service.sendHttp).toHaveBeenCalledTimes(1)
    expect(service.sendHttp.mock.calls[0][2].entry[0].changes[0].value.messages[0].text.body).toBe('Olá mundo.')
    expect(saveTranscriptionReference).toHaveBeenCalledWith('5511999999999', '5511888888888', 'audio-id')
    expect((saveTranscriptionReference as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(service.sendHttp.mock.invocationCallOrder[0])
  })
  it('does not publish if association persistence fails and preserves the input audio payload', async () => {
    const { service, job } = makeJob({ openaiApiKey: 'test' })
    const input = payload()
    ;(saveTranscriptionReference as jest.Mock).mockRejectedValueOnce(new Error('redis offline'))
    await job.consume('5511999999999', { payload: input, webhooks: [{ id: 'default' }] })
    expect(service.sendHttp).not.toHaveBeenCalled()
    expect(input.entry[0].changes[0].value.messages[0].type).toBe('audio')
  })
  it.each([undefined, '', '   '])('does not send an empty transcription %p', async text => {
    create.mockResolvedValue({ text })
    const { service, job } = makeJob({ openaiApiKey: 'test' })
    await job.consume('5511999999999', { payload: payload(), webhooks: [{ id: 'default' }] })
    expect(service.sendHttp).not.toHaveBeenCalled()
  })
  it.each([false, true])('Groq failure uses OpenAI only when configured: %s', async hasOpenAI => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable', text: async () => '' } as Response)
    const { service, job } = makeJob({ groqApiKey: 'test', ...(hasOpenAI ? { openaiApiKey: 'test' } : {}) })
    await job.consume('5511999999999', { payload: payload(), webhooks: [{ id: 'default' }] })
    expect(create).toHaveBeenCalledTimes(hasOpenAI ? 1 : 0)
    expect(service.sendHttp).toHaveBeenCalledTimes(hasOpenAI ? 1 : 0)
    expect(Audio2TextJS).not.toHaveBeenCalled()
  })
  it('preserves Groq as preferred provider', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ text: 'Groq text' }) } as Response)
    const { service, job } = makeJob({ groqApiKey: 'test', openaiApiKey: 'test' })
    await job.consume('5511999999999', { payload: payload(), webhooks: [{ id: 'default' }] })
    expect(service.sendHttp).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(Audio2TextJS).not.toHaveBeenCalled()
  })
})
