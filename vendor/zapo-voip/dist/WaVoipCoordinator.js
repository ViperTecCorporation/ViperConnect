"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaVoipCoordinator = void 0;
const protocol_1 = require("zapo-js/protocol");
const WaCallManager_js_1 = require("./call/WaCallManager.js");
const bridge_js_1 = require("./signaling/bridge.js");
/**
 * WaClient-facing VOIP coordinator. Owns a {@link WaCallManager}, registers
 * incoming `<call>` / call-class `<ack>` / call `<receipt>` handlers (prepend,
 * returns `true`) so the core client does not double-ack, and re-emits manager
 * events on the host {@link WaClient}.
 */
class WaVoipCoordinator {
    manager;
    deps;
    logger;
    unregisterHandlers = [];
    constructor(ctx, options = {}) {
        this.deps = ctx.deps;
        this.logger = ctx.logger.child({ scope: '@zapo-js/voip' }, { level: options.logLevel });
        this.manager = new WaCallManager_js_1.WaCallManager({
            deps: ctx.deps,
            stores: ctx.stores,
            logger: this.logger,
            maxConcurrentCalls: options.maxConcurrentCalls,
            preferWebRelayPort: options.preferWebRelayPort
        });
        this.registerIncomingHandlers(ctx);
        this.wireClientEvents(ctx);
    }
    /**
     * Place an outgoing call to `options.peerJid` (optionally video, with a
     * preloaded `audioFile`). Resolves with the new call id once the offer is
     * sent; progress then arrives via `voip_call_state`. Rejects when at the
     * concurrent-call limit or if the offer fails to send.
     */
    async startCall(options) {
        return this.manager.startCall(options);
    }
    /**
     * Accept a ringing incoming call. Throws if `callId` is unknown or not in
     * an acceptable state.
     */
    async acceptCall(callId) {
        return this.manager.acceptCall(callId);
    }
    /**
     * Reject a ringing incoming call, optionally with an {@link EndCallReason}
     * (defaults to `Declined`). Sends the reject stanza, then tears the call
     * down.
     */
    async rejectCall(callId, reason) {
        return this.manager.rejectCall(callId, reason);
    }
    /**
     * End an active or connecting call, optionally with an {@link EndCallReason}
     * (defaults to `UserEnded`). Sends the terminate stanza, then tears the
     * call down. No-op if the call is unknown or already ended.
     */
    async endCall(callId, reason) {
        return this.manager.endCall(callId, reason);
    }
    /**
     * Preload an audio file (decoded via ffmpeg) as the outbound audio for
     * `callId`, played once the call is active. For an unbounded or live source
     * use {@link setExternalAudioMode} + {@link feedLiveAudio} instead. Needs
     * ffmpeg on PATH; throws if the file is missing or ffmpeg is unavailable.
     */
    async loadAudio(callId, audioPath) {
        return this.manager.loadAudio(callId, audioPath);
    }
    /** Mute or unmute the local outbound audio for `callId`. */
    setMute(callId, muted) {
        this.manager.setMute(callId, muted);
    }
    /**
     * Switch `callId` to external (live) audio mode. While enabled, outbound
     * audio comes from {@link feedLiveAudio} through a bounded jitter buffer
     * instead of a preloaded file. Disable to return to preloaded playback.
     */
    setExternalAudioMode(callId, enabled) {
        this.manager.setExternalAudioMode(callId, enabled);
    }
    /**
     * Feed a chunk of live mono PCM (`Float32Array` at the engine sample rate)
     * into an active call's outbound audio. Requires external audio mode (see
     * {@link setExternalAudioMode}). Returns the audio currently buffered
     * ahead of the sender in milliseconds, so a producer can pace itself
     * against {@link getFeedWatermarksMs}; returns `0` when no session exists
     * for `callId`. The buffer is bounded and drops the oldest samples on
     * overflow.
     */
    feedLiveAudio(callId, data) {
        return this.manager.feedLiveAudio(callId, data);
    }
    /**
     * Milliseconds of live audio currently buffered ahead of the sender for
     * `callId` (`0` when no session exists or external mode is off). Poll it to
     * drive backpressure against {@link getFeedWatermarksMs}.
     */
    getLiveBufferMs(callId) {
        return this.manager.getLiveBufferMs(callId);
    }
    /**
     * Backpressure watermarks for the live feed, in milliseconds. Constants of
     * the feed contract, independent of any specific call: pause feeding once
     * {@link getLiveBufferMs} reaches `pauseMs`, resume once it drains to
     * `resumeMs`. `pauseMs` stays below the engine's internal drop threshold,
     * so a producer that respects it never loses audio.
     */
    getFeedWatermarksMs() {
        return this.manager.getFeedWatermarksMs();
    }
    /** Current {@link CallInfo} snapshot for `callId`, or `null` if unknown. */
    getCall(callId) {
        return this.manager.getCall(callId);
    }
    /** Snapshot of every tracked call (ringing, connecting, or active). */
    getCalls() {
        return this.manager.getCalls();
    }
    /**
     * Subscribe directly to a low-level {@link CallManagerEvents} event. Most
     * consumers should use the client-level `client.on('voip_*')` events
     * instead. Returns `this` for chaining.
     */
    on(event, listener) {
        this.manager.on(event, listener);
        return this;
    }
    /** Remove a listener registered via {@link on}. Returns `this`. */
    off(event, listener) {
        this.manager.off(event, listener);
        return this;
    }
    /** Like {@link on}, but the listener fires at most once. Returns `this`. */
    once(event, listener) {
        this.manager.once(event, listener);
        return this;
    }
    /**
     * Tear down the coordinator: unregister the incoming `<call>` / ack /
     * receipt handlers and destroy all active calls. Invoked by the plugin
     * system on client disconnect; not normally called directly.
     */
    dispose() {
        for (const unregister of this.unregisterHandlers.splice(0)) {
            unregister();
        }
        this.manager.destroy();
    }
    registerIncomingHandlers(ctx) {
        this.unregisterHandlers.push(ctx.registerIncomingHandler({
            tag: 'call',
            prepend: true,
            handler: async (node) => {
                const tag = await (0, bridge_js_1.routeCallStanza)(this.manager, this.deps, node, this.logger);
                return tag !== null;
            }
        }), ctx.registerIncomingHandler({
            tag: protocol_1.WA_MESSAGE_TAGS.ACK,
            prepend: true,
            handler: async (node) => {
                if (node.attrs.class !== 'call') {
                    return false;
                }
                await (0, bridge_js_1.routeCallAck)(this.manager, node, this.logger);
                return true;
            }
        }), ctx.registerIncomingHandler({
            tag: protocol_1.WA_MESSAGE_TAGS.RECEIPT,
            prepend: true,
            handler: async (node) => (0, bridge_js_1.routeCallReceipt)(this.deps, node, this.logger)
        }));
    }
    wireClientEvents(ctx) {
        this.manager.on('call_state', (call) => {
            ctx.emit('voip_call_state', call);
        });
        this.manager.on('call_incoming', (call) => {
            ctx.emit('voip_call_incoming', call);
        });
        this.manager.on('call_ended', (call) => {
            ctx.emit('voip_call_ended', call);
        });
        this.manager.on('call_inbound_audio', (call, pcm) => {
            ctx.emit('voip_call_inbound_audio', { call, pcm });
        });
        this.manager.on('call_outbound_audio_finished', (call) => {
            ctx.emit('voip_call_outbound_audio_finished', call);
        });
        this.manager.on('call_error', (error) => {
            ctx.emit('voip_call_error', error);
        });
    }
}
exports.WaVoipCoordinator = WaVoipCoordinator;
