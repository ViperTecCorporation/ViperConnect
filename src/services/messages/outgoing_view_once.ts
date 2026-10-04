import { SendError } from '../send_error'

/** Public extension lives inside image/video/audio, SDK flag is a send option. */
export function outgoingViewOnce(payload: any): boolean | undefined {
  if (payload?.view_once !== undefined) throw new SendError(400, 'view_once_must_be_inside_media')
  const value = payload?.[payload?.type]?.view_once
  if (value === undefined) return undefined
  if (!['image', 'video', 'audio'].includes(payload?.type)) throw new SendError(400, 'view_once_unsupported_message_type')
  if (typeof value !== 'boolean') throw new SendError(400, 'view_once_must_be_boolean')
  return value
}

export function outgoingViewOnceWebhook(payload: any) {
  return outgoingViewOnce(payload) === true ? { message_type: 'view_once' } : {}
}
