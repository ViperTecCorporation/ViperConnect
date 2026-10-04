import { proto } from 'zapo-js'
import logger from '../../src/services/logger'
import { traceCompanionHistoryRequest } from '../../src/services/mobile_primary/companion_history_request_trace'
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn() } }))
beforeEach(() => jest.clearAllMocks())
test('records history request metadata without raw identifiers or content', () => {
  traceCompanionHistoryRequest({ key: { id: 'secret-id', remoteJid: 'private-device' }, protocolMessage: {
    type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE,
    peerDataOperationRequestMessage: { peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
      historySyncOnDemandRequest: { chatJid: 'private-chat', oldestMsgId: 'private-message', onDemandMsgCount: 25, supportInlineResponse: true } },
  } }, 'draft')
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ historyRequested: true, requestedCount: 25, inlineResponseSupported: true }), 'MOBILE_COMPANION_PEER_REQUEST_OBSERVED')
  const output = JSON.stringify((logger.info as jest.Mock).mock.calls)
  for (const value of ['private-device', 'private-chat', 'private-message', 'secret-id']) expect(output).not.toContain(value)
})
test('ignores unrelated protocols and absent request bodies', () => {
  traceCompanionHistoryRequest({ key: {}, protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } }, 'draft')
  traceCompanionHistoryRequest({ key: {}, protocolMessage: { type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE } }, 'draft')
  expect(logger.info).not.toHaveBeenCalled()
})
test('observes other peer request types without inventing a history request', () => {
  traceCompanionHistoryRequest({ key: {}, protocolMessage: { type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE, peerDataOperationRequestMessage: {} } }, 'draft')
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ historyRequested: false }), 'MOBILE_COMPANION_PEER_REQUEST_OBSERVED')
})
