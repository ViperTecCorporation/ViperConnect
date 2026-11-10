jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))
import { amqpPublish } from '../../src/amqp'
import { VideoStageJob } from '../../src/jobs/video_stage'
import { VideoTranscodeJob } from '../../src/jobs/video_transcode'
import { configs, defaultConfig } from '../../src/services/config'
import { NonRetryableQueueError } from '../../src/services/non_retryable_queue_error'
import { VideoPreparationFailureReporter } from '../../src/services/video_preparation_failure'

const phone = '999123456789', originalMode = process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
const storage = { backend: 'sqlite', owner: 'worker_fixture', storageId: '12345678-1234-4234-8234-123456789abc', generation: 2, state: 'active' }
const data = { id: 'same-message-id', sourceKey: 'fixture-source', payload: { to: '999123456788', type: 'video', video: { link: 'https://example.invalid/video', caption: 'preserved' } } }
const cases = [
  ['fixture', { ...storage, fixture: true }, false, 'session_storage_fixture_external_effects_forbidden', true],
  ['global synthetic mode', storage, true, 'session_storage_fixture_external_effects_forbidden', true],
  ['migration', { ...storage, state: 'migrating' }, false, 'session_storage_operation_in_progress', false],
  ['restore', { ...storage, state: 'restoring' }, false, 'session_storage_operation_in_progress', false],
] as const
beforeEach(() => { jest.clearAllMocks(); delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY; configs.clear() })
afterAll(() => {
  configs.clear()
  if (originalMode === undefined) delete process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY
  else process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = originalMode
})

describe.each([['stage', VideoStageJob], ['transcode', VideoTranscodeJob]] as const)('%s storage policy', (_name, Job) => {
  test.each(cases)('queued %s is refused before store/network/S3/ffmpeg/publication or failure callback', async (_label, selection, synthetic, title, terminal) => {
    if (synthetic) process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY = 'true'
    const getStore = jest.fn(), preparation = { stage: jest.fn(), prepare: jest.fn() }, report = jest.fn()
    // Even a healthy cached config or forged queued snapshot cannot authorize effects.
    configs.set(phone, { ...defaultConfig, sessionStorage: storage } as any)
    const read = jest.fn(async () => {
      expect(configs.has(phone)).toBe(false)
      return { ...defaultConfig, provider: 'zapo', sessionStorage: selection, getStore }
    })
    const job = new Job(read as any, preparation as any, { report } as any)
    const error = await job.consume(phone, { ...data, sessionStorage: { fixture: false } } as any, { countRetries: 10, maxRetries: 10 }).catch(error => error)
    expect(error).toMatchObject({ code: 409, title })
    expect(error instanceof NonRetryableQueueError).toBe(terminal)
    expect(getStore).not.toHaveBeenCalled()
    expect(preparation.stage).not.toHaveBeenCalled(); expect(preparation.prepare).not.toHaveBeenCalled()
    expect(amqpPublish).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled()
  })

  test('revalidates fresh state after asynchronous store lookup before any media work', async () => {
    let current: any = { ...storage }
    const getStore = jest.fn(async () => { current = { ...storage, state: 'migrating' }; return { mediaStore: {} } })
    const preparation = { stage: jest.fn(), prepare: jest.fn() }, report = jest.fn()
    const read = jest.fn(async () => ({ ...defaultConfig, provider: 'zapo', sessionStorage: current, getStore }))
    await expect(new Job(read as any, preparation as any, { report } as any).consume(phone, data, { countRetries: 10, maxRetries: 10 })).rejects.toThrow('session_storage_operation_in_progress')
    expect(preparation.stage).not.toHaveBeenCalled(); expect(preparation.prepare).not.toHaveBeenCalled()
    expect(amqpPublish).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled()
  })

  test('generation change during preparation prevents publication without false failed-status webhook', async () => {
    let current: any = { ...storage }
    const complete = jest.fn(async () => { current = { ...storage, generation: 3 }; return { sourceKey: 'source', key: 'prepared', link: 'https://example.invalid/prepared.mp4', sizeBytes: 100 } })
    const preparation = { stage: complete, prepare: complete }, report = jest.fn()
    const read = jest.fn(async () => ({ ...defaultConfig, provider: 'zapo', sessionStorage: current, getStore: async () => ({ mediaStore: {} }) }))
    await expect(new Job(read as any, preparation as any, { report } as any).consume(phone, data, { countRetries: 10, maxRetries: 10 })).rejects.toThrow('session_storage_generation_changed')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(amqpPublish).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled()
  })
})

test('failure reporter also checks fresh quarantine before emitting bulk status or webhooks', async () => {
  const sendHttp = jest.fn()
  const read = jest.fn(async () => ({ ...defaultConfig, sessionStorage: { ...storage, fixture: true } }))
  await expect(new VideoPreparationFailureReporter(read as any, { sendHttp } as any).report(phone, data, new Error('ffmpeg failed'))).rejects.toBeInstanceOf(NonRetryableQueueError)
  expect(amqpPublish).not.toHaveBeenCalled(); expect(sendHttp).not.toHaveBeenCalled()
})
