import { WAMessageContent, WAMessage, proto } from '@whiskeysockets/baileys'

import {
  OTHER_MESSAGES_TO_PROCESS,
  TYPE_MESSAGES_TO_PROCESS_FILE,
  TYPE_MESSAGES_TO_READ,
} from './message_constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getMessageType = (payload: any) => {
  // 1) update tem prioridade maxima
  if (payload?.update) return 'update'
  // 2) status sem wrapper update: considerar update, exceto SERVER_ACK (2) de terceiros
  if (typeof payload?.status !== 'undefined') {
    const st = payload.status
    const isServerAck = st === 2 || st === '2' || `${st}`.toUpperCase() === 'SERVER_ACK'
    const fromMe = !!(payload?.key?.fromMe)
    if (!isServerAck || fromMe) return 'update'
    // SERVER_ACK de terceiros: deixa seguir como mensagem
  }
  // 3) receipts explicitos
  if (payload?.receipt) return 'receipt'
  // 4) mensagens reais
  if (payload?.message) {
    const { message } = payload
    return (
      TYPE_MESSAGES_TO_READ.find((t) => message[t]) ||
      OTHER_MESSAGES_TO_PROCESS.find((t) => message[t]) ||
      Object.keys(payload.message)[0]
    )
  }
  // 5) stubs
  if (payload?.messageStubType) return 'messageStubType'
}

export const normalizeMessageContent = (
  content: WAMessageContent | null | undefined
): WAMessageContent | proto.IMessage | undefined => {
  content =
    // unwrap edited message to original content
    content?.editedMessage?.message ||
    (content as any)?.protocolMessage?.editedMessage?.message ||
    content?.ephemeralMessage?.message?.viewOnceMessage?.message ||
    content?.ephemeralMessage?.message ||
    content?.viewOnceMessage?.message ||
    content?.viewOnceMessageV2Extension?.message ||
    content?.viewOnceMessageV2?.message ||
    (content as any)?.deviceSentMessage?.message ||
    content?.documentWithCaptionMessage?.message ||
    // unwrap lottieStickerMessage to inner message (often stickerMessage)
    (content as any)?.lottieStickerMessage?.message ||
    content ||
    undefined
  return (content || undefined) as any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getBinMessage = (waMessage: WAMessage): { messageType: string; message: any } | undefined => {
  const message: proto.IMessage | undefined = (normalizeMessageContent(waMessage.message) || undefined) as any
  const messageType = getMessageType({ message })
  if (message && messageType && message[messageType]) {
    return { messageType, message: message[messageType] }
  }
}

export const getNormalizedMessage = (waMessage: WAMessage): WAMessage | undefined => {
  const binMessage = getBinMessage(waMessage)
  if (binMessage) {
    let { message } = binMessage
    // unwrap edited message to the inner original message
    if (message?.editedMessage?.message) {
      message = message.editedMessage.message
    } else if (message?.protocolMessage?.editedMessage?.message) {
      message = message.protocolMessage.editedMessage.message
    }
    return { key: waMessage.key, message: { [binMessage.messageType]: message } }
  }
}

export const isSaveMedia = (message: WAMessage) => {
  const normalizedMessage = getNormalizedMessage(message)
  const messageType = normalizedMessage && getMessageType(normalizedMessage)
  return messageType && TYPE_MESSAGES_TO_PROCESS_FILE.includes(messageType)
}

export const extractTypeMessage = (payload: object) => {
  const data = payload as any
  return (
    (
      data?.entry &&
      data.entry[0] &&
      data.entry[0].changes &&
      data.entry[0].changes[0] &&
      data.entry[0].changes[0].value
    ) &&
    (
      data.entry[0].changes[0].value.messages &&
      data.entry[0].changes[0].value.messages[0] &&
      data.entry[0].changes[0].value.messages[0].type
    )
  )
}

export const isAudioMessage = (payload: object) => {
  return 'audio' == extractTypeMessage(payload)
}
