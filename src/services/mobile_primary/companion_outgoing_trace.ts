import type { proto } from 'zapo-js'
import { traceCompanionHistoryRequest } from './companion_history_request_trace'

/** Observe resolved SDK publications; no extra send, retry or protocol response. */
export function traceCompanionOutgoing<T extends { publishProtocolMessageToDevice: (...args: any[]) => Promise<any> }>(dispatch: T, device: string) {
  const original = dispatch.publishProtocolMessageToDevice
  const wrapped = async function (this: T, target: string, message: proto.Message.IProtocolMessage, ...rest: any[]) {
    const result = await original.call(this, target, message, ...rest)
    traceCompanionHistoryRequest({ key: { remoteJid: target, id: result?.id }, protocolMessage: message }, device, 'outgoing-submitted')
    return result
  }
  dispatch.publishProtocolMessageToDevice = wrapped
  return () => { if (dispatch.publishProtocolMessageToDevice === wrapped) dispatch.publishProtocolMessageToDevice = original }
}
