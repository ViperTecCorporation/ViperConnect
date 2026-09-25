import { EventEmitter } from 'node:events';
import { type Logger } from 'zapo-js';
import { type BinaryNode } from 'zapo-js/transport';
import { type CallOfferOptions, EndCallReason, type WaVoipDeps, type WaVoipStores } from '../types.js';
import { CallInfo } from './call-state.js';
export interface WaCallManagerConfig {
    deps: WaVoipDeps;
    stores: WaVoipStores;
    logger?: Logger;
    maxConcurrentCalls?: number;
    preferWebRelayPort?: boolean;
}
export declare class WaCallManager extends EventEmitter {
    private readonly deps;
    private readonly stores;
    private readonly logger;
    private readonly maxConcurrentCalls;
    private readonly preferWebRelayPort;
    private readonly calls;
    private readonly pendingRelaylatency;
    constructor(config: WaCallManagerConfig);
    startCall(options: CallOfferOptions): Promise<string>;
    acceptCall(callId: string): Promise<void>;
    rejectCall(callId: string, reason?: EndCallReason): Promise<void>;
    endCall(callId: string, reason?: EndCallReason): Promise<void>;
    setMute(callId: string, muted: boolean): void;
    loadAudio(callId: string, audioPath: string): Promise<void>;
    setExternalAudioMode(callId: string, enabled: boolean): void;
    feedLiveAudio(callId: string, data: Float32Array): number;
    getLiveBufferMs(callId: string): number;
    getFeedWatermarksMs(): {
        pauseMs: number;
        resumeMs: number;
    };
    getCall(callId: string): CallInfo | null;
    getCalls(): readonly CallInfo[];
    handleCallOffer(node: BinaryNode, peerJid: string): Promise<void>;
    handleCallAccept(node: BinaryNode, peerJid: string): Promise<void>;
    handleCallPreaccept(node: BinaryNode, peerJid: string): Promise<void>;
    handleCallTransport(node: BinaryNode, peerJid: string): Promise<void>;
    handleCallAck(node: BinaryNode): Promise<void>;
    handleCallReject(node: BinaryNode): Promise<void>;
    handleCallRelaylatency(node: BinaryNode, peerJid: string): Promise<void>;
    handleRelayElection(node: BinaryNode): void;
    handleCallMuteV2(node: BinaryNode, peerJid: string): Promise<void>;
    handleCallTerminate(node: BinaryNode): Promise<void>;
    destroy(): void;
    private get activeCallCount();
    private createSession;
    private getSessionOrThrow;
    private resolveSessionFromNode;
    private resolveSessionForOfferAck;
    private emitState;
    private resolvePeerLid;
    private prepareOutgoingPeer;
    private maybeUnblockWaitingCalls;
    private activateWaitingIncoming;
    private replayPendingRelaylatency;
}
