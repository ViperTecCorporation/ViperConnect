import { createWriteStream } from 'fs'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import fetch from 'node-fetch'
import {
  BASE_URL,
  DATA_URL_TTL,
  UNOAPI_VIDEO_MAX_INPUT_BYTES,
  UNOAPI_VIDEO_STAGE_TIMEOUT_MS,
  UNOAPI_VIDEO_MAX_OUTPUT_BYTES,
  UNOAPI_VIDEO_TRANSCODE_TIMEOUT_MS,
} from '../defaults'
import type { MediaStore } from './media_store'
import { videoProfiles, VideoQuality, videoQuality } from './video_profile'
import { isFastStartMp4 } from './mp4_faststart'

export type VideoProbe = {
  durationSeconds: number
  sizeBytes: number
  videoCodec: string
  pixelFormat: string
  audioCodecs: string[]
  width?: number
  height?: number
  fps?: number
  rotation?: number
  sampleAspectRatio?: string
  videoBitrate?: number
  audioChannels?: number
  audioSampleRate?: number
  audioProfile?: string
  audioBitrate?: number
  hasExtraStreams?: boolean
}

export type StagedVideo = {
  sourceKey: string
  contentType: string
  sizeBytes: number
}

export type PreparedVideo = {
  key: string
  link: string
  sizeBytes: number
  transcoded: boolean
  reused?: boolean
  videoCopied?: boolean
}

type ProcessResult = { stdout: string; stderr: string }
type ProcessRunner = (command: string, args: string[], timeoutMs: number) => Promise<ProcessResult>

const runProcess: ProcessRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  const lowPriorityFfmpeg = command === 'ffmpeg' && process.platform !== 'win32'
  const child = spawn(lowPriorityFfmpeg ? 'nice' : command, lowPriorityFfmpeg ? ['-n', '10', command, ...args] : args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const append = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-1024 * 1024)
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`${command} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  child.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
  child.once('close', (code) => {
    clearTimeout(timer)
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-4000)}`))
  })
})

class ByteLimitTransform extends Transform {
  sizeBytes = 0

  constructor(private readonly maxBytes: number) {
    super()
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.sizeBytes += chunk.length
    if (this.sizeBytes > this.maxBytes) {
      callback(new Error(`video_input_too_large:${this.sizeBytes}:${this.maxBytes}`))
      return
    }
    callback(null, chunk)
  }
}

export const isWhatsAppCompatibleVideo = (probe: VideoProbe) =>
  probe.videoCodec === 'h264' &&
  probe.pixelFormat === 'yuv420p' &&
  probe.audioCodecs.length <= 1 &&
  probe.audioCodecs.every((codec) => codec === 'aac')

export const matchesVideoStreamProfile = (probe: VideoProbe, quality: VideoQuality) => {
  const p = videoProfiles[quality]
  const w = probe.width || 0; const h = probe.height || 0
  return probe.videoCodec === 'h264' && probe.pixelFormat === 'yuv420p' && w > 0 && h > 0 && w % 2 === 0 && h % 2 === 0 &&
    Math.max(w, h) <= p.longEdge && Math.min(w, h) <= p.shortEdge &&
    !!probe.fps && probe.fps <= 30 && !probe.rotation && probe.sampleAspectRatio === '1:1' &&
    !!probe.videoBitrate && probe.videoBitrate <= p.videoKbps * 1000
}

// Browser encoders may only offer AAC 96 kbps. Keep SD's encoding target at 64,
// but accept already prepared audio up to 96 kbps + 5%, without a bitrate floor.
export const matchesAudioProfile = (probe: VideoProbe) => !probe.audioCodecs.length || (
  probe.audioCodecs.length === 1 && probe.audioCodecs[0] === 'aac' &&
  probe.audioProfile === 'LC' && probe.audioSampleRate === 48000 &&
  !!probe.audioChannels && probe.audioChannels <= 2 && !!probe.audioBitrate && probe.audioBitrate <= 100800
)

export const matchesVideoProfile = (probe: VideoProbe, quality: VideoQuality) =>
  matchesVideoStreamProfile(probe, quality) && matchesAudioProfile(probe)

export const transcodeArgs = (inputPath: string, outputPath: string, probe: VideoProbe, quality: VideoQuality = 'hd') => {
  const p = videoProfiles[quality]
  const scale = `scale=w='if(gte(iw,ih),min(${p.longEdge},iw),min(${p.shortEdge},iw))':h='if(gte(iw,ih),min(${p.shortEdge},ih),min(${p.longEdge},ih))':force_original_aspect_ratio=decrease:force_divisible_by=2`
  const args = [
    '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...(matchesVideoStreamProfile(probe, quality) ? ['-c:v', 'copy'] : [
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '4.0',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,${scale},setsar=1`,
    '-fpsmax', '30', '-crf', `${p.crf}`, '-maxrate', `${p.videoKbps}k`, '-bufsize', `${p.videoKbps * 2}k`,
    '-threads', '1', '-filter_threads', '1',
    ]),
  ]
  if (probe.audioCodecs.length) args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', `${p.audioKbps}k`, '-ac', probe.audioChannels === 1 ? '1' : '2', '-ar', '48000')
  else args.push('-an')
  args.push('-map_metadata', '0', '-metadata:s:v:0', 'rotate=0', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', outputPath)
  return args
}

export class VideoPreparationService {
  constructor(
    private readonly processRunner: ProcessRunner = runProcess,
    private readonly fetchVideo: typeof fetch = fetch,
  ) {}

  async stage(mediaStore: MediaStore, phone: string, id: string, link: string): Promise<StagedVideo> {
    const response = await this.fetchVideo(link, {
      method: 'GET',
      signal: AbortSignal.timeout(UNOAPI_VIDEO_STAGE_TIMEOUT_MS),
    })
    if (!response.ok || !response.body) throw new Error(`video_stage_download_failed:http_${response.status}`)
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > UNOAPI_VIDEO_MAX_INPUT_BYTES) {
      throw new Error(`video_input_too_large:${contentLength}:${UNOAPI_VIDEO_MAX_INPUT_BYTES}`)
    }
    const contentType = `${response.headers.get('content-type') || 'application/octet-stream'}`.split(';')[0]
    const sourceKey = `${phone}/${id}.video-source`
    const limiter = new ByteLimitTransform(UNOAPI_VIDEO_MAX_INPUT_BYTES)
    const source = response.body as unknown as Readable
    await mediaStore.saveMediaStream(sourceKey, source.pipe(limiter), contentType)
    return { sourceKey, contentType, sizeBytes: limiter.sizeBytes || contentLength }
  }

  private async probe(inputPath: string): Promise<VideoProbe> {
    const result = await this.processRunner('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,bit_rate,sample_aspect_ratio,channels,sample_rate,profile:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', inputPath,
    ], UNOAPI_VIDEO_TRANSCODE_TIMEOUT_MS)
    const parsed = JSON.parse(result.stdout || '{}')
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const video = streams.find((stream: any) => stream.codec_type === 'video')
    if (!video) throw new Error('video_probe_missing_video_stream')
    const audio = streams.find((stream: any) => stream.codec_type === 'audio')
    const fps = (value: string) => { const [n, d = '1'] = `${value || '0'}`.split('/'); return Number(n) / Number(d) }
    return {
      durationSeconds: Number(parsed?.format?.duration || 0),
      sizeBytes: Number(parsed?.format?.size || 0),
      videoCodec: `${video.codec_name || ''}`,
      pixelFormat: `${video.pix_fmt || ''}`,
      audioCodecs: streams.filter((stream: any) => stream.codec_type === 'audio').map((stream: any) => `${stream.codec_name || ''}`),
      width: Number(video.width), height: Number(video.height),
      fps: Math.max(fps(video.avg_frame_rate), fps(video.r_frame_rate)),
      rotation: Number(video.side_data_list?.find((side: any) => side.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0),
      sampleAspectRatio: video.sample_aspect_ratio,
      videoBitrate: Number(video.bit_rate), audioChannels: Number(audio?.channels),
      audioSampleRate: Number(audio?.sample_rate), audioProfile: audio?.profile, audioBitrate: Number(audio?.bit_rate),
      hasExtraStreams: streams.filter((stream: any) => stream.codec_type === 'video').length !== 1 || streams.some((stream: any) => !['video', 'audio'].includes(stream.codec_type)),
    }
  }

  async prepare(mediaStore: MediaStore, phone: string, id: string, sourceKey: string, selectedQuality: unknown = 'hd'): Promise<PreparedVideo> {
    const quality = videoQuality(selectedQuality)
    const workDir = await mkdtemp(join(tmpdir(), 'unoapi-video-'))
    const inputPath = join(workDir, 'input')
    const outputPath = join(workDir, 'output.mp4')
    try {
      const source = await mediaStore.downloadMediaStream(sourceKey)
      if (!source) throw new Error(`video_stage_source_not_found:${sourceKey}`)
      await pipeline(source, new ByteLimitTransform(UNOAPI_VIDEO_MAX_INPUT_BYTES), createWriteStream(inputPath))
      const probe = await this.probe(inputPath)
      const canRemux = matchesVideoProfile(probe, quality)
      if (canRemux && !probe.hasExtraStreams && await isFastStartMp4(inputPath)) {
        const { size } = await stat(inputPath)
        if (size > UNOAPI_VIDEO_MAX_OUTPUT_BYTES) throw new Error(`video_output_too_large:${size}:${UNOAPI_VIDEO_MAX_OUTPUT_BYTES}`)
        return {
          key: sourceKey,
          link: mediaStore.type === 'file'
            ? await mediaStore.getDownloadUrl(BASE_URL, sourceKey)
            : await mediaStore.getFileUrl(sourceKey, DATA_URL_TTL),
          sizeBytes: size, transcoded: false, reused: true,
        }
      }
      if (canRemux) {
        await this.processRunner('ffmpeg', [
          '-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '0', '-movflags', '+faststart', outputPath,
        ], UNOAPI_VIDEO_TRANSCODE_TIMEOUT_MS)
      } else {
        await this.processRunner('ffmpeg', transcodeArgs(inputPath, outputPath, probe, quality), UNOAPI_VIDEO_TRANSCODE_TIMEOUT_MS)
      }

      const outputStat = await stat(outputPath)
      if (outputStat.size > UNOAPI_VIDEO_MAX_OUTPUT_BYTES) {
        throw new Error(`video_output_too_large:${outputStat.size}:${UNOAPI_VIDEO_MAX_OUTPUT_BYTES}`)
      }

      const key = `${phone}/${id}.prepared.mp4`
      await mediaStore.saveMediaBuffer(key, await readFile(outputPath), 'video/mp4')
      return {
        key,
        link: mediaStore.type === 'file'
          ? await mediaStore.getDownloadUrl(BASE_URL, key)
          : await mediaStore.getFileUrl(key, DATA_URL_TTL),
        sizeBytes: outputStat.size,
        transcoded: !canRemux,
        ...(!canRemux && matchesVideoStreamProfile(probe, quality) ? { videoCopied: true } : {}),
      }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}
