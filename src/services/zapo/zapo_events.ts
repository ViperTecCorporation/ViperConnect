import type { WaIncomingAddonEvent, WaIncomingMessageEvent, WaIncomingReceiptEvent } from 'zapo-js'

export const isEncryptedZapoAddonMessage = (message: WaIncomingMessageEvent['message']) => Boolean(
  (message?.encReactionMessage?.targetMessageKey
    && message.encReactionMessage.encPayload
    && message.encReactionMessage.encIv)
  || (message?.pollUpdateMessage?.pollCreationMessageKey
    && message.pollUpdateMessage.vote?.encPayload
    && message.pollUpdateMessage.vote.encIv)
  || (message?.encEventResponseMessage?.eventCreationMessageKey
    && message.encEventResponseMessage.encPayload
    && message.encEventResponseMessage.encIv)
  || (message?.encCommentMessage?.targetMessageKey
    && message.encCommentMessage.encPayload
    && message.encCommentMessage.encIv)
  || (message?.secretEncryptedMessage?.targetMessageKey
    && message.secretEncryptedMessage.encPayload
    && message.secretEncryptedMessage.encIv)
)

export const toUnoMessageEvent = (event: WaIncomingMessageEvent) => ({
  key: { ...event.key },
  message: event.message,
  messageTimestamp: event.timestampSeconds,
  pushName: event.pushName,
})

const receiptStatus = (status: WaIncomingReceiptEvent['status']) => ({
  delivered: 'DELIVERY_ACK',
  read: 'READ',
  played: 'PLAYED',
}[status])

export const toUnoReceiptUpdates = (event: WaIncomingReceiptEvent, phoneJid?: string) => {
  const status = receiptStatus(event.status)
  if (!status) return []
  // The typed receipt has no timestamp field; Zapo preserves the original stanza.
  // Never substitute message creation time or local webhook arrival time.
  const rawTimestamp = event.rawNode?.attrs?.t
  const timestamp = typeof rawTimestamp === 'string' && /^\d+$/.test(rawTimestamp) ? Number(rawTimestamp) : 0
  const hasTimestamp = Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= Math.floor(Date.now() / 1000) + 300
  return event.messageIds.map((id) => ({
    key: {
      remoteJid: event.chatJid,
      ...(phoneJid ? { remoteJidAlt: phoneJid } : {}),
      id,
      fromMe: true,
      ...(event.participantJid ? { participant: event.participantJid } : {}),
    },
    update: { status },
    ...(hasTimestamp ? { messageTimestamp: timestamp } : {}),
  }))
}

export const toUnoAddonEvent = (event: WaIncomingAddonEvent) => {
  const target = { ...event.key, id: event.targetMessageId }
  const decrypted = event.decrypted
  let message: Record<string, unknown>
  switch (decrypted.kind) {
    case 'reaction':
      message = { reactionMessage: { ...decrypted.reaction, key: decrypted.reaction?.key || target } }
      break
    case 'poll_vote':
      message = {
        pollUpdateMessage: {
          pollCreationMessageKey: target,
          vote: {
            ...decrypted.pollVote,
            ...(Array.isArray(decrypted.selectedOptionNames)
              ? { selectedOptionNames: decrypted.selectedOptionNames }
              : {}),
          },
        },
      }
      break
    case 'event_response':
      message = { eventResponseMessage: decrypted.eventResponse }
      break
    case 'comment':
      message = { commentMessage: decrypted.comment }
      break
    case 'message_edit':
    case 'event_edit':
    case 'poll_edit':
    case 'poll_add_option':
      message = {
        protocolMessage: {
          key: target,
          type: 'MESSAGE_EDIT',
          editedMessage: decrypted.message,
        },
      }
      break
  }
  return {
    key: { ...event.key },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  }
}
