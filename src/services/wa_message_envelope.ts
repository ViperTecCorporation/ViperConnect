import { proto } from '@whiskeysockets/baileys'

const EXTRA_KEY_FIELDS = [
  'remoteJidAlt',
  'participantAlt',
  'senderPn',
  'participantPn',
  'senderLid',
  'participantLid',
  'recipientLid',
  'participantUsername',
  'remoteJidUsername',
  'senderUsername',
  'senderDevice',
  'isGroup',
  'isBroadcast',
  'isNewsletter',
] as const

type PackedWaMessage = {
  __wa_b64: string
  __unoapi_key?: Record<string, unknown>
}

const extraKeyMetadata = (message: any) => {
  const metadata: Record<string, unknown> = {}
  for (const field of EXTRA_KEY_FIELDS) {
    const value = message?.key?.[field]
    if (value !== undefined && value !== null && value !== '') metadata[field] = value
  }
  return Object.keys(metadata).length ? metadata : undefined
}

export const packWaMessage = (message: any): PackedWaMessage | any => {
  if (!message || (!message.key && !message.message)) return message
  try {
    const bytes = proto.WebMessageInfo.encode(message).finish()
    const key = extraKeyMetadata(message)
    return {
      __wa_b64: Buffer.from(bytes).toString('base64'),
      ...(key ? { __unoapi_key: key } : {}),
    }
  } catch {
    return message
  }
}

export const unpackWaMessage = (message: any) => {
  if (!message?.__wa_b64) return message
  try {
    const decoded: any = proto.WebMessageInfo.decode(Buffer.from(message.__wa_b64, 'base64'))
    if (message.__unoapi_key) decoded.key = { ...(decoded.key || {}), ...message.__unoapi_key }
    return decoded
  } catch {
    return message
  }
}
