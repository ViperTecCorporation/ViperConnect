import { createHash } from 'node:crypto'
import { proto } from 'zapo-js'
import logger from '../logger'

const hash = (value: unknown) => typeof value === 'string' && value.length > 0
  ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined

/** Metadata only. This observer never acknowledges, responds or starts a job. */
export function traceCompanionHistoryRequest(event: {
  key: { id?: string; remoteJid?: string; participant?: string; fromMe?: boolean }
  protocolMessage: proto.Message.IProtocolMessage
}, device: string, direction: 'incoming' | 'outgoing-submitted' = 'incoming'): void {
  const protocol = event.protocolMessage
  if (protocol.type === proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE) {
    const response = protocol.peerDataOperationRequestResponseMessage
    if (response) logger.info({ device, direction, requestHash: hash(response.stanzaId),
      peerHash: hash(event.key.remoteJid), resultCount: response.peerDataOperationResult?.length ?? 0,
    }, 'MOBILE_COMPANION_PEER_RESPONSE_OBSERVED')
    return
  }
  if (protocol.type !== proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE) return
  const request = protocol.peerDataOperationRequestMessage
  if (!request) return
  const history = request.historySyncOnDemandRequest
  logger.info({ device, direction, requestHash: hash(event.key.id), senderHash: hash(event.key.remoteJid),
    participantHash: hash(event.key.participant), fromMe: event.key.fromMe === true,
    requestType: request.peerDataOperationRequestType,
    historyRequested: !!history, chatHash: hash(history?.chatJid), oldestMessageHash: hash(history?.oldestMsgId),
    requestedCount: typeof history?.onDemandMsgCount === 'number' ? history.onDemandMsgCount : undefined,
    hasOldestTimestamp: history?.oldestMsgTimestampMs != null,
    inlineResponseSupported: history?.supportInlineResponse === true,
  }, 'MOBILE_COMPANION_PEER_REQUEST_OBSERVED')
}
