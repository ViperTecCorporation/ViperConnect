import type { proto } from 'zapo-js'
import { traceCompanionHistoryRequest } from './companion_history_request_trace'

/** Observe resolved SDK publications; no extra send, retry or protocol response. */
export function traceCompanionOutgoing<T extends { publishProtocolMessageToDevice: (...args: any[]) => Promise<any> }>(dispatch: T, device: string,
  receipts?: { track(id: string, target: string, order: number): void }) {
  const original = dispatch.publishProtocolMessageToDevice
  const wrapped = async function (this: T, target: string, message: proto.Message.IProtocolMessage, ...rest: any[]) {
    const history = message.historySyncNotification
    // Register before publication so a fast ACK is not missed. Only IDs already
    // assigned by the SDK are observed; never generate or replace a wire ID.
    if (history && typeof rest[0]?.id === 'string') {
      try { receipts?.track(rest[0].id, target, history.chunkOrder ?? 0) } catch { /* observer only */ }
    }
    const result = await original.call(this, target, message, ...rest)
    if (history && typeof rest[0]?.id !== 'string' && typeof result?.id === 'string') {
      // The native bootstrap lets the SDK allocate the ID. Its server ACK may
      // already have arrived, but later device receipts can still be correlated.
      try { receipts?.track(result.id, target, history.chunkOrder ?? 0) } catch { /* observer only */ }
    }
    traceCompanionHistoryRequest({ key: { remoteJid: target, id: result?.id }, protocolMessage: message }, device, 'outgoing-submitted')
    return result
  }
  dispatch.publishProtocolMessageToDevice = wrapped
  return () => { if (dispatch.publishProtocolMessageToDevice === wrapped) dispatch.publishProtocolMessageToDevice = original }
}
