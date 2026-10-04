"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaCallManager = void 0;
const node_events_1 = require("node:events");
const zapo_js_1 = require("zapo-js");
const protocol_1 = require("zapo-js/protocol");
const transport_1 = require("zapo-js/transport");
const util_1 = require("zapo-js/util");
const encryption_js_1 = require("../crypto/encryption.js");
const WaAudioEngine_js_1 = require("../media/WaAudioEngine.js");
const relay_ack_js_1 = require("../relay/relay-ack.js");
const relay_diagnostics_js_1 = require("../relay/relay-diagnostics.js");
const signaling_js_1 = require("../signaling/signaling.js");
const voip_settings_js_1 = require("../signaling/voip-settings.js");
const types_js_1 = require("../types.js");
const call_state_js_1 = require("./call-state.js");
const WaCallMediaSession_js_1 = require("./WaCallMediaSession.js");
const DEFAULT_MAX_CONCURRENT_CALLS = 1;
const MAX_PENDING_RELAYLATENCY_PER_CALL = 8;
const MAX_PENDING_RELAYLATENCY_CALLS = 32;
const PENDING_RELAYLATENCY_TTL_MS = 15_000;
const FORCE_SELF_MEDIA_ZERO_LID = String(process.env.ZAPO_VOIP_FORCE_SELF_MEDIA_ZERO_LID ?? '').toLowerCase() === 'true';
function toZeroDeviceLid(jid) {
    const bare = jid.split('/', 1)[0].trim();
    const at = bare.lastIndexOf('@');
    if (at <= 0)
        return bare;
    const user = bare.slice(0, at);
    const domain = bare.slice(at + 1);
    if (domain !== 'lid')
        return bare;
    const base = user.split(':', 1)[0];
    return `${base}:0@${domain}`;
}
function resolveSelfMediaJid(jid) {
    if (!FORCE_SELF_MEDIA_ZERO_LID)
        return jid;
    return toZeroDeviceLid(jid);
}
class WaCallManager extends node_events_1.EventEmitter {
    deps;
    stores;
    logger;
    maxConcurrentCalls;
    preferWebRelayPort;
    calls = new Map();
    pendingRelaylatency = new Map();
    constructor(config) {
        super();
        this.deps = config.deps;
        this.stores = config.stores;
        this.preferWebRelayPort = config.preferWebRelayPort === true;
        this.logger = config.logger ?? (0, zapo_js_1.createNoopLogger)();
        this.maxConcurrentCalls = (0, util_1.resolvePositive)(config.maxConcurrentCalls, DEFAULT_MAX_CONCURRENT_CALLS, 'maxConcurrentCalls');
    }
    async startCall(options) {
        if (this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
        const callId = (0, signaling_js_1.generateCallId)();
        const mediaType = options.isVideo ? types_js_1.CallMediaType.Video : types_js_1.CallMediaType.Audio;
        const creds = this.deps.authClient.getCurrentCredentials();
        const callCreator = creds?.meLid || creds?.meJid || '';
        const peerJid = await this.resolvePeerLid(options.peerJid);
        const peerDevices = await this.prepareOutgoingPeer(options.peerJid, peerJid, options.peerDevices);
        const info = call_state_js_1.CallInfo.newOutgoing(callId, peerJid, callCreator, mediaType);
        const callKey = (0, encryption_js_1.generateCallKey)();
        info.encryptionKey = callKey;
        const session = this.createSession(info);
        const selfLid = creds?.meLid || creds?.meJid || '';
        const selfMediaJid = resolveSelfMediaJid(selfLid);
        try {
            await session.initMedia(selfMediaJid, peerJid);
            const offerStanza = await (0, signaling_js_1.buildOfferStanza)(this.deps, this.stores, callId, callKey, peerJid, options.isVideo ?? false, this.logger.child({ component: 'signaling' }), peerDevices);
            await this.deps.lowLevelCoordinator.sendNode(offerStanza);
        }
        catch (err) {
            session.cleanup();
            this.calls.delete(callId);
            throw err;
        }
        info.applyTransition({ type: 'offer_sent' });
        this.emitState(info);
        this.logger.debug('outgoing offer sent', { callId, peerJid, peerDevices });
        this.logger.debug('voip_diag outgoing_offer_identity', {
            callId,
            requestedPeerJid: options.peerJid,
            resolvedPeerJid: peerJid,
            peerDevices,
            callCreator,
            meJid: creds?.meJid,
            meLid: creds?.meLid,
            selfMediaJid,
            forceSelfMediaZeroLid: FORCE_SELF_MEDIA_ZERO_LID,
            mediaType
        });
        return callId;
    }
    async acceptCall(callId) {
        const session = this.getSessionOrThrow(callId);
        if (!session.info.canAccept) {
            throw new Error(`Call ${callId} cannot be accepted in state ${session.info.stateData.state}`);
        }
        await session.acceptCall();
    }
    async rejectCall(callId, reason = types_js_1.EndCallReason.Declined) {
        const session = this.getSessionOrThrow(callId);
        await session.rejectCall(reason);
        this.calls.delete(callId);
        await this.maybeUnblockWaitingCalls();
    }
    async endCall(callId, reason = types_js_1.EndCallReason.UserEnded) {
        const session = this.calls.get(callId);
        if (!session || session.info.isEnded)
            return;
        await session.endCall(reason);
        this.calls.delete(callId);
        await this.maybeUnblockWaitingCalls();
    }
    setMute(callId, muted) {
        const session = this.calls.get(callId);
        session?.setMute(muted);
    }
    async loadAudio(callId, audioPath) {
        const session = this.getSessionOrThrow(callId);
        await session.loadAudio(audioPath);
    }
    setExternalAudioMode(callId, enabled) {
        const session = this.getSessionOrThrow(callId);
        session.setExternalAudioMode(enabled);
    }
    feedLiveAudio(callId, data) {
        const session = this.calls.get(callId);
        return session?.feedLiveAudio(data) ?? 0;
    }
    getLiveBufferMs(callId) {
        const session = this.calls.get(callId);
        return session?.getLiveBufferMs() ?? 0;
    }
    getFeedWatermarksMs() {
        return WaAudioEngine_js_1.WaAudioEngine.feedWatermarksMs();
    }
    getCall(callId) {
        return this.calls.get(callId)?.info ?? null;
    }
    getCalls() {
        const result = [];
        for (const session of this.calls.values()) {
            result.push(session.info);
        }
        return result;
    }
    async handleCallOffer(node, peerJid) {
        const nodeInfo = (0, signaling_js_1.extractNodeInfo)(node);
        if (!nodeInfo?.callId)
            return;
        const callId = nodeInfo.callId;
        const offerAttrs = nodeInfo.innerNode.attrs;
        if (offerAttrs?.is_call_ended === '1' || !!offerAttrs?.terminate_reason) {
            this.logger.debug('already-ended offer ignored', {
                callId,
                terminateReason: offerAttrs?.terminate_reason
            });
            return;
        }
        const existing = this.calls.get(callId);
        if (existing) {
            if (!existing.info.isEnded) {
                this.logger.debug('duplicate offer for active call, ignoring', { callId });
                return;
            }
            existing.cleanup();
            this.calls.delete(callId);
        }
        const callCreator = nodeInfo.innerNode.attrs?.['call-creator'] || peerJid;
        const isVideo = (0, transport_1.hasNodeChild)(nodeInfo.innerNode, 'video');
        const callKey = await (0, signaling_js_1.decryptCallKey)(this.deps, nodeInfo.innerNode, peerJid, this.logger.child({ component: 'signaling' }));
        const relaySignaling = (0, relay_diagnostics_js_1.summarizeRelaySignaling)(nodeInfo.innerNode);
        const { relays, participantJids, selfParticipantJid, peerParticipantJid, uuid, selfPid, peerPid, hbhKey } = (0, relay_ack_js_1.parseRelayFromAck)(nodeInfo.innerNode);
        const mediaType = isVideo ? types_js_1.CallMediaType.Video : types_js_1.CallMediaType.Audio;
        const info = call_state_js_1.CallInfo.newIncoming(callId, peerJid, callCreator, undefined, mediaType);
        const voipSettings = (0, voip_settings_js_1.parseVoipSettingsFromNode)(nodeInfo.innerNode);
        if (callKey) {
            info.encryptionKey = callKey;
        }
        if (relays.length > 0) {
            info.relayData = {
                endpoints: relays,
                participantJids,
                selfParticipantJid,
                peerParticipantJid,
                uuid,
                selfPid,
                peerPid,
                hbhKey
            };
        }
        this.logger.debug('voip_diag incoming_offer_identity', {
            callId,
            peerJid,
            callCreator,
            meJid: this.deps.authClient.getCurrentCredentials()?.meJid,
            meLid: this.deps.authClient.getCurrentCredentials()?.meLid,
            isVideo,
            hasCallKey: !!callKey,
            relayCount: relays.length,
            relaySignaling,
            participantJids,
            selfParticipantJid,
            peerParticipantJid,
            selfPid,
            peerPid,
            relayCandidates: relays.map((relay) => ({
                relayName: relay.relayName,
                relayId: relay.relayId,
                ip: relay.ip,
                port: relay.port,
                protocol: relay.protocol ?? 0,
                c2rRtt: relay.c2rRtt,
                isFna: relay.isFna === true,
                tokenId: relay.tokenId,
                tokenBytes: relay.rawToken?.length ?? 0,
                authTokenId: relay.authTokenId,
                authTokenBytes: relay.rawAuthToken?.length ?? 0
            })),
            codecMode: voipSettings.codecMode,
            voipSettingsPresent: voipSettings.present,
            voipSettingsMalformed: voipSettings.malformed,
            voipFrameMs: voipSettings.frameMs,
            voipTargetBitrate: voipSettings.targetBitrate
        });
        const atCapacity = this.activeCallCount >= this.maxConcurrentCalls;
        const session = this.createSession(info, { acceptBlocked: atCapacity });
        await session.configureVoipSettings(voipSettings, 'incoming_offer', true);
        if (!atCapacity) {
            try {
                const creds = this.deps.authClient.getCurrentCredentials();
                const selfLid = creds?.meLid || creds?.meJid || '';
                await session.initMedia(selfLid, peerParticipantJid || peerJid);
                await session.sendIncomingPreaccept(peerJid);
                await this.replayPendingRelaylatency(session);
            }
            catch (err) {
                this.logger.error('incoming call activation failed', {
                    callId,
                    message: (0, util_1.toError)(err).message
                });
                try {
                    info.applyTransition({ type: 'terminated', reason: types_js_1.EndCallReason.Failed });
                }
                catch (transitionErr) {
                    this.logger.trace('failed-activation transition skipped', {
                        message: (0, util_1.toError)(transitionErr).message
                    });
                }
                this.emit('call_ended', info);
                this.emitState(info);
                session.cleanup();
                this.calls.delete(callId);
                this.pendingRelaylatency.delete(callId);
                await this.maybeUnblockWaitingCalls();
                return;
            }
        }
        else {
            this.logger.debug('incoming call waiting, at capacity', {
                callId,
                peerJid,
                maxConcurrentCalls: this.maxConcurrentCalls
            });
        }
        this.emit('call_incoming', info);
        this.emitState(info);
        this.logger.debug('incoming call', {
            callId,
            peerJid,
            callCreator,
            isVideo,
            relayCount: relays.length,
            acceptBlocked: atCapacity
        });
    }
    async handleCallAccept(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallAccept(node, peerJid);
    }
    async handleCallPreaccept(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallPreaccept(node, peerJid);
    }
    async handleCallTransport(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallTransport(node);
    }
    async handleCallAck(node) {
        if (node.attrs?.type !== 'offer')
            return;
        const session = this.resolveSessionForOfferAck(node);
        if (!session)
            return;
        if (node.attrs?.error) {
            session.handleCallAckError(node.attrs.error);
            this.calls.delete(session.callId);
            await this.maybeUnblockWaitingCalls();
            return;
        }
        await session.handleCallAck(node);
    }
    async handleCallReject(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        if (!session.info.isInitiator) {
            this.logger.debug('reject ignored for incoming call', {
                callId: session.callId,
                from: node.attrs?.from,
                state: session.info.stateData.state
            });
            return;
        }
        session.handleCallReject();
        this.calls.delete(session.callId);
        this.pendingRelaylatency.delete(session.callId);
        await this.maybeUnblockWaitingCalls();
    }
    async handleCallRelaylatency(node, peerJid) {
        const nodeInfo = (0, signaling_js_1.extractNodeInfo)(node);
        if (!nodeInfo?.callId)
            return;
        const session = this.calls.get(nodeInfo.callId);
        if (!session) {
            const now = Date.now();
            for (const [pendingCallId, entries] of this.pendingRelaylatency) {
                const fresh = entries.filter((entry) => now - entry.receivedAt <= PENDING_RELAYLATENCY_TTL_MS);
                if (fresh.length === 0)
                    this.pendingRelaylatency.delete(pendingCallId);
                else if (fresh.length !== entries.length) {
                    this.pendingRelaylatency.set(pendingCallId, fresh);
                }
            }
            while (this.pendingRelaylatency.size >= MAX_PENDING_RELAYLATENCY_CALLS) {
                const oldestCallId = this.pendingRelaylatency.keys().next().value;
                if (!oldestCallId)
                    break;
                this.pendingRelaylatency.delete(oldestCallId);
            }
            const pending = this.pendingRelaylatency.get(nodeInfo.callId) ?? [];
            if (pending.length >= MAX_PENDING_RELAYLATENCY_PER_CALL)
                pending.shift();
            pending.push({ node, peerJid, receivedAt: now });
            this.pendingRelaylatency.set(nodeInfo.callId, pending);
            this.logger.debug('voip_diag relaylatency_queued_before_session', {
                callId: nodeInfo.callId,
                peerJid,
                queued: pending.length
            });
            return;
        }
        await session.handleCallRelaylatency(node, peerJid);
    }
    handleRelayElection(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleRelayElection(node);
    }
    async handleCallMuteV2(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallMuteV2(node, peerJid);
    }
    async handleCallTerminate(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallTerminate();
        this.calls.delete(session.callId);
        this.pendingRelaylatency.delete(session.callId);
        await this.maybeUnblockWaitingCalls();
    }
    destroy() {
        for (const session of this.calls.values()) {
            session.cleanup();
        }
        this.calls.clear();
        this.pendingRelaylatency.clear();
        this.removeAllListeners();
    }
    get activeCallCount() {
        let count = 0;
        for (const session of this.calls.values()) {
            if (!session.info.isEnded && !session.info.isAcceptBlocked)
                count++;
        }
        return count;
    }
    createSession(info, options = {}) {
        const prior = this.calls.get(info.callId);
        if (prior) {
            if (!prior.info.isEnded) {
                throw new Error(`call ${info.callId} already exists`);
            }
            prior.cleanup();
            this.calls.delete(info.callId);
        }
        const acceptBlocked = options.acceptBlocked ?? false;
        if (!acceptBlocked && this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
        if (acceptBlocked) {
            info.stateData.acceptBlocked = true;
        }
        const sessionLogger = this.logger.child({ callId: info.callId });
        const session = new WaCallMediaSession_js_1.WaCallMediaSession({
            preferWebRelayPort: this.preferWebRelayPort,
            deps: this.deps,
            logger: sessionLogger,
            info,
            delegate: {
                emitState: (call) => this.emitState(call),
                emitIncoming: (call) => this.emit('call_incoming', call),
                emitEnded: (call) => this.emit('call_ended', call),
                emitInboundAudio: (call, pcm) => this.emit('call_inbound_audio', call, pcm),
                emitOutboundAudioFinished: (call) => this.emit('call_outbound_audio_finished', call)
            }
        });
        this.calls.set(info.callId, session);
        return session;
    }
    getSessionOrThrow(callId) {
        const session = this.calls.get(callId);
        if (!session) {
            throw new Error(`No call with id ${callId}`);
        }
        return session;
    }
    resolveSessionFromNode(node) {
        const nodeInfo = (0, signaling_js_1.extractNodeInfo)(node);
        if (!nodeInfo?.callId) {
            this.logger.debug('stanza missing call-id, ignored');
            return null;
        }
        const session = this.calls.get(nodeInfo.callId);
        if (!session) {
            this.logger.debug('no session for call-id', { callId: nodeInfo.callId });
            return null;
        }
        return session;
    }
    resolveSessionForOfferAck(node) {
        const action = Array.isArray(node.content)
            ? node.content.find((child) => typeof child === 'object' &&
                child !== null &&
                'tag' in child &&
                (child.tag === 'relay' || child.tag === 'error'))
            : undefined;
        const callId = node.attrs?.['call-id'] || action?.attrs?.['call-id'];
        if (callId) {
            const session = this.calls.get(callId);
            if (session)
                return session;
        }
        const outgoing = [];
        for (const session of this.calls.values()) {
            if (session.info.isInitiator && !session.info.isEnded) {
                const state = session.info.stateData.state;
                if (state === types_js_1.CallState.Initiating || state === types_js_1.CallState.Ringing) {
                    outgoing.push(session);
                }
            }
        }
        if (outgoing.length === 1)
            return outgoing[0];
        this.logger.debug('offer ack could not be routed', {
            callId: callId ?? null,
            candidateCount: outgoing.length
        });
        return null;
    }
    emitState(call) {
        this.emit('call_state', call);
    }
    async resolvePeerLid(peerJid) {
        if ((0, protocol_1.isLidJid)(peerJid))
            return peerJid;
        try {
            const [mapped] = await this.deps.signalDeviceSync.queryLidsByPhoneJids([peerJid]);
            if (mapped?.lidJid)
                return mapped.lidJid;
        }
        catch (err) {
            this.logger.trace('lid resolution failed', { message: (0, util_1.toError)(err).message });
        }
        return peerJid;
    }
    async prepareOutgoingPeer(requestedPeerJid, peerJid, explicitPeerDevices) {
        const presenceTargets = [...new Set([requestedPeerJid, peerJid])];
        for (const jid of presenceTargets) {
            try {
                await this.deps.presenceCoordinator.subscribe(jid);
            }
            catch (err) {
                this.logger.trace('outgoing presence subscription failed', {
                    peerJid: jid,
                    message: (0, util_1.toError)(err).message
                });
            }
        }
        if (explicitPeerDevices?.length)
            return explicitPeerDevices;
        const synced = await this.deps.signalDeviceSync.syncDeviceList([peerJid]);
        const peerDevices = [...new Set(synced.flatMap((entry) => entry.deviceJids))];
        this.logger.debug('outgoing peer signaling prepared', {
            requestedPeerJid,
            peerJid,
            peerDevices
        });
        return peerDevices;
    }
    async maybeUnblockWaitingCalls() {
        while (this.activeCallCount < this.maxConcurrentCalls) {
            const waiting = [...this.calls.values()].find((session) => session.info.direction === types_js_1.CallDirection.Incoming &&
                session.info.isRinging &&
                session.info.isAcceptBlocked);
            if (!waiting)
                break;
            await this.activateWaitingIncoming(waiting);
        }
    }
    async activateWaitingIncoming(session) {
        session.info.stateData.acceptBlocked = false;
        const creds = this.deps.authClient.getCurrentCredentials();
        const selfLid = creds?.meLid || creds?.meJid || '';
        await session.initMedia(selfLid, session.info.peerJid);
        await session.sendIncomingPreaccept(session.info.peerJid);
        await this.replayPendingRelaylatency(session);
        this.emitState(session.info);
        this.logger.debug('waiting incoming call unblocked', { callId: session.callId });
    }
    async replayPendingRelaylatency(session) {
        const pending = this.pendingRelaylatency.get(session.callId);
        if (!pending?.length)
            return;
        this.pendingRelaylatency.delete(session.callId);
        let replayed = 0;
        for (const entry of pending) {
            if (Date.now() - entry.receivedAt > PENDING_RELAYLATENCY_TTL_MS)
                continue;
            await session.handleCallRelaylatency(entry.node, entry.peerJid);
            replayed++;
        }
        this.logger.debug('voip_diag relaylatency_replayed_after_preaccept', {
            callId: session.callId,
            queued: pending.length,
            replayed
        });
    }
}
exports.WaCallManager = WaCallManager;
