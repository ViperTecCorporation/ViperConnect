import { proto } from 'zapo-js'
import logger from '../../src/services/logger'
import { traceCompanionOutgoing } from '../../src/services/mobile_primary/companion_outgoing_trace'
jest.mock('../../src/services/logger', () => ({ __esModule: true, default: { info: jest.fn() } }))
beforeEach(() => jest.clearAllMocks())
test('observes submitted response, preserves invocation and result, and restores', async () => {
  const result = { id: 'secret-outgoing' }
  const original = jest.fn().mockResolvedValue(result)
  const dispatch = { publishProtocolMessageToDevice: original }
  const dispose = traceCompanionOutgoing(dispatch, 'draft')
  const message: proto.Message.IProtocolMessage = {
    type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
    peerDataOperationRequestResponseMessage: { stanzaId: 'secret-request', peerDataOperationResult: [] },
  }
  expect(await dispatch.publishProtocolMessageToDevice('secret-peer', message, { id: 'secret-outgoing' })).toBe(result)
  expect(original).toHaveBeenCalledTimes(1)
  expect(original.mock.contexts[0]).toBe(dispatch)
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ direction: 'outgoing-submitted', resultCount: 0 }), 'MOBILE_COMPANION_PEER_RESPONSE_OBSERVED')
  expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('secret-')
  dispose(); expect(dispatch.publishProtocolMessageToDevice).toBe(original)
})
test('preserves failure and does not log it as submitted', async () => {
  const error = new Error('secret-error'), original = jest.fn().mockRejectedValue(error)
  const dispatch = { publishProtocolMessageToDevice: original }
  const dispose = traceCompanionOutgoing(dispatch, 'draft')
  await expect(dispatch.publishProtocolMessageToDevice('target', {})).rejects.toBe(error)
  expect(logger.info).not.toHaveBeenCalled()
  dispose()
})
