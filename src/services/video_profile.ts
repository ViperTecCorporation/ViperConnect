import { SendError } from './send_error'

export type VideoQuality = 'hd' | 'sd'
export const videoProfiles = {
  hd: { longEdge: 1280, shortEdge: 720, crf: 23, videoKbps: 2500, audioKbps: 96 },
  sd: { longEdge: 854, shortEdge: 480, crf: 27, videoKbps: 1200, audioKbps: 64 },
} as const

export function videoQuality(value: unknown): VideoQuality {
  if (value === undefined) return 'hd'
  if (value === 'hd' || value === 'sd') return value
  throw new SendError(400, 'video_quality_must_be_hd_or_sd')
}
