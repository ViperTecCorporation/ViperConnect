jest.mock('../../src/amqp', () => ({
  amqpPublish: jest.fn().mockResolvedValue(undefined),
}))

import { amqpPublish } from '../../src/amqp'
import {
  UNOAPI_EXCHANGE_BRIDGE_NAME,
  UNOAPI_EXCHANGE_BROKER_NAME,
  UNOAPI_QUEUE_INCOMING,
  UNOAPI_QUEUE_VIDEO_TRANSCODE,
} from '../../src/defaults'
import { VideoStageJob } from '../../src/jobs/video_stage'
import { VideoTranscodeJob } from '../../src/jobs/video_transcode'
import { defaultConfig } from '../../src/services/config'
import { VideoPreparationFailureReporter } from '../../src/services/video_preparation_failure'
import { UNOAPI_MEDIA_PUBLIC_URL, UNOAPI_MEDIA_SOURCE, UNOAPI_MEDIA_STORAGE_KEY } from '../../src/services/messages/outgoing_media_input'

const amqpPublishMock = amqpPublish as jest.MockedFunction<typeof amqpPublish>

describe('video preparation jobs', () => {
  beforeEach(() => jest.clearAllMocks())

  test('stage job persists the source before enqueueing the single-concurrency conversion', async () => {
    const mediaStore = {} as any
    const preparation = {
      stage: jest.fn().mockResolvedValue({ sourceKey: '5566/id-1.video-source', sizeBytes: 36_000_000 }),
    }
    const getConfig = async () => ({
      ...defaultConfig,
      provider: 'zapo' as const,
      getStore: async () => ({ mediaStore }),
    })
    const job = new VideoStageJob(getConfig as any, preparation as any)
    const data = {
      id: 'id-1',
      payload: { type: 'video', video: { link: 'https://chatwoot.example/video' } },
      options: { priority: 5 },
    }

    await job.consume('5566', data)

    expect(preparation.stage).toHaveBeenCalledWith(mediaStore, '5566', 'id-1', 'https://chatwoot.example/video')
    expect(amqpPublishMock).toHaveBeenCalledWith(
      UNOAPI_EXCHANGE_BROKER_NAME,
      UNOAPI_QUEUE_VIDEO_TRANSCODE,
      '5566',
      { ...data, sourceKey: '5566/id-1.video-source' },
      { type: 'topic', priority: 5, maxRetries: 2 },
    )
  })

  test('transcode job returns the prepared MP4 to the original provider queue with the same message id', async () => {
    const mediaStore = {} as any
    const preparation = {
      prepare: jest.fn().mockResolvedValue({
        key: '5566/id-2.prepared.mp4',
        link: 'https://uno.example/id-2.prepared.mp4',
        sizeBytes: 10_000_000,
        transcoded: true,
      }),
    }
    const getConfig = async () => ({
      ...defaultConfig,
      server: 'server_2',
      provider: 'zapo' as const,
      getStore: async () => ({ mediaStore }),
    })
    const job = new VideoTranscodeJob(getConfig as any, preparation as any)

    await job.consume('5566', {
      id: 'id-2',
      sourceKey: '5566/id-2.video-source',
      payload: {
        to: '5577',
        type: 'video',
        video: { link: 'https://chatwoot.example/original.mov', filename: 'original.mov', caption: 'teste', quality: 'sd', view_once: true },
      },
    })

    expect(preparation.prepare).toHaveBeenCalledWith(mediaStore, '5566', 'id-2', '5566/id-2.video-source', 'sd')
    const queued = amqpPublishMock.mock.calls[0][3] as any
    expect(queued.payload.video).not.toHaveProperty('quality')
    expect(queued.payload.video.view_once).toBe(true)
    expect(queued.options.videoTranscoded).toBe('sd')
    expect(amqpPublishMock).toHaveBeenCalledWith(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      `${UNOAPI_QUEUE_INCOMING}.server_2.zapo`,
      '5566',
      {
        id: 'id-2',
        payload: expect.objectContaining({
          video: expect.objectContaining({
            link: 'https://uno.example/id-2.prepared.mp4',
            filename: 'original.mp4',
            mime_type: 'video/mp4',
          }),
        }),
        options: expect.objectContaining({ videoPrepared: true }),
      },
      expect.objectContaining({ type: 'direct', videoPrepared: true }),
    )
  })

  test('replaces Base64 video staging metadata with the prepared media reference', async () => {
    const preparation = {
      prepare: jest.fn().mockResolvedValue({
        key: '5566/id-base64.prepared.mp4',
        link: 'https://uno.example/id-base64.prepared.mp4',
        sizeBytes: 1000,
        transcoded: false,
      }),
    }
    const getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      provider: 'zapo' as const,
      getStore: async () => ({ mediaStore: {} }),
    })
    const job = new VideoTranscodeJob(getConfig as any, preparation as any)

    await job.consume('5566', {
      id: 'id-base64',
      sourceKey: '5566/id-base64.video-source',
      payload: {
        to: '5577',
        type: 'video',
        video: {
          link: '/data/medias/5566/id-base64.video-source',
          filename: 'camera.mov',
          [UNOAPI_MEDIA_STORAGE_KEY]: '5566/id-base64.video-source',
          [UNOAPI_MEDIA_SOURCE]: 'base64',
        },
      },
    })

    const queued = amqpPublishMock.mock.calls[0][3] as any
    expect(queued.payload.video[UNOAPI_MEDIA_STORAGE_KEY]).toBe('5566/id-base64.prepared.mp4')
    expect(queued.payload.video[UNOAPI_MEDIA_SOURCE]).toBe('base64')
    expect(queued.payload.video[UNOAPI_MEDIA_PUBLIC_URL]).toBe('https://uno.example/id-base64.prepared.mp4')
    expect(queued.payload.video.link).toBe('https://uno.example/id-base64.prepared.mp4')
  })

  test('reports a failed status only when preparation exhausts its retries', async () => {
    const preparation = { stage: jest.fn().mockRejectedValue(new Error('ffmpeg unavailable')) }
    const failureReporter = { report: jest.fn().mockResolvedValue(undefined) }
    const getConfig = async () => ({
      ...defaultConfig,
      provider: 'zapo' as const,
      getStore: async () => ({ mediaStore: {} }),
    })
    const job = new VideoStageJob(getConfig as any, preparation as any, failureReporter as any)
    const data = {
      id: 'id-failed',
      payload: { to: '5577', type: 'video', video: { link: 'https://example/video' } },
    }

    await expect(job.consume('5566', data, { countRetries: 1, maxRetries: 2 })).rejects.toThrow('ffmpeg unavailable')
    expect(failureReporter.report).not.toHaveBeenCalled()
    await expect(job.consume('5566', data, { countRetries: 2, maxRetries: 2 })).rejects.toThrow('ffmpeg unavailable')
    expect(failureReporter.report).toHaveBeenCalledWith('5566', data, expect.any(Error))
  })

  test('publishes a Meta-compatible failed media status to bulk status and webhooks', async () => {
    const webhook = { ...defaultConfig.webhooks[0], url: 'https://chatwoot.example/webhook', enabled: true }
    const outgoing = { sendHttp: jest.fn().mockResolvedValue(undefined) }
    const reporter = new VideoPreparationFailureReporter(
      (async () => ({ ...defaultConfig, webhooks: [webhook] })) as any,
      outgoing as any,
    )

    await reporter.report('5566', {
      id: 'id-failed',
      payload: { to: '+5566999999999', type: 'video', video: { link: 'https://example/video' } },
    }, new Error('video_output_too_large'))

    const statusPayload = expect.objectContaining({
      entry: expect.arrayContaining([
        expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({
              value: expect.objectContaining({
                statuses: expect.arrayContaining([
                  expect.objectContaining({ id: 'id-failed', recipient_id: '5566999999999', status: 'failed' }),
                ]),
              }),
            }),
          ]),
        }),
      ]),
    })
    expect(amqpPublishMock).toHaveBeenCalledWith(
      UNOAPI_EXCHANGE_BROKER_NAME,
      expect.stringContaining('bulk.status'),
      '5566',
      { payload: statusPayload, type: 'whatsapp' },
      { type: 'topic', priority: 1 },
    )
    expect(outgoing.sendHttp).toHaveBeenCalledWith('5566', webhook, statusPayload, { priority: 1 })
  })
})
