import { Readable } from 'stream'
import { writeFile, truncate, access } from 'fs/promises'
import { mock } from 'jest-mock-extended'
import type { MediaStore } from '../../src/services/media_store'
import {
  isWhatsAppCompatibleVideo,
  transcodeArgs,
  matchesVideoProfile,
  matchesAudioProfile,
  matchesVideoStreamProfile,
  VideoPreparationService,
} from '../../src/services/video_preparation'
import { BASE_URL } from '../../src/defaults'
import { videoQuality } from '../../src/services/video_profile'

describe('video preparation', () => {
  test.each([32000, 64000, 96000, 100800, 100801])('SD accepts prepared AAC up to 100800 bps: %s', bitrate => {
    const probe = { durationSeconds: 10, sizeBytes: 1000, videoCodec: 'h264', pixelFormat: 'yuv420p', width: 854, height: 480, fps: 30, sampleAspectRatio: '1:1', videoBitrate: 1000000, audioCodecs: ['aac'], audioProfile: 'LC', audioChannels: 1, audioSampleRate: 48000, audioBitrate: bitrate }
    expect(matchesVideoStreamProfile(probe, 'sd')).toBe(true)
    expect(matchesAudioProfile(probe)).toBe(bitrate <= 100800)
    expect(matchesVideoProfile(probe, 'sd')).toBe(bitrate <= 100800)
    if (bitrate > 100800) {
      const args = transcodeArgs('input', 'output', probe, 'sd')
      expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-b:a', '64k', '-ac', '1']))
      expect(args).not.toContain('libx264')
      expect(args).not.toContain('-vf')
      expect(args).not.toContain('-fpsmax')
    }
    for (const override of [{ audioCodecs: ['opus'] }, { audioSampleRate: 44100 }, { audioChannels: 6 }, { audioProfile: 'HE-AAC' }, { audioBitrate: undefined }]) {
      expect(matchesAudioProfile({ ...probe, ...override })).toBe(false)
    }
  })
  test.each(['s3', 'file'])('reuses an inspected fast-start MP4 in %s without ffmpeg or another upload', async type => {
    const box = (kind: string, body = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(kind, 4); return Buffer.concat([h, body]) }
    const bytes = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov'), box('mdat', Buffer.from('media'))])
    const mediaStore = mock<MediaStore>(); mediaStore.type = type
    mediaStore.downloadMediaStream.mockResolvedValue(Readable.from(bytes))
    mediaStore.getFileUrl.mockResolvedValue('https://example.com/source')
    mediaStore.getDownloadUrl.mockResolvedValue('https://example.com/local-source')
    const runner = jest.fn().mockResolvedValue({ stdout: JSON.stringify({ format: { size: bytes.length, duration: 1 }, streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 360, avg_frame_rate: '24/1', r_frame_rate: '24/1', sample_aspect_ratio: '1:1', bit_rate: '500000' }] }), stderr: '' })
    const result = await new VideoPreparationService(runner).prepare(mediaStore, 'test', 'id', 'original-source')
    expect(result).toMatchObject({ key: 'original-source', sizeBytes: bytes.length, transcoded: false, reused: true })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0]).toBe('ffprobe')
    expect(mediaStore.saveMediaBuffer).not.toHaveBeenCalled()
  })
  test('validates profiles and remux eligibility without trusting browser flags', () => {
    expect(videoQuality(undefined)).toBe('hd')
    expect(videoQuality('sd')).toBe('sd')
    expect(() => videoQuality('compact')).toThrow()
    const probe = { durationSeconds: 600, sizeBytes: 30_000_000, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodecs: [], width: 1280, height: 720, fps: 30, rotation: 0, sampleAspectRatio: '1:1', videoBitrate: 1000000 }
    expect(matchesVideoProfile(probe, 'hd')).toBe(true)
    expect(matchesVideoProfile(probe, 'sd')).toBe(false)
    for (const overrides of [{ width: 1920, height: 1080 }, { fps: 60 }, { rotation: 90 }, { videoBitrate: undefined }, { pixelFormat: 'yuv420p10le' }]) {
      expect(matchesVideoProfile({ ...probe, ...overrides }, 'hd')).toBe(false)
    }
    const args = transcodeArgs('in', 'out', { ...probe, audioCodecs: ['aac'], audioChannels: 1 }, 'sd')
    expect(args).toEqual(expect.arrayContaining(['-crf', '27', '-maxrate', '1200k', '-bufsize', '2400k', '-b:a', '64k', '-ac', '1']))
    expect(args.join(' ')).toContain('min(854,iw)')
    expect(transcodeArgs('in', 'out', probe)).toContain('-an')
  })
  test('recognizes the documented H264/AAC MP4-compatible streams', () => {
    expect(isWhatsAppCompatibleVideo({
      durationSeconds: 10,
      sizeBytes: 1_000,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodecs: ['aac'],
    })).toBe(true)
    expect(isWhatsAppCompatibleVideo({
      durationSeconds: 10,
      sizeBytes: 1_000,
      videoCodec: 'hevc',
      pixelFormat: 'yuv420p10le',
      audioCodecs: ['aac'],
    })).toBe(false)
  })

  test.each([17, 65, 257])('handles %s MiB output without a silent quality fallback and cleans temporary files', async mib => {
    const mediaStore = mock<MediaStore>()
    mediaStore.type = 's3'
    mediaStore.downloadMediaStream.mockResolvedValue(Readable.from('source'))
    mediaStore.getFileUrl.mockResolvedValue('https://example.com/video.mp4')
    let outputPath = ''
    const runner = jest.fn(async (command: string, args: string[]) => {
      if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: '1800', size: '40000000' }, streams: [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p' }] }), stderr: '' }
      outputPath = args[args.length - 1]
      await writeFile(outputPath, '')
      await truncate(outputPath, mib * 1024 * 1024)
      return { stdout: '', stderr: '' }
    })
    const task = new VideoPreparationService(runner).prepare(mediaStore, 'test', 'id', 'source', 'hd')
    if (mib <= 256) await expect(task).resolves.toMatchObject({ sizeBytes: mib * 1024 * 1024, transcoded: true })
    else {
      await expect(task).rejects.toThrow('video_output_too_large:')
      expect(mediaStore.saveMediaBuffer).not.toHaveBeenCalled()
    }
    expect(runner.mock.calls.filter(([cmd]) => cmd === 'ffmpeg')).toHaveLength(1)
    await expect(access(outputPath)).rejects.toThrow()
  })

  test('caps CPU and bitrate in the generated ffmpeg command', () => {
    const probe = {
      durationSeconds: 17,
      sizeBytes: 36_000_000,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodecs: ['aac'],
    }
    const args = transcodeArgs('/tmp/input', '/tmp/output.mp4', probe)

    expect(args).toEqual(expect.arrayContaining(['-crf', '23', '-maxrate', '2500k', '-bufsize', '5000k', '-fpsmax', '30']))
    expect(args).not.toContain('-b:v')
    expect(transcodeArgs('/tmp/input', '/tmp/output.mp4', { ...probe, durationSeconds: 3600 })).toEqual(args)
    expect(args).toEqual(expect.arrayContaining(['-threads', '1', '-filter_threads', '1', '-movflags', '+faststart']))
    expect(args).toContain('libx264')
  })

  test('stages the source as a stream and enforces a durable source key', async () => {
    const mediaStore = mock<MediaStore>()
    let stored = Buffer.alloc(0)
    mediaStore.saveMediaStream.mockImplementation(async (_key, stream) => {
      for await (const chunk of stream) stored = Buffer.concat([stored, Buffer.from(chunk)])
      return true
    })
    const fetchVideo = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name === 'content-length' ? '5' : 'video/quicktime' },
      body: Readable.from(Buffer.from('video')),
    })
    const service = new VideoPreparationService(jest.fn(), fetchVideo as any)

    await expect(service.stage(mediaStore, '5566', 'message-1', 'https://example/video')).resolves.toEqual({
      sourceKey: '5566/message-1.video-source',
      contentType: 'video/quicktime',
      sizeBytes: 5,
    })
    expect(stored.toString()).toBe('video')
  })

  test('transcodes an oversized source and stores a fast-start MP4 below the target', async () => {
    const mediaStore = mock<MediaStore>()
    mediaStore.type = 's3'
    mediaStore.downloadMediaStream.mockResolvedValue(Readable.from(Buffer.from('source')))
    mediaStore.saveMediaBuffer.mockResolvedValue(true)
    mediaStore.getFileUrl.mockResolvedValue('https://uno.example/prepared.mp4')
    const runner = jest.fn(async (command: string, args: string[]) => {
      if (command === 'ffprobe') {
        return {
          stdout: JSON.stringify({
            format: { duration: '17.0', size: '36596373' },
            streams: [
              { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
              { codec_type: 'audio', codec_name: 'aac' },
            ],
          }),
          stderr: '',
        }
      }
      await writeFile(args[args.length - 1], Buffer.alloc(2_000_000))
      return { stdout: '', stderr: '' }
    })
    const service = new VideoPreparationService(runner)

    const result = await service.prepare(mediaStore, '5566', 'message-2', 'source-key')

    expect(result).toEqual(expect.objectContaining({ transcoded: true, sizeBytes: 2_000_000 }))
    expect(runner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-c:v', 'libx264']), expect.any(Number))
    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith(
      '5566/message-2.prepared.mp4',
      expect.any(Buffer),
      'video/mp4',
    )
  })

  test('remuxes an already compatible small source instead of re-encoding it', async () => {
    const mediaStore = mock<MediaStore>()
    mediaStore.type = 'file'
    mediaStore.downloadMediaStream.mockResolvedValue(Readable.from(Buffer.from('source')))
    mediaStore.saveMediaBuffer.mockResolvedValue(true)
    mediaStore.getDownloadUrl.mockResolvedValue('https://uno.example/v15.0/download/prepared.mp4')
    const runner = jest.fn(async (command: string, args: string[]) => {
      if (command === 'ffprobe') return {
        stdout: JSON.stringify({
          format: { duration: '5', size: '1000' },
          streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720, avg_frame_rate: '30/1', r_frame_rate: '30/1', sample_aspect_ratio: '1:1', bit_rate: '1000000' }],
        }),
        stderr: '',
      }
      await writeFile(args[args.length - 1], Buffer.alloc(1_000))
      return { stdout: '', stderr: '' }
    })
    const service = new VideoPreparationService(runner)

    await expect(service.prepare(mediaStore, '5566', 'message-3', 'source-key')).resolves.toEqual(
      expect.objectContaining({ transcoded: false }),
    )
    expect(runner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-c', 'copy']), expect.any(Number))
    expect(mediaStore.getDownloadUrl).toHaveBeenCalledWith(BASE_URL, '5566/message-3.prepared.mp4')
  })
})
