import { type LogLevel, type WaClientPluginContext } from 'zapo-js';
import type { CallInfo } from './call/call-state.js';
import type { CallManagerEvents, CallOfferOptions, EndCallReason } from './types.js';
export interface WaVoipCoordinatorOptions {
    /** Opt-in laboratory transport policy; default preserves advertised ports. */
    readonly preferWebRelayPort?: boolean;
    /**
     * Maximum simultaneous non-ended calls (ringing, connecting, or active).
     * Default is `1`. Increase to enable parallel multi-call.
     */
    readonly maxConcurrentCalls?: number;
    /**
     * Minimum log level for the VOIP plugin. Defaults to the host client's
     * level; set it to cap the (chatty) VOIP diagnostics independently of the
     * host, e.g. `'warn'` to keep them out of a `trace` host logger.
     */
    readonly logLevel?: LogLevel;
}
/**
 * WaClient-facing VOIP coordinator. Owns a {@link WaCallManager}, registers
 * incoming `<call>` / call-class `<ack>` / call `<receipt>` handlers (prepend,
 * returns `true`) so the core client does not double-ack, and re-emits manager
 * events on the host {@link WaClient}.
 */
export declare class WaVoipCoordinator {
    private readonly manager;
    private readonly deps;
    private readonly logger;
    private readonly unregisterHandlers;
    constructor(ctx: WaClientPluginContext, options?: WaVoipCoordinatorOptions);
    /**
     * Place an outgoing call to `options.peerJid` (optionally video, with a
     * preloaded `audioFile`). Resolves with the new call id once the offer is
     * sent; progress then arrives via `voip_call_state`. Rejects when at the
     * concurrent-call limit or if the offer fails to send.
     */
    startCall(options: CallOfferOptions): Promise<string>;
    /**
     * Accept a ringing incoming call. Throws if `callId` is unknown or not in
     * an acceptable state.
     */
    acceptCall(callId: string): Promise<void>;
    /**
     * Reject a ringing incoming call, optionally with an {@link EndCallReason}
     * (defaults to `Declined`). Sends the reject stanza, then tears the call
     * down.
     */
    rejectCall(callId: string, reason?: EndCallReason): Promise<void>;
    /**
     * End an active or connecting call, optionally with an {@link EndCallReason}
     * (defaults to `UserEnded`). Sends the terminate stanza, then tears the
     * call down. No-op if the call is unknown or already ended.
     */
    endCall(callId: string, reason?: EndCallReason): Promise<void>;
    /**
     * Preload an audio file (decoded via ffmpeg) as the outbound audio for
     * `callId`, played once the call is active. For an unbounded or live source
     * use {@link setExternalAudioMode} + {@link feedLiveAudio} instead. Needs
     * ffmpeg on PATH; throws if the file is missing or ffmpeg is unavailable.
     */
    loadAudio(callId: string, audioPath: string): Promise<void>;
    /** Mute or unmute the local outbound audio for `callId`. */
    setMute(callId: string, muted: boolean): void;
    /**
     * Switch `callId` to external (live) audio mode. While enabled, outbound
     * audio comes from {@link feedLiveAudio} through a bounded jitter buffer
     * instead of a preloaded file. Disable to return to preloaded playback.
     */
    setExternalAudioMode(callId: string, enabled: boolean): void;
    /**
     * Feed a chunk of live mono PCM (`Float32Array` at the engine sample rate)
     * into an active call's outbound audio. Requires external audio mode (see
     * {@link setExternalAudioMode}). Returns the audio currently buffered
     * ahead of the sender in milliseconds, so a producer can pace itself
     * against {@link getFeedWatermarksMs}; returns `0` when no session exists
     * for `callId`. The buffer is bounded and drops the oldest samples on
     * overflow.
     */
    feedLiveAudio(callId: string, data: Float32Array): number;
    /**
     * Milliseconds of live audio currently buffered ahead of the sender for
     * `callId` (`0` when no session exists or external mode is off). Poll it to
     * drive backpressure against {@link getFeedWatermarksMs}.
     */
    getLiveBufferMs(callId: string): number;
    /**
     * Backpressure watermarks for the live feed, in milliseconds. Constants of
     * the feed contract, independent of any specific call: pause feeding once
     * {@link getLiveBufferMs} reaches `pauseMs`, resume once it drains to
     * `resumeMs`. `pauseMs` stays below the engine's internal drop threshold,
     * so a producer that respects it never loses audio.
     */
    getFeedWatermarksMs(): {
        pauseMs: number;
        resumeMs: number;
    };
    /** Current {@link CallInfo} snapshot for `callId`, or `null` if unknown. */
    getCall(callId: string): CallInfo | null;
    /** Snapshot of every tracked call (ringing, connecting, or active). */
    getCalls(): readonly CallInfo[];
    /**
     * Subscribe directly to a low-level {@link CallManagerEvents} event. Most
     * consumers should use the client-level `client.on('voip_*')` events
     * instead. Returns `this` for chaining.
     */
    on<K extends keyof CallManagerEvents>(event: K, listener: CallManagerEvents[K]): this;
    /** Remove a listener registered via {@link on}. Returns `this`. */
    off<K extends keyof CallManagerEvents>(event: K, listener: CallManagerEvents[K]): this;
    /** Like {@link on}, but the listener fires at most once. Returns `this`. */
    once<K extends keyof CallManagerEvents>(event: K, listener: CallManagerEvents[K]): this;
    /**
     * Tear down the coordinator: unregister the incoming `<call>` / ack /
     * receipt handlers and destroy all active calls. Invoked by the plugin
     * system on client disconnect; not normally called directly.
     */
    dispose(): void;
    private registerIncomingHandlers;
    private wireClientEvents;
}
