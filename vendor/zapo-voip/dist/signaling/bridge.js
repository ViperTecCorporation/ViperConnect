"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeCallStanza = routeCallStanza;
exports.routeCallAck = routeCallAck;
exports.routeCallReceipt = routeCallReceipt;
const zapo_js_1 = require("zapo-js");
const protocol_1 = require("zapo-js/protocol");
const transport_1 = require("zapo-js/transport");
const util_1 = require("zapo-js/util");
const signaling_diagnostics_js_1 = require("./signaling-diagnostics.js");
const signaling_js_1 = require("./signaling.js");
const RECEIPT_CALL_TAGS = new Set([
    'offer',
    'accept',
    'preaccept',
    'terminate',
    'transport',
    'relaylatency',
    'mute_v2'
]);
const ZAPO_CALL_RECEIPT_TAGS = new Set(protocol_1.WA_CALL_RECEIPT_PAYLOAD_TAGS);
function buildCallResponse(deps, node, inner) {
    const peerJid = node.attrs.from;
    const stanzaId = node.attrs.id;
    if (ZAPO_CALL_RECEIPT_TAGS.has(inner.tag) &&
        inner.attrs?.['call-id'] &&
        inner.attrs?.['call-creator']) {
        const credentials = deps.authClient.getCurrentCredentials();
        let fromJid;
        try {
            fromJid = (0, protocol_1.isLidJid)(peerJid)
                ? credentials?.meLid
                    ? (0, protocol_1.normalizeDeviceJid)(credentials.meLid)
                    : undefined
                : credentials?.meJid
                    ? (0, protocol_1.toUserJid)(credentials.meJid)
                    : undefined;
        }
        catch {
            fromJid = undefined;
        }
        return (0, transport_1.buildReceiptNode)({
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
    return (0, transport_1.buildAckNode)({
        kind: 'custom',
        ackClass: 'call',
        to: peerJid,
        id: stanzaId,
        type: inner.tag
    });
}
async function routeCallStanza(manager, deps, node, logger, allowOffers = true) {
    const log = logger ?? (0, zapo_js_1.createNoopLogger)();
    const inner = (0, transport_1.getFirstNodeChild)(node);
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
        normalizedPeerJid = (0, protocol_1.normalizeDeviceJid)(peerJid);
    }
    catch (err) {
        if (deferResponseUntilHandled) {
            await deps.lowLevelCoordinator.sendNode(response);
        }
        log.warn('failed to normalize call peer jid', {
            from: peerJid,
            message: (0, util_1.toError)(err).message
        });
        return tag;
    }
    log.debug('voip_diag inbound_call_envelope', {
        callId: inner.attrs?.['call-id'],
        tag,
        rawPeerJid: peerJid,
        normalizedPeerJid,
        responseDeferred: deferResponseUntilHandled,
        received: (0, signaling_diagnostics_js_1.summarizeCallEnvelope)(node),
        response: (0, signaling_diagnostics_js_1.summarizeCallEnvelope)(response)
    });
    switch (tag) {
        case 'offer':
            if (!allowOffers) {
                const callId = inner.attrs?.['call-id'];
                if (callId)
                    await deps.lowLevelCoordinator.sendNode((0, signaling_js_1.buildRejectStanza)(peerJid, callId, inner.attrs?.['call-creator'] || normalizedPeerJid));
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
async function routeCallAck(manager, node, logger) {
    const log = logger ?? (0, zapo_js_1.createNoopLogger)();
    log.debug('voip_diag inbound_call_ack_envelope', {
        stanzaId: node.attrs?.id,
        type: node.attrs?.type,
        error: node.attrs?.error,
        from: node.attrs?.from,
        to: node.attrs?.to,
        envelope: (0, signaling_diagnostics_js_1.summarizeCallEnvelope)(node)
    });
    await manager.handleCallAck(node);
}
async function routeCallReceipt(deps, node, logger) {
    const inner = (0, transport_1.getFirstNodeChild)(node);
    if (!inner)
        return false;
    if (!RECEIPT_CALL_TAGS.has(inner.tag))
        return false;
    const peerJid = node.attrs.from;
    const response = (0, transport_1.buildAckNode)({
        kind: 'custom',
        ackClass: 'receipt',
        to: peerJid,
        id: node.attrs.id,
        type: node.attrs.type || 'retry'
    });
    await deps.lowLevelCoordinator.sendNode(response);
    const log = logger ?? (0, zapo_js_1.createNoopLogger)();
    log.debug('voip_diag inbound_call_receipt_envelope', {
        stanzaId: node.attrs?.id,
        type: node.attrs?.type,
        innerTag: inner.tag,
        from: node.attrs?.from,
        to: node.attrs?.to,
        received: (0, signaling_diagnostics_js_1.summarizeCallEnvelope)(node),
        response: (0, signaling_diagnostics_js_1.summarizeCallEnvelope)(response)
    });
    return true;
}
