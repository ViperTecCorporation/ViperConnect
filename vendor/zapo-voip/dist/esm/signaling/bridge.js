import { createNoopLogger } from 'zapo-js';
import { isLidJid, normalizeDeviceJid, toUserJid, WA_CALL_RECEIPT_PAYLOAD_TAGS } from 'zapo-js/protocol';
import { buildAckNode, buildReceiptNode, getFirstNodeChild } from 'zapo-js/transport';
import { toError } from 'zapo-js/util';
import { summarizeCallEnvelope } from './signaling-diagnostics.js';
import { buildRejectStanza } from './signaling.js';
const RECEIPT_CALL_TAGS = new Set([
    'offer',
    'accept',
    'preaccept',
    'terminate',
    'transport',
    'relaylatency',
    'mute_v2'
]);
const ZAPO_CALL_RECEIPT_TAGS = new Set(WA_CALL_RECEIPT_PAYLOAD_TAGS);
function buildCallResponse(deps, node, inner) {
    const peerJid = node.attrs.from;
    const stanzaId = node.attrs.id;
    if (ZAPO_CALL_RECEIPT_TAGS.has(inner.tag) &&
        inner.attrs?.['call-id'] &&
        inner.attrs?.['call-creator']) {
        const credentials = deps.authClient.getCurrentCredentials();
        let fromJid;
        try {
            fromJid = isLidJid(peerJid)
                ? credentials?.meLid
                    ? normalizeDeviceJid(credentials.meLid)
                    : undefined
                : credentials?.meJid
                    ? toUserJid(credentials.meJid)
                    : undefined;
        }
        catch {
            fromJid = undefined;
        }
        return buildReceiptNode({
            kind: 'custom',
            attrs: {
                id: stanzaId,
                to: peerJid,
                ...(fromJid ? { from: fromJid } : {})
            },
            content: [
                {
                    tag: inner.tag,
                    attrs: {
                        'call-id': inner.attrs['call-id'],
                        'call-creator': inner.attrs['call-creator']
                    }
                }
            ]
        });
    }
    return buildAckNode({
        kind: 'custom',
        ackClass: 'call',
        to: peerJid,
        id: stanzaId,
        type: inner.tag
    });
}
export async function routeCallStanza(manager, deps, node, logger, allowOffers = true) {
    const log = logger ?? createNoopLogger();
    const inner = getFirstNodeChild(node);
    if (!inner)
        return null;
    const tag = inner.tag;
    const peerJid = node.attrs.from;
    const response = buildCallResponse(deps, node, inner);
    const deferResponseUntilHandled = tag === 'mute_v2';
    if (!deferResponseUntilHandled) {
        await deps.lowLevelCoordinator.sendNode(response);
    }
    let normalizedPeerJid;
    try {
        normalizedPeerJid = normalizeDeviceJid(peerJid);
    }
    catch (err) {
        if (deferResponseUntilHandled) {
            await deps.lowLevelCoordinator.sendNode(response);
        }
        log.warn('failed to normalize call peer jid', {
            from: peerJid,
            message: toError(err).message
        });
        return tag;
    }
    log.debug('voip_diag inbound_call_envelope', {
        callId: inner.attrs?.['call-id'],
        tag,
        rawPeerJid: peerJid,
        normalizedPeerJid,
        responseDeferred: deferResponseUntilHandled,
        received: summarizeCallEnvelope(node),
        response: summarizeCallEnvelope(response)
    });
    switch (tag) {
        case 'offer':
            if (!allowOffers) {
                const callId = inner.attrs?.['call-id'];
                if (callId)
                    await deps.lowLevelCoordinator.sendNode(buildRejectStanza(peerJid, callId, inner.attrs?.['call-creator'] || normalizedPeerJid));
            }
            else
                await manager.handleCallOffer(node, normalizedPeerJid);
            break;
        case 'preaccept':
            await manager.handleCallPreaccept(node, normalizedPeerJid);
            break;
        case 'accept':
            await manager.handleCallAccept(node, normalizedPeerJid);
            break;
        case 'transport':
            await manager.handleCallTransport(node, normalizedPeerJid);
            break;
        case 'terminate':
            await manager.handleCallTerminate(node);
            break;
        case 'relaylatency':
            await manager.handleCallRelaylatency(node, normalizedPeerJid);
            break;
        case 'mute_v2':
            try {
                await manager.handleCallMuteV2(node, normalizedPeerJid);
            }
            finally {
                await deps.lowLevelCoordinator.sendNode(response);
            }
            break;
        case 'relay_election':
            manager.handleRelayElection(node);
            break;
        case 'reject':
            await manager.handleCallReject(node);
            break;
        default:
            break;
    }
    return tag;
}
export async function routeCallAck(manager, node, logger) {
    const log = logger ?? createNoopLogger();
    log.debug('voip_diag inbound_call_ack_envelope', {
        stanzaId: node.attrs?.id,
        type: node.attrs?.type,
        error: node.attrs?.error,
        from: node.attrs?.from,
        to: node.attrs?.to,
        envelope: summarizeCallEnvelope(node)
    });
    await manager.handleCallAck(node);
}
export async function routeCallReceipt(deps, node, logger) {
    const inner = getFirstNodeChild(node);
    if (!inner)
        return false;
    if (!RECEIPT_CALL_TAGS.has(inner.tag))
        return false;
    const peerJid = node.attrs.from;
    const response = buildAckNode({
        kind: 'custom',
        ackClass: 'receipt',
        to: peerJid,
        id: node.attrs.id,
        type: node.attrs.type || 'retry'
    });
    await deps.lowLevelCoordinator.sendNode(response);
    const log = logger ?? createNoopLogger();
    log.debug('voip_diag inbound_call_receipt_envelope', {
        stanzaId: node.attrs?.id,
        type: node.attrs?.type,
        innerTag: inner.tag,
        from: node.attrs?.from,
        to: node.attrs?.to,
        received: summarizeCallEnvelope(node),
        response: summarizeCallEnvelope(response)
    });
    return true;
}
