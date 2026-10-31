import { SendError } from '../send_error'

const supportedTypes = new Set(['text', 'image', 'video', 'audio', 'document', 'sticker', 'contacts', 'location'])

/** Mark supplied content as forwarded; this is not a source-message lookup or a quote. */
export function outgoingForwarded(payload: any): boolean | undefined {
  const value = payload?.context?.forwarded
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new SendError(400, 'forwarded_must_be_boolean')
  if (payload?.status || payload?.to === 'status@broadcast' || !supportedTypes.has(payload?.type)) {
    throw new SendError(400, 'forwarded_unsupported_message_type')
  }
  return value
}

export function outgoingForwardedWebhook(payload: any) {
  return outgoingForwarded(payload) === true ? { context: { forwarded: true } } : {}
}
