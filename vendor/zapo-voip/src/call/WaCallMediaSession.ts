import type { Logger } from 'zapo-js'
import { toUserJid } from 'zapo-js/protocol'
import { type BinaryNode, getFirstNodeChild, getNodeChildrenByTag } from 'zapo-js/transport'
import { toError, uint8TimingSafeEqual } from 'zapo-js/util'

import { concatBytes, EMPTY_BYTES, readUInt32BE, toArrayBuffer } from '../bytes.js'
import { derivePerJidSrtpKey } from '../crypto/encryption.js'
import { SrtcpSender } from '../crypto/srtcp.js'
import { SrtpSession } from '../crypto/srtp.js'
import {
    e2eParticipantIdVariants,
    formatE2ESrtpParticipantId,
    generateSecureSsrc,
    generateWasmRelayStreamSsrcs,
    prepareWasmRelayStreamSsrcs
} from '../crypto/ssrc.js'
import { MLowCodec, type MLowCodecOptions } from '../media/mlow-codec.js'
import { PcmFrameAccumulator } from '../media/pcm-frame-accumulator.js'
import { isOpusDtxPayload, isWhatsappOpusPayloadType, RtpSession } from '../media/rtp.js'
import { WaAudioEngine } from '../media/WaAudioEngine.js'
import { parseRelayFromAck } from '../relay/relay-ack.js'
import { summarizeRelaySignaling } from '../relay/relay-diagnostics.js'
import {
    type NormalizedRelayEndpoint,
    orderMediaRelayCandidates
} from '../relay/relay-endpoints.js'
import { isRtpPacket, isStunPacket } from '../relay/stun.js'
import { WaSctpRelay } from '../relay/WaSctpRelay.js'
import {
    buildDirectAcceptStanza,
    buildIncomingPreacceptStanza,
    buildMuteV2Stanza,
    buildOutgoingPreacceptStanza,
    buildRejectStanza,
    buildRelayLatencyStanza,
    buildTerminateStanza,
    buildTransportStanza,
    decryptCallKey,
    extractNodeInfo,
    extractRelayEndpoints,
    needsDecryption
} from '../signaling/signaling.js'
import { summarizeCallEnvelope } from '../signaling/signaling-diagnostics.js'
import {
    type ParsedVoipSettings,
    parseVoipSettings,
    parseVoipSettingsFromNode
} from '../signaling/voip-settings.js'
import {
    type AudioSender,
    CallDirection,
    CallMediaType,
    CallState,
    EndCallReason,
    type RelayEndpoint,
    SRTP_AUTH_TAG_LEN,
    SRTP_RECV_AUTH_TAG_LEN,
    SRTP_SEND_AUTH_TAG_LEN,
    type WaVoipDeps
} from '../types.js'

import { type CallInfo } from './call-state.js'

const REMOTE_MEDIA_FIRST_PACKET_TIMEOUT_MS = 1500
const REMOTE_MEDIA_STALL_TIMEOUT_MS = 3000
const REMOTE_MEDIA_CONTROL_RECHECK_MS = 500
const REMOTE_MEDIA_CONTROL_FRESH_MS = 2500
const REMOTE_MEDIA_CONTROL_STARTUP_TIMEOUT_MS = 3000
const REMOTE_MEDIA_ESTABLISHED_AUDIO_FRAMES = 10
const INBOUND_PCM_FRAME_SAMPLES = 960

export interface WaCallMediaSessionDelegate {
    emitState(call: CallInfo): void
    emitIncoming(call: CallInfo): void
    emitEnded(call: CallInfo): void
    emitInboundAudio(call: CallInfo, data: Float32Array): void
    emitOutboundAudioFinished(call: CallInfo): void
}

export interface WaCallMediaSessionOptions {
    readonly deps: WaVoipDeps
    readonly logger: Logger
    readonly info: CallInfo
    readonly delegate: WaCallMediaSessionDelegate
}

export class WaCallMediaSession implements AudioSender {
    readonly info: CallInfo

    private readonly deps: WaVoipDeps
    private readonly logger: Logger
    private readonly delegate: WaCallMediaSessionDelegate

    private rtpSession: RtpSession | null = null
    private srtpSession: SrtpSession | null = null
    private srtcpSender: SrtcpSender | null = null
    private srtcpTimer: NodeJS.Timeout | null = null
    private srtcpSendCount = 0
    private opusCodec: MLowCodec | null = null
    private voipSettings: ParsedVoipSettings = parseVoipSettings(undefined)
    private readonly sctpRelay: WaSctpRelay
    private readonly audioEngine: WaAudioEngine

    private selfSsrc = 0
    private selfStreamSsrcs: number[] = []
    private selfMediaJid = ''
    private peerSsrcs: number[] = []

    private acceptedByJid: string | null = null
    private acceptCallCreator: string | null = null
    private acceptPending = false
    private acceptSent = false
    private initialTransportSent = false
    private outgoingPreacceptSent = false
    private outgoingPostAcceptSignalingSent = false
    private remoteMuteObserved = false
    private remoteMuted = false
    private incomingRelayPreparePromise: Promise<void> | null = null
    private provisionalRelayId: number | undefined
    private relayCandidates: NormalizedRelayEndpoint[] = []
    private relayCandidateIndex = -1
    private relayRecoveryTimer: NodeJS.Timeout | null = null
    private relayRecoveryGeneration = 0
    private relayRecoveryInFlight: Promise<void> | null = null
    private remoteMediaStarted = false
    private remoteMediaEstablished = false
    private lastRemoteMediaProgressAt = 0
    private relayAttemptStartedAt = 0
    private relayAttemptAudioBaseCount = 0
    private lastAuthenticatedAudioCount = 0
    private readonly debeEnabled = true

    private audioSendCount = 0
    private audioDropCount = 0
    private realAudioSendCount = 0

    private static readonly EMPTY_BYTES = EMPTY_BYTES

    private encodeBufferA: Float32Array | null = null
    private encodeBufferB: Float32Array | null = null
    private encodeBuffer: Float32Array | null = null
    private encodeBufferPos = 0
    private authPaddingBuffer: Uint8Array | null = null

    private audioRecvCount = 0
    private recvRealCount = 0
    private recvDtxCount = 0
    private srtpErrorCount = 0
    private pcmDeliveryErrorCount = 0
    private pcmDeliveredFrameCount = 0
    private readonly inboundPcmFrames = new PcmFrameAccumulator(INBOUND_PCM_FRAME_SAMPLES)
    private relayPacketCount = 0
    private stunResponseCount = 0
    private selfEchoCount = 0
    private lastRecvSeq = -1
    private recvSeqGaps = 0
    private actualPeerSsrc: number | null = null
    private ssrcResubscribed = false
    private firstRelayRtpLogged = false
    private firstAudioRecvLogged = false

    constructor(options: WaCallMediaSessionOptions) {
        this.deps = options.deps
        this.logger = options.logger
        this.info = options.info
        this.delegate = options.delegate

        this.sctpRelay = new WaSctpRelay({
            logger: this.logger.child({ component: 'sctp' })
        })

        this.audioEngine = new WaAudioEngine({
            logger: this.logger.child({ component: 'audio-engine' })
        })
        this.audioEngine.setAudioSender(this)
        this.audioEngine.setOnAudioFinished(() => {
            this.delegate.emitOutboundAudioFinished(this.info)
        })

        this.sctpRelay.on('relay_connected', () => {
            const current = this.relayCandidates[this.relayCandidateIndex]
            const electedRelayId = this.info.electedRelayIdx
            const relayId =
                current && electedRelayId === current.relayId
                    ? electedRelayId
                    : (this.provisionalRelayId ?? electedRelayId)
            if (relayId !== undefined) {
                this.sctpRelay.selectMediaConnectionByRelayId(relayId)
            }
            this.onRelayConnected()
            this.armRemoteMediaWatchdog()
        })
        this.sctpRelay.on(
            'relay_receive',
            (relayInfo: { ip: string; port: number; connectionId: string; data: Uint8Array }) => {
                this.onRelayData(relayInfo.data, relayInfo.connectionId)
                this.noteRemoteMediaProgress()
            }
        )
        this.sctpRelay.on(
            'relay_failed',
            (failure: {
                connectionId: string
                relayId: number
                relayName?: string
                ip: string
                port: number
                reason: string
            }) => {
                setImmediate(() => void this.handleRelayFailure(failure))
            }
        )
    }

    get callId(): string {
        return this.info.callId
    }

    async initMedia(selfLid: string, peerJid: string): Promise<void> {
        const selfDeviceJid = formatE2ESrtpParticipantId(selfLid)
        this.selfMediaJid = selfDeviceJid
        const ssrc = generateSecureSsrc(this.info.callId, selfDeviceJid)
        this.rtpSession = RtpSession.whatsappOpus(ssrc)
        this.selfSsrc = ssrc
        const derivedStreamSsrcs = generateWasmRelayStreamSsrcs(this.info.callId, selfDeviceJid)
        this.selfStreamSsrcs = prepareWasmRelayStreamSsrcs(
            derivedStreamSsrcs,
            generateSecureSsrc(this.info.callId, selfDeviceJid, 6)
        )

        const peerSsrc = generateSecureSsrc(
            this.info.callId,
            formatE2ESrtpParticipantId(peerJid)
        )
        this.peerSsrcs = [peerSsrc]

        this.logger.debug('call media initialized', {
            callId: this.info.callId,
            selfMediaJid: selfDeviceJid,
            selfSsrc: `0x${ssrc.toString(16).toUpperCase()}`,
            peerSsrc: `0x${peerSsrc.toString(16).toUpperCase()}`
        })
        this.logger.debug('voip_diag media_identity_initialized', {
            callId: this.info.callId,
            direction: this.info.direction,
            selfInputJid: selfLid,
            peerInputJid: peerJid,
            selfMediaJid: selfDeviceJid,
            peerMediaJid: formatE2ESrtpParticipantId(peerJid),
            selfSsrc: `0x${ssrc.toString(16).padStart(8, '0')}`,
            peerSsrcs: this.peerSsrcs.map((value) => `0x${value.toString(16).padStart(8, '0')}`),
            selfStreamSsrcs: this.selfStreamSsrcs.map((value) =>
                `0x${value.toString(16).padStart(8, '0')}`
            )
        })

        this.opusCodec = await MLowCodec.create(this.codecOptions)
    }

    async configureVoipSettings(
        settings: ParsedVoipSettings,
        source: string,
        force = false
    ): Promise<void> {
        if (!force && !settings.present) return

        const previous = this.voipSettings
        const changed =
            previous.codecMode !== settings.codecMode ||
            previous.targetBitrate !== settings.targetBitrate
        let codecReinitialized = false
        let replacement: MLowCodec | null = null

        if (changed && this.opusCodec) {
            // Build the replacement before publishing the negotiated settings.
            // If codec initialization fails, the active codec and advertised rate
            // remain consistent instead of leaving a half-switched session.
            replacement = await MLowCodec.create(
                this.codecOptionsFor(settings)
            )
        }

        this.voipSettings = settings

        if (replacement) {
            const priorCodec = this.opusCodec
            this.opusCodec = replacement
            priorCodec?.destroy()
            this.resetEncodeState()
            this.inboundPcmFrames.clear()
            codecReinitialized = true
        }

        this.logger.debug('voip_diag audio_codec_selected', {
            callId: this.info.callId,
            direction: this.info.direction,
            source,
            codecMode: settings.codecMode,
            signalingRate: this.signalingAudioRate,
            useMlowCodecV1: settings.useMlowCodecV1,
            frameMs: settings.frameMs,
            targetBitrate: settings.targetBitrate,
            present: settings.present,
            malformed: settings.malformed,
            codecReinitialized
        })
    }

    async prepareIncomingRelay(): Promise<void> {
        if (
            this.info.direction !== CallDirection.Incoming ||
            this.info.isEnded ||
            !this.info.relayData?.endpoints.length
        ) {
            return
        }

        if (!this.incomingRelayPreparePromise) {
            this.incomingRelayPreparePromise = this.connectRelays(
                this.info.relayData.endpoints
            )
        }

        await this.incomingRelayPreparePromise
    }

    async acceptCall(): Promise<void> {
        if (!this.info.canAccept) {
            throw new Error(
                `Call ${this.info.callId} cannot be accepted in state ${this.info.stateData.state}`
            )
        }
        const callKey = this.info.encryptionKey
        if (!callKey) {
            throw new Error(`Call ${this.info.callId} cannot be accepted without call_key`)
        }

        this.info.applyTransition({ type: 'local_accepted' })
        this.delegate.emitState(this.info)

        const callId = this.info.callId
        const peerJid = this.info.peerJid

        this.acceptedByJid ||= peerJid
        this.acceptCallCreator ||= this.info.callCreator
        this.initSrtpKeys()
        this.acceptPending = true

        if (this.info.relayData) {
            await this.prepareIncomingRelay()
        }

        if (this.remoteMuteObserved) {
            await this.sendPendingAccept()
        }

        this.logger.debug('call answer committed; waiting for caller mute_v2', {
            callId,
            remoteMuteObserved: this.remoteMuteObserved,
            relayConnected: this.sctpRelay.hasConnection(),
            acceptSent: this.acceptSent
        })
    }

    async rejectCall(reason: EndCallReason = EndCallReason.Declined): Promise<void> {
        this.info.applyTransition({ type: 'local_rejected', reason })
        this.delegate.emitState(this.info)

        const node = buildRejectStanza(this.info.peerJid, this.info.callId, this.info.callCreator)
        try {
            await this.deps.lowLevelCoordinator.sendNode(node)
        } catch (err) {
            this.logger.warn('reject send failed', { message: toError(err).message })
        }
        this.cleanup()
    }

    async endCall(reason: EndCallReason = EndCallReason.UserEnded): Promise<void> {
        if (this.info.isEnded) return

        const connectedAt = this.info.stateData.connectedAt
        const audioDurationMs = connectedAt ? Date.now() - connectedAt.getTime() : undefined

        this.info.applyTransition({ type: 'terminated', reason })

        const terminateTarget = this.acceptedByJid ?? this.info.peerJid
        const node = buildTerminateStanza(
            terminateTarget,
            this.info.callId,
            this.info.callCreator,
            audioDurationMs
        )
        this.delegate.emitEnded(this.info)
        this.delegate.emitState(this.info)
        try {
            await this.deps.lowLevelCoordinator.sendNode(node)
        } catch (err) {
            this.logger.warn('terminate send failed', { message: toError(err).message })
        }
        this.cleanup()
    }

    setMute(muted: boolean): void {
        if (!this.info.isActive) return

        this.info.applyTransition({ type: 'audio_mute_changed', muted })
        this.delegate.emitState(this.info)

        if (muted) {
            this.audioEngine.stopCapture()
        } else {
            this.audioEngine.startCapture()
        }
    }

    async loadAudio(audioPath: string): Promise<void> {
        await this.audioEngine.loadAudioFile(audioPath)
        this.resetEncodeState()
        this.logger.debug('audio loaded for call', { callId: this.info.callId })
    }

    setExternalAudioMode(enabled: boolean): void {
        this.audioEngine.setExternalMode(enabled)
        if (enabled) {
            this.resetEncodeState()
            this.logger.debug('external audio mode enabled', { callId: this.info.callId })
        }
    }

    feedLiveAudio(data: Float32Array): number {
        return this.audioEngine.feedExternalAudio(data)
    }

    getLiveBufferMs(): number {
        return this.audioEngine.getLiveBufferMs()
    }

    async sendIncomingPreaccept(peerJid: string): Promise<void> {
        try {
            const preacceptNode = buildIncomingPreacceptStanza(
                peerJid,
                this.info.callId,
                this.info.callCreator,
                this.signalingAudioRate
            )
            await this.deps.lowLevelCoordinator.sendNode(preacceptNode)
        } catch (err: unknown) {
            this.logger.error('error sending preaccept', {
                message: toError(err).message
            })
        }
    }

    async handleCallAccept(node: BinaryNode, peerJid: string): Promise<void> {
        const nodeInfo = extractNodeInfo(node)
        if (!nodeInfo) return

        const callId = this.info.callId
        const acceptingDeviceJid = peerJid
        const credentials = this.deps.authClient.getCurrentCredentials()
        const ourBaseJids = new Set(
            [credentials?.meLid, credentials?.meJid]
                .filter((jid): jid is string => !!jid)
                .map((jid) => toUserJid(jid))
        )
        const acceptingBaseJid = acceptingDeviceJid
            ? toUserJid(acceptingDeviceJid)
            : ''

        // When the called number is another Zapo session hosted by this worker, the
        // target session observes the same call-id as an incoming mirrored leg. Its
        // own handset's accept belongs to the caller's outbound leg; processing it
        // here would create a second media owner and immediately tear down the call.
        if (
            this.info.direction === CallDirection.Incoming &&
            !!acceptingBaseJid &&
            ourBaseJids.has(acceptingBaseJid)
        ) {
            if (this.info.isEnded) return
            this.logger.info(
                'incoming call accepted by another local device; stopping mirrored local call leg',
                { callId, acceptingDeviceJid, acceptingBaseJid }
            )
            try {
                this.info.applyTransition({
                    type: 'terminated',
                    reason: EndCallReason.UserEnded
                })
            } catch (err) {
                this.logger.trace('call transition skipped', {
                    message: toError(err).message
                })
            }
            this.delegate.emitEnded(this.info)
            this.delegate.emitState(this.info)
            this.cleanup()
            return
        }

        let peerCallKey: Uint8Array | undefined
        if (needsDecryption(nodeInfo.tag)) {
            try {
                const decryptedPeerCallKey = await decryptCallKey(
                    this.deps,
                    nodeInfo.innerNode,
                    peerJid,
                    this.logger.child({ component: 'signaling' })
                )
                const ourCallKey = this.info.encryptionKey
                if (
                    decryptedPeerCallKey &&
                    ourCallKey &&
                    !uint8TimingSafeEqual(ourCallKey, decryptedPeerCallKey)
                ) {
                    peerCallKey = decryptedPeerCallKey
                    this.logger.debug('accept supplied a distinct peer call_key', {
                        callId: this.info.callId,
                        peerJid
                    })
                }
            } catch (err: unknown) {
                this.logger.error('accept call_key decrypt error', {
                    callId: this.info.callId,
                    peerJid,
                    message: toError(err).message
                })
            }
        }

        try {
            this.info.applyTransition({ type: 'remote_accepted' })
            this.delegate.emitState(this.info)
        } catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message })
        }

        this.acceptedByJid = acceptingDeviceJid

        if (this.actualPeerSsrc !== null) {
            const calculatedJid = formatE2ESrtpParticipantId(acceptingDeviceJid)
            this.logger.debug('accept keeping actual peer ssrc', {
                callId,
                actualPeerSsrc: `0x${this.actualPeerSsrc.toString(16)}`,
                calculatedJid
            })
        } else {
            const peerDeviceJidForSsrc = formatE2ESrtpParticipantId(acceptingDeviceJid)
            const acceptSsrc = generateSecureSsrc(callId, peerDeviceJidForSsrc)
            this.peerSsrcs = [acceptSsrc]
            this.logger.debug('accept ssrc assigned', {
                callId,
                jid: peerDeviceJidForSsrc,
                ssrc: `0x${acceptSsrc.toString(16)}`
            })
        }
        this.sctpRelay.setSubscriptionSsrcs(this.peerSsrcs)
        this.sctpRelay.setParticipantPids(
            this.info.relayData?.selfPid,
            this.info.relayData?.peerPid
        )
        this.sctpRelay.resendSubscriptions()

        this.initSrtpKeys(peerCallKey)
        this.logger.debug('voip_diag outgoing_accept_identity', {
            callId,
            acceptingDeviceJid,
            acceptNodeFrom: node.attrs?.from,
            acceptNodeId: node.attrs?.id,
            acceptCallCreator: nodeInfo.innerNode.attrs?.['call-creator'],
            peerSsrcs: this.peerSsrcs.map((value) => `0x${value.toString(16).padStart(8, '0')}`),
            actualPeerSsrc:
                this.actualPeerSsrc === null
                    ? undefined
                    : `0x${this.actualPeerSsrc.toString(16).padStart(8, '0')}`,
            relaySelfParticipantJid: this.info.relayData?.selfParticipantJid,
            relayPeerParticipantJid: this.info.relayData?.peerParticipantJid,
            selfPid: this.info.relayData?.selfPid,
            peerPid: this.info.relayData?.peerPid
        })

        await this.sendOutgoingPostAcceptSignaling(acceptingDeviceJid)

        if (this.sctpRelay.hasConnection()) {
            try {
                this.info.applyTransition({ type: 'media_connected' })
                this.delegate.emitState(this.info)
                this.startMediaFlow()
            } catch (err) {
                this.logger.trace('call transition skipped', { message: toError(err).message })
            }
        } else if (this.info.relayData) {
            await this.connectRelays(this.info.relayData.endpoints)
        }

        this.armRemoteMediaWatchdog()
    }

    async handleCallPreaccept(node: BinaryNode, peerJid: string): Promise<void> {
        const nodeInfo = extractNodeInfo(node)
        if (!nodeInfo) return

        if (this.info.direction !== CallDirection.Outgoing || !this.info.relayData) return

        const callId = this.info.callId
        const callCreator = this.info.callCreator
        const credentials = this.deps.authClient.getCurrentCredentials()
        const meId = credentials?.meLid || credentials?.meJid || ''
        const destinationJids = this.info.relayData.participantJids || []
        const seenRelayNames = new Set<string>()

        for (const endpoint of this.info.relayData.endpoints) {
            const relayName = endpoint.relayName || ''
            if (!relayName || seenRelayNames.has(relayName)) continue
            seenRelayNames.add(relayName)

            try {
                const relayLatencyNode = buildRelayLatencyStanza(
                    this.info.peerJid,
                    callId,
                    callCreator,
                    [
                        {
                            relayName,
                            latency: endpoint.c2rRtt || 0,
                            addressBytes: endpoint.addressBytes
                        }
                    ],
                    destinationJids
                )
                await this.deps.lowLevelCoordinator.sendNode(relayLatencyNode)
            } catch (err: unknown) {
                this.logger.error('error sending outbound relaylatency', {
                    callId,
                    relayName,
                    message: toError(err).message
                })
            }
        }

        if (this.initialTransportSent) return
        this.initialTransportSent = true
        try {
            const transportNode = buildTransportStanza(
                toUserJid(peerJid),
                callId,
                callCreator,
                meId
            )
            await this.deps.lowLevelCoordinator.sendNode(transportNode)
            this.logger.debug('voip_diag outgoing_preaccept_signaling_sent', {
                callId,
                peerJid: toUserJid(peerJid),
                relayCount: seenRelayNames.size,
                transportMessageType: 0,
                p2pCandidateRound: 0
            })
        } catch (err: unknown) {
            this.initialTransportSent = false
            this.logger.error('error sending initial outbound transport', {
                callId,
                message: toError(err).message
            })
        }
    }

    async handleCallTransport(_node: BinaryNode): Promise<void> {
        const nodeInfo = extractNodeInfo(_node)
        if (!nodeInfo) return

        const nestedRelays =
            this.info.direction === CallDirection.Incoming
                ? this.ingestIncomingRelayUpdate(_node, 'transport')
                : []
        const relays =
            nestedRelays.length > 0
                ? nestedRelays
                : extractRelayEndpoints(nodeInfo.innerNode)
        if (relays.length > 0 && !this.sctpRelay.hasConnection()) {
            if (nestedRelays.length === 0) {
                this.info.relayData = {
                    ...this.info.relayData,
                    endpoints: relays
                }
            }
            if (this.info.direction === CallDirection.Incoming) {
                if (this.info.stateData.state !== CallState.IncomingRinging) {
                    await this.prepareIncomingRelay()
                }
                return
            }
            await this.connectRelays(relays)
        }
    }

    async handleCallAck(node: BinaryNode): Promise<void> {
        const ackType = node.attrs?.type
        if (ackType !== 'offer') return

        const error = node.attrs?.error
        if (error) {
            this.logger.error('ack error', { callId: this.info.callId, error })
            return
        }

        const ackVoipSettings = parseVoipSettingsFromNode(node)
        if (!this.outgoingPreacceptSent) {
            await this.configureVoipSettings(
                ackVoipSettings,
                'offer_ack'
            )
        } else if (ackVoipSettings.present) {
            this.logger.debug('voip_diag late_codec_settings_ignored', {
                callId: this.info.callId,
                source: 'offer_ack',
                codecMode: ackVoipSettings.codecMode
            })
        }

        const {
            relays,
            participantJids,
            selfParticipantJid,
            peerParticipantJid,
            uuid,
            selfPid,
            peerPid,
            hbhKey
        } = parseRelayFromAck(node)

        if (relays.length > 0) {
            this.info.relayData = {
                endpoints: relays,
                participantJids,
                selfParticipantJid,
                peerParticipantJid,
                uuid,
                selfPid,
                peerPid,
                hbhKey
            }

            this.logger.debug('offer ack relays parsed', {
                callId: this.info.callId,
                relayCount: relays.length,
                participantCount: participantJids.length,
                selfParticipantJid,
                peerParticipantJid,
                relayCandidates: relays.map((relay) => ({
                    relayName: relay.relayName,
                    relayId: relay.relayId,
                    ip: relay.ip,
                    port: relay.port,
                    addressFamily: relay.addressFamily,
                    protocol: relay.protocol ?? 0,
                    c2rRtt: relay.c2rRtt,
                    isFna: relay.isFna === true,
                    tokenId: relay.tokenId,
                    tokenBytes: relay.rawToken?.length ?? 0,
                    authTokenId: relay.authTokenId,
                    authTokenBytes: relay.rawAuthToken?.length ?? 0,
                    relayKeyBytes: new TextEncoder().encode(relay.key).length
                }))
            })
            this.logger.debug('voip_diag offer_ack_identity', {
                callId: this.info.callId,
                direction: this.info.direction,
                currentPeerJid: this.info.peerJid,
                selfMediaJid: this.selfMediaJid,
                participantJids,
                selfParticipantJid,
                peerParticipantJid,
                selfPid,
                peerPid,
                relayCount: relays.length,
                relayCandidates: relays.map((relay) => ({
                    relayName: relay.relayName,
                    relayId: relay.relayId,
                    ip: relay.ip,
                    port: relay.port,
                    addressFamily: relay.addressFamily,
                    protocol: relay.protocol ?? 0,
                    c2rRtt: relay.c2rRtt,
                    isFna: relay.isFna === true,
                    tokenId: relay.tokenId,
                    tokenBytes: relay.rawToken?.length ?? 0,
                    authTokenId: relay.authTokenId,
                    authTokenBytes: relay.rawAuthToken?.length ?? 0
                }))
            })

            const callKey = this.info.encryptionKey
            if (participantJids.length > 0) {
                const meLid = this.deps.authClient.getCurrentCredentials()?.meLid
                const meId = this.deps.authClient.getCurrentCredentials()?.meJid
                const ourCredJid = meLid || meId || ''
                const ourBase = ourCredJid ? toUserJid(ourCredJid) : ''

                const peerJids = [
                    peerParticipantJid,
                    ...participantJids.filter((jid) => {
                        const jidBase = toUserJid(jid)
                        return jidBase !== ourBase
                    })
                ].filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)

                if (peerJids.length > 0) {
                    this.peerSsrcs = [
                        ...new Set(
                            peerJids.map((jid) =>
                                generateSecureSsrc(
                                    this.info.callId,
                                    formatE2ESrtpParticipantId(jid)
                                )
                            )
                        )
                    ]
                }

                this.logger.debug('direct call self media identity preserved from initMedia', {
                    callId: this.info.callId,
                    selfMediaJid: this.selfMediaJid,
                    ackSelfParticipantJid: selfParticipantJid,
                    peerParticipantJid,
                    peerJids
                })

                if (callKey) {
                    this.initSrtpKeys()
                } else {
                    this.logger.debug('no call_key, srtp not initialized', {
                        callId: this.info.callId
                    })
                }
            }

            if (this.info.isInitiator && !this.outgoingPreacceptSent) {
                this.outgoingPreacceptSent = true
                try {
                    const preacceptNode = buildOutgoingPreacceptStanza(
                        this.info.peerJid,
                        this.info.callId,
                        this.info.callCreator,
                        this.signalingAudioRate
                    )
                    await this.deps.lowLevelCoordinator.sendNode(preacceptNode)
                    this.logger.debug('voip_diag outgoing_preaccept_sent_after_offer_ack', {
                        callId: this.info.callId,
                        peerJid: this.info.peerJid
                    })
                } catch (err: unknown) {
                    this.outgoingPreacceptSent = false
                    this.logger.error('error sending caller preaccept after offer ack', {
                        callId: this.info.callId,
                        message: toError(err).message
                    })
                }
            }

            await this.connectRelays(relays)

            if (
                this.srtpSession &&
                this.rtpSession &&
                this.opusCodec &&
                this.sctpRelay.hasConnection()
            ) {
                this.audioEngine.startSilenceCapture()
            }
        }
    }

    async handleCallRelaylatency(node: BinaryNode, peerJid: string): Promise<void> {
        const nodeInfo = extractNodeInfo(node)
        if (!nodeInfo || this.info.direction !== CallDirection.Incoming) return

        this.ingestIncomingRelayUpdate(node, 'relaylatency')
        const relaySignaling = summarizeRelaySignaling(node)

        const inner = nodeInfo.innerNode
        const callId = inner.attrs?.['call-id'] || this.info.callId
        const callCreator = inner.attrs?.['call-creator'] || this.info.callCreator

        const teNodes = getNodeChildrenByTag(inner, 'te')

        if (teNodes.length === 0) return

        this.logger.debug('voip_diag inbound_relaylatency_received', {
            callId,
            peerJid,
            relayNames: teNodes.map((te) => te.attrs?.relay_name || '').filter(Boolean),
            probeCount: teNodes.length,
            relaySignaling
        })

        const usableOfferRelays = (this.info.relayData?.endpoints ?? []).filter(
            (candidate) =>
                (candidate.protocol ?? 0) === 0 &&
                Boolean(candidate.key) &&
                Boolean(candidate.rawToken?.length)
        )
        const availableRelayNames = [
            ...new Set(
                usableOfferRelays
                    .map((candidate) => candidate.relayName || '')
                    .filter(Boolean)
            )
        ]

        let responded = 0
        let skipped = 0
        for (const te of teNodes) {
            const relayName = te.attrs?.relay_name || ''
            if (!relayName) continue

            const encodedLatency = Number(te.attrs?.latency || '0')
            const latency = Number.isFinite(encodedLatency)
                ? Math.max(0, encodedLatency >= 0x2000000 ? encodedLatency - 0x2000000 : encodedLatency)
                : 0

            const authenticatedCandidates = usableOfferRelays.filter(
                (candidate) => candidate.relayName === relayName
            )
            if (authenticatedCandidates.length === 0) {
                skipped++
                this.logger.debug('voip_diag unauthenticated_relaylatency_skipped', {
                    callId,
                    peerJid,
                    relayName,
                    latency,
                    availableRelayNames
                })
                continue
            }

            try {
                const response = buildRelayLatencyStanza(
                    peerJid,
                    callId,
                    callCreator,
                    [
                        {
                            relayName,
                            latency,
                            addressBytes:
                                te.content instanceof Uint8Array ? te.content : undefined
                        }
                    ],
                    []
                )
                await this.deps.lowLevelCoordinator.sendNode(response)
                this.logger.debug('voip_diag outbound_relaylatency_response', {
                    callId,
                    peerJid,
                    stanzaId: response.attrs.id,
                    relayName,
                    latency,
                    authenticatedRelay: authenticatedCandidates.length > 0,
                    authenticatedRelayIds: [
                        ...new Set(authenticatedCandidates.map((candidate) => candidate.relayId))
                    ],
                    authenticatedAddressFamilies: [
                        ...new Set(
                            authenticatedCandidates.map((candidate) => candidate.addressFamily)
                        )
                    ],
                    envelope: summarizeCallEnvelope(response)
                })
                responded++
            } catch (err: unknown) {
                this.logger.error('error responding to incoming relaylatency', {
                    callId,
                    peerJid,
                    relayName,
                    message: toError(err).message
                })
            }
        }

        this.logger.debug('voip_diag inbound_relaylatency_responded', {
            callId,
            peerJid,
            probeCount: teNodes.length,
            responded,
            skipped
        })
    }

    private ingestIncomingRelayUpdate(
        node: BinaryNode,
        source: 'relaylatency' | 'transport'
    ): RelayEndpoint[] {
        const relaySignaling = summarizeRelaySignaling(node)
        const parsed = parseRelayFromAck(node)
        const current = this.info.relayData
        const connectionStarted =
            this.relayCandidates.length > 0 || this.sctpRelay.hasConnection()

        if (parsed.relays.length > 0 && !connectionStarted) {
            this.info.relayData = {
                endpoints: parsed.relays,
                participantJids:
                    parsed.participantJids.length > 0
                        ? parsed.participantJids
                        : current?.participantJids ?? [],
                selfParticipantJid:
                    parsed.selfParticipantJid ?? current?.selfParticipantJid,
                peerParticipantJid:
                    parsed.peerParticipantJid ?? current?.peerParticipantJid,
                uuid: parsed.uuid || current?.uuid || '',
                selfPid: parsed.selfPid ?? current?.selfPid,
                peerPid: parsed.peerPid ?? current?.peerPid,
                hbhKey: parsed.hbhKey ?? current?.hbhKey
            }
        }

        if (parsed.relays.length > 0 || source === 'transport') {
            this.logger.debug('voip_diag inbound_relay_update_received', {
                callId: this.info.callId,
                source,
                applied: parsed.relays.length > 0 && !connectionStarted,
                connectionStarted,
                relayCount: parsed.relays.length,
                relaySignaling,
                relayCandidates: parsed.relays.map((relay) => ({
                    relayName: relay.relayName,
                    relayId: relay.relayId,
                    ip: relay.ip,
                    port: relay.port,
                    addressFamily: relay.addressFamily,
                    isFna: relay.isFna === true,
                    tokenId: relay.tokenId,
                    authTokenId: relay.authTokenId
                }))
            })
        }

        return parsed.relays
    }

    handleRelayElection(node: BinaryNode): void {
        const inner = getFirstNodeChild(node)
        if (!inner) return

        let electedRelayIdx: number | undefined
        if (inner.attrs?.['elected_relay_idx'] !== undefined) {
            const parsed = Number(inner.attrs['elected_relay_idx'])
            if (Number.isSafeInteger(parsed) && parsed >= 0) electedRelayIdx = parsed
        } else if (inner.attrs?.['relay_id'] !== undefined) {
            const parsed = Number(inner.attrs['relay_id'])
            if (Number.isSafeInteger(parsed) && parsed >= 0) electedRelayIdx = parsed
        } else if (inner.content instanceof Uint8Array) {
            const bytes = inner.content
            if (bytes.length >= 4) electedRelayIdx = readUInt32BE(bytes, 0)
            else if (bytes.length > 0) electedRelayIdx = bytes[0]
        }

        if (electedRelayIdx !== undefined) {
            this.info.electedRelayIdx = electedRelayIdx
            const applied = this.sctpRelay.selectMediaConnectionByRelayId(electedRelayIdx)
            this.logger.debug('elected relay index', {
                callId: this.info.callId,
                electedRelayIdx,
                applied
            })
        }
    }

    async handleCallMuteV2(node: BinaryNode, peerJid: string): Promise<void> {
        const nodeInfo = extractNodeInfo(node)
        if (!nodeInfo) return
        this.remoteMuteObserved = true
        this.remoteMuted = nodeInfo.innerNode.attrs?.['mute-state'] === '1'
        this.logger.debug('voip_diag mute_v2_observed', {
            callId: this.info.callId,
            peerJid,
            callCreator: nodeInfo.innerNode.attrs?.['call-creator'],
            muteState: nodeInfo.innerNode.attrs?.['mute-state'],
            direction: this.info.direction,
            acceptPending: this.acceptPending,
            acceptSent: this.acceptSent,
            remoteMuted: this.remoteMuted
        })
        if (this.info.direction === CallDirection.Incoming) {
            this.acceptedByJid = peerJid
            this.acceptCallCreator =
                nodeInfo.innerNode.attrs?.['call-creator'] || this.info.callCreator
            if (this.acceptPending) {
                await this.sendPendingAccept()
            }
            if (!this.remoteMuted) this.armRemoteMediaWatchdog()
            return
        }

        const credentials = this.deps.authClient.getCurrentCredentials()
        const meId = credentials?.meLid || credentials?.meJid || ''
        try {
            const muteNode = buildMuteV2Stanza(
                peerJid,
                this.info.callId,
                this.info.callCreator,
                0,
                meId
            )
            await this.deps.lowLevelCoordinator.sendNode(muteNode)
        } catch (err: unknown) {
            this.logger.error('error sending mute_v2 response', {
                callId: this.info.callId,
                peerJid,
                message: toError(err).message
            })
        }
        if (!this.remoteMuted) this.armRemoteMediaWatchdog()
    }

    handleCallTerminate(): void {
        try {
            this.info.applyTransition({
                type: 'terminated',
                reason: EndCallReason.UserEnded
            })
        } catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message })
        }

        this.delegate.emitEnded(this.info)
        this.delegate.emitState(this.info)
        this.cleanup()
    }

    handleCallReject(): void {
        try {
            this.info.applyTransition({
                type: 'remote_rejected',
                reason: EndCallReason.Declined
            })
        } catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message })
        }

        this.delegate.emitEnded(this.info)
        this.delegate.emitState(this.info)
        this.cleanup()
    }

    handleCallAckError(error: string): void {
        this.logger.error('offer rejected by server', { callId: this.info.callId, error })
        try {
            this.info.applyTransition({
                type: 'terminated',
                reason: EndCallReason.Failed
            })
        } catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message })
        }

        this.delegate.emitEnded(this.info)
        this.delegate.emitState(this.info)
        this.cleanup()
    }

    sendCapturedAudio(data: Float32Array): void {
        const hasRelay = this.sctpRelay.hasConnection()
        if (!this.rtpSession || !this.srtpSession || !this.opusCodec || !hasRelay) {
            this.audioDropCount++
            if (this.audioDropCount === 1 || this.audioDropCount % 500 === 0) {
                const missing = [
                    !this.rtpSession && 'rtpSession',
                    !this.srtpSession && 'srtpSession',
                    !this.opusCodec && 'opusCodec',
                    !hasRelay && 'relayConnection'
                ]
                    .filter(Boolean)
                    .join(', ')
                this.logger.debug('audio dropped', {
                    callId: this.info.callId,
                    dropCount: this.audioDropCount,
                    missing
                })
            }
            return
        }

        for (let i = 0; i < data.length; i++) {
            if (!Number.isFinite(data[i])) {
                data[i] = 0
            }
        }

        const frameSamples = this.encodeFrameSamples
        if (!this.encodeBuffer) {
            if (!this.encodeBufferA) {
                this.encodeBufferA = new Float32Array(frameSamples)
                this.encodeBufferB = new Float32Array(frameSamples)
            }
            this.encodeBuffer = this.encodeBufferA
            this.encodeBufferPos = 0
        }

        let offset = 0
        while (offset < data.length) {
            const toCopy = Math.min(data.length - offset, frameSamples - this.encodeBufferPos)
            this.encodeBuffer.set(data.subarray(offset, offset + toCopy), this.encodeBufferPos)
            this.encodeBufferPos += toCopy
            offset += toCopy

            if (this.encodeBufferPos < frameSamples) break

            const frameData: Float32Array = this.encodeBuffer
            this.encodeBuffer =
                frameData === this.encodeBufferA ? this.encodeBufferB! : this.encodeBufferA!
            this.encodeBufferPos = 0

            try {
                const opusFrame = this.opusCodec.encode(frameData)
                this.sendOpusFrame(opusFrame, false)
                this.realAudioSendCount++
            } catch (err: unknown) {
                this.logger.error('encode error', {
                    callId: this.info.callId,
                    message: toError(err).message
                })
            }
        }
    }

    cleanup(): void {
        const opusStats = this.opusCodec?.getStats()
        this.logger.debug('call stats', {
            callId: this.info.callId,
            relayPackets: this.relayPacketCount,
            recvOk: this.audioRecvCount,
            srtpErrors: this.srtpErrorCount,
            pcmDeliveredFrames: this.pcmDeliveredFrameCount,
            pcmDeliveryErrors: this.pcmDeliveryErrorCount,
            pcmPendingSamples: this.inboundPcmFrames.pendingSamples,
            sent: this.audioSendCount,
            dropped: this.audioDropCount,
            opusOk: opusStats?.success ?? 0,
            opusErr: opusStats?.errors ?? 0
        })

        this.audioEngine.setOnAudioFinished(null)
        this.audioEngine.stop()
        this.stopRemoteMediaWatchdog(true)
        this.stopSrtcpReports()
        this.sctpRelay.cleanup()

        if (this.opusCodec) {
            this.opusCodec.destroy()
            this.opusCodec = null
        }

        this.rtpSession = null
        this.srtpSession = null
        this.srtcpSender = null

        this.audioSendCount = 0
        this.audioDropCount = 0
        this.audioRecvCount = 0
        this.srtpErrorCount = 0
        this.pcmDeliveryErrorCount = 0
        this.pcmDeliveredFrameCount = 0
        this.inboundPcmFrames.clear()
        this.relayPacketCount = 0
        this.stunResponseCount = 0
        this.selfEchoCount = 0
        this.lastRecvSeq = -1
        this.recvSeqGaps = 0
        this.actualPeerSsrc = null
        this.ssrcResubscribed = false
        this.firstRelayRtpLogged = false
        this.firstAudioRecvLogged = false
        this.recvRealCount = 0
        this.recvDtxCount = 0
        this.realAudioSendCount = 0
        this.encodeBuffer = null
        this.encodeBufferPos = 0
        this.acceptedByJid = null
        this.acceptPending = false
        this.acceptSent = false
        this.initialTransportSent = false
        this.outgoingPreacceptSent = false
        this.outgoingPostAcceptSignalingSent = false
        this.remoteMuteObserved = false
        this.remoteMuted = false
        this.incomingRelayPreparePromise = null
        this.selfStreamSsrcs = []
        this.relayCandidates = []
        this.relayCandidateIndex = -1
        this.remoteMediaStarted = false
        this.remoteMediaEstablished = false
        this.lastRemoteMediaProgressAt = 0
        this.relayAttemptStartedAt = 0
        this.relayAttemptAudioBaseCount = 0
        this.lastAuthenticatedAudioCount = 0
    }

    private async sendOutgoingPostAcceptSignaling(acceptingDeviceJid: string): Promise<void> {
        if (
            this.info.direction !== CallDirection.Outgoing ||
            this.outgoingPostAcceptSignalingSent
        ) {
            return
        }

        // This is the post-accept sequence used by the last live-validated Uno
        // implementation. It tells the answering handset to keep the WhatsApp relay
        // transport active and to start sending unmuted media back to the caller.
        this.outgoingPostAcceptSignalingSent = true
        const callId = this.info.callId
        const callCreator = this.info.callCreator
        const credentials = this.deps.authClient.getCurrentCredentials()
        const meId = credentials?.meLid || credentials?.meJid || ''

        try {
            const transportNode = buildTransportStanza(
                acceptingDeviceJid,
                callId,
                callCreator,
                meId,
                '1',
                '1'
            )
            await this.deps.lowLevelCoordinator.sendNode(transportNode)

            const muteNode = buildMuteV2Stanza(
                acceptingDeviceJid,
                callId,
                callCreator,
                0,
                meId
            )
            await this.deps.lowLevelCoordinator.sendNode(muteNode)

            this.logger.debug('voip_diag outgoing_post_accept_signaling_sent', {
                callId,
                acceptingDeviceJid,
                transportMessageType: 1,
                p2pCandidateRound: 1,
                muteState: 0
            })
        } catch (err: unknown) {
            this.outgoingPostAcceptSignalingSent = false
            this.logger.error('error sending outgoing post-accept signaling', {
                callId,
                acceptingDeviceJid,
                message: toError(err).message
            })
        }
    }

    private codecOptionsFor(settings: ParsedVoipSettings): MLowCodecOptions {
        const bitrate =
            settings.targetBitrate > 0
                ? settings.targetBitrate
                : undefined

        return bitrate === undefined
            ? { mode: settings.codecMode }
            : { mode: settings.codecMode, bitrate }
    }

    private get codecOptions(): MLowCodecOptions {
        return this.codecOptionsFor(this.voipSettings)
    }

    private get signalingAudioRate(): '8000' | '16000' {
        return this.voipSettings.codecMode === 'opus' ? '8000' : '16000'
    }

    private get encodeFrameSamples(): number {
        return this.opusCodec?.getFrameSize() ?? 960
    }

    private get rtpTsDelta(): number {
        return this.encodeFrameSamples
    }

    private sendOpusFrame(opusFrame: Uint8Array, isSilence: boolean): void {
        if (!this.rtpSession || !this.srtpSession) return

        try {
            let rtpPayload: Uint8Array = opusFrame

            const authPadding = SRTP_AUTH_TAG_LEN - SRTP_SEND_AUTH_TAG_LEN
            if (authPadding > 0) {
                if (!this.authPaddingBuffer || this.authPaddingBuffer.length !== authPadding) {
                    this.authPaddingBuffer = new Uint8Array(authPadding)
                }
                rtpPayload = concatBytes([rtpPayload, this.authPaddingBuffer])
            }

            const tsDelta = this.rtpTsDelta
            const rtpPacket = this.rtpSession.createWhatsappOpusPacket(opusFrame, tsDelta, rtpPayload)

            if (this.debeEnabled) {
                rtpPacket.header.extension = true
                rtpPacket.header.extensionProfile = 0xdebe
                rtpPacket.header.extensionData = isOpusDtxPayload(opusFrame)
                    ? new Uint8Array([0x30, 0x01, 0x00, 0x00])
                    : WaCallMediaSession.EMPTY_BYTES
            }

            const srtpData = this.srtpSession.protect(rtpPacket)
            this.sctpRelay.broadcast(toArrayBuffer(srtpData))

            this.audioSendCount++
            if (this.audioSendCount === 1 || this.audioSendCount % 500 === 0) {
                this.logger.debug('audio sent', {
                    callId: this.info.callId,
                    sendCount: this.audioSendCount,
                    opusBytes: opusFrame.length,
                    srtpBytes: srtpData.length,
                    silence: isSilence
                })
                if (this.audioSendCount === 1) {
                    this.logger.debug('voip_diag first_audio_sent', {
                        callId: this.info.callId,
                        direction: this.info.direction,
                        selfMediaJid: this.selfMediaJid,
                        selfSsrc: `0x${this.selfSsrc.toString(16).padStart(8, '0')}`,
                        peerSsrcs: this.peerSsrcs.map((value) =>
                            `0x${value.toString(16).padStart(8, '0')}`
                        ),
                        srtpBytes: srtpData.length,
                        opusBytes: opusFrame.length,
                        silence: isSilence,
                        state: this.info.stateData.state
                    })
                }
            }
        } catch (err: unknown) {
            this.logger.error('error sending audio', {
                callId: this.info.callId,
                message: toError(err).message
            })
        }
    }

    private initSrtpKeys(receiveCallKey?: Uint8Array): void {
        const callKey = this.info.encryptionKey
        if (!callKey) {
            this.logger.debug('no call_key, srtp not initialized', { callId: this.info.callId })
            return
        }

        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid
        const ourCredJid = meLid || meId || ''
        const ourBase = toUserJid(ourCredJid)
        const participants = this.info.relayData?.participantJids || []

        const ourDeviceJid =
            this.selfMediaJid || formatE2ESrtpParticipantId(ourCredJid)

        let rawPeerJid =
            this.info.relayData?.peerParticipantJid || this.acceptedByJid || this.info.peerJid
        if (!this.info.relayData?.peerParticipantJid && !this.acceptedByJid) {
            const peerFromParticipants = participants.find((jid) => {
                const jBase = toUserJid(jid)
                return jBase !== ourBase
            })
            if (peerFromParticipants) rawPeerJid = peerFromParticipants
        }
        const peerDeviceJid = formatE2ESrtpParticipantId(rawPeerJid)

        try {
            const sendKeying = derivePerJidSrtpKey(callKey, ourDeviceJid)
            const peerKeyJids = e2eParticipantIdVariants(peerDeviceJid)
            const receiveKeyings = peerKeyJids.map((jid) =>
                derivePerJidSrtpKey(receiveCallKey || callKey, jid)
            )

            this.srtpSession = new SrtpSession(
                sendKeying,
                receiveKeyings[0],
                SRTP_SEND_AUTH_TAG_LEN,
                SRTP_RECV_AUTH_TAG_LEN
            )
            this.srtpSession.setReceiveKeyings(receiveKeyings)
            this.srtcpSender = new SrtcpSender(sendKeying, this.selfSsrc)
            this.startSrtcpReports()
            this.logger.debug('srtp per-jid keys initialized', {
                callId: this.info.callId,
                sendJid: ourDeviceJid,
                recvJids: peerKeyJids
            })
            this.logger.debug('voip_diag srtp_key_identity', {
                callId: this.info.callId,
                direction: this.info.direction,
                callPeerJid: this.info.peerJid,
                acceptedByJid: this.acceptedByJid,
                relaySelfParticipantJid: this.info.relayData?.selfParticipantJid,
                relayPeerParticipantJid: this.info.relayData?.peerParticipantJid,
                sendJid: ourDeviceJid,
                recvJids: peerKeyJids,
                selfSsrc: `0x${this.selfSsrc.toString(16).padStart(8, '0')}`,
                peerSsrcs: this.peerSsrcs.map((value) =>
                    `0x${value.toString(16).padStart(8, '0')}`
                ),
                peerCallKey: !!receiveCallKey
            })
        } catch (err: unknown) {
            this.logger.debug('srtp key derivation failed', {
                callId: this.info.callId,
                message: toError(err).message
            })
        }
    }

    private resetEncodeState(): void {
        this.encodeBuffer = null
        this.encodeBufferPos = 0
        this.realAudioSendCount = 0
    }

    private async sendPendingAccept(): Promise<void> {
        if (!this.acceptPending || this.acceptSent) return

        const acceptStanza = buildDirectAcceptStanza(
            this.info.callId,
            this.acceptedByJid || this.info.peerJid,
            this.acceptCallCreator || this.info.callCreator,
            this.info.mediaType === CallMediaType.Video,
            this.signalingAudioRate
        )
        try {
            await this.deps.lowLevelCoordinator.sendNode(acceptStanza)
            this.acceptPending = false
            this.acceptSent = true
            this.logger.debug('accept sent after caller mute_v2', {
                callId: this.info.callId
            })
            this.logger.debug('voip_diag inbound_accept_sent', {
                callId: this.info.callId,
                to: this.acceptedByJid || this.info.peerJid,
                callCreator: this.acceptCallCreator || this.info.callCreator,
                selfMediaJid: this.selfMediaJid,
                peerSsrcs: this.peerSsrcs.map((value) => `0x${value.toString(16).padStart(8, '0')}`),
                selfPid: this.info.relayData?.selfPid,
                peerPid: this.info.relayData?.peerPid,
                envelope: summarizeCallEnvelope(acceptStanza)
            })
            this.armRemoteMediaWatchdog()
        } catch (err: unknown) {
            this.logger.error('accept send error', { message: toError(err).message })
        }
    }

    private onRelayConnected(): void {
        this.startSrtcpReports()
        if (this.info.stateData.state === CallState.Connecting) {
            try {
                this.info.applyTransition({ type: 'media_connected' })
                this.delegate.emitState(this.info)
                this.startMediaFlow()
                this.logger.debug('relay connected, call active', { callId: this.info.callId })
            } catch (err) {
                this.logger.trace('call transition skipped', { message: toError(err).message })
            }
            return
        }

        if (
            !this.info.isEnded &&
            this.srtpSession &&
            this.rtpSession &&
            this.opusCodec
        ) {
            this.audioEngine.startSilenceCapture()
            this.logger.debug('relay connected, early RTP warmup started', {
                callId: this.info.callId,
                state: this.info.stateData.state
            })
        }
    }

    private onRelayData(data: Uint8Array, connectionId: string): void {
        this.relayPacketCount++

        if (isStunPacket(data)) {
            this.stunResponseCount++
            return
        }

        if (!isRtpPacket(data)) return

        const pt = data[1] & 0x7f
        if (!this.srtpSession || !this.opusCodec) return
        if (!isWhatsappOpusPayloadType(pt)) return

        if (data.length >= 12) {
            const ssrc = ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0
            if (!this.firstRelayRtpLogged) {
                this.firstRelayRtpLogged = true
                this.logger.debug('voip_diag first_relay_rtp_seen', {
                    callId: this.info.callId,
                    direction: this.info.direction,
                    connectionId,
                    payloadType: pt,
                    sequence: data.length >= 4 ? (data[2] << 8) | data[3] : 0,
                    ssrc: `0x${ssrc.toString(16).padStart(8, '0')}`,
                    selfSsrc: `0x${this.selfSsrc.toString(16).padStart(8, '0')}`,
                    knownPeerSsrcs: this.peerSsrcs.map((value) =>
                        `0x${value.toString(16).padStart(8, '0')}`
                    ),
                    acceptedByJid: this.acceptedByJid,
                    relaySelfParticipantJid: this.info.relayData?.selfParticipantJid,
                    relayPeerParticipantJid: this.info.relayData?.peerParticipantJid,
                    selfMediaJid: this.selfMediaJid
                })
            }
            if (ssrc === this.selfSsrc) {
                this.selfEchoCount++
                return
            }

            if (!this.ssrcResubscribed && this.actualPeerSsrc === null) {
                this.actualPeerSsrc = ssrc
                const knownSsrc = this.peerSsrcs.includes(ssrc)
                if (!knownSsrc) {
                    this.peerSsrcs = [ssrc]
                    this.ssrcResubscribed = true
                    this.sctpRelay.setSubscriptionSsrcs(this.peerSsrcs)
                    this.sctpRelay.resendSubscriptions()
                }
            }
        }

        let audioData: Float32Array
        try {
            const rtpPacket = this.srtpSession.unprotect(data)
            const opusPayload = rtpPacket.payload

            this.sctpRelay.selectMediaConnection(connectionId, true)
            if (opusPayload.length === 0) return

            // Counts only authenticated/decrypted WhatsApp Opus payloads. Relay
            // watchdog decisions must not be driven by raw RTP, echo, video or
            // packets that fail SRTP authentication.
            this.audioRecvCount++

            const seq = rtpPacket.header.sequenceNumber
            if (this.lastRecvSeq >= 0) {
                const expected = (this.lastRecvSeq + 1) & 0xffff
                if (seq !== expected) {
                    const gap = ((seq - this.lastRecvSeq + 65536) % 65536) - 1
                    this.recvSeqGaps += gap
                }
            }
            this.lastRecvSeq = seq

            const isDtx = isOpusDtxPayload(opusPayload)
            if (isDtx) this.recvDtxCount++
            else this.recvRealCount++
            if (!this.firstAudioRecvLogged) {
                this.firstAudioRecvLogged = true
                this.logger.debug('voip_diag first_audio_received', {
                    callId: this.info.callId,
                    direction: this.info.direction,
                    sequence: rtpPacket.header.sequenceNumber,
                    timestamp: rtpPacket.header.timestamp,
                    ssrc: `0x${rtpPacket.header.ssrc.toString(16).padStart(8, '0')}`,
                    opusBytes: opusPayload.length,
                    isDtx,
                    recvReal: this.recvRealCount,
                    recvDtx: this.recvDtxCount
                })
            }

            audioData = this.opusCodec.decode(opusPayload)

            if (this.audioRecvCount % 100 === 0) {
                const stats = this.opusCodec.getStats()
                this.logger.debug('audio recv stats', {
                    callId: this.info.callId,
                    recvCount: this.audioRecvCount,
                    real: this.recvRealCount,
                    dtx: this.recvDtxCount,
                    decodeOk: stats.success,
                    decodeErr: stats.errors
                })
            }
        } catch (err: unknown) {
            this.srtpErrorCount++
            if (this.srtpErrorCount <= 5) {
                const ssrc = data.length >= 12 ? readUInt32BE(data, 8) : 0
                this.logger.debug('srtp recv error', {
                    callId: this.info.callId,
                    errorCount: this.srtpErrorCount,
                    message: toError(err).message,
                    ssrc: `0x${ssrc.toString(16)}`
                })
                this.logger.debug('voip_diag rtp_decrypt_failed', {
                    callId: this.info.callId,
                    direction: this.info.direction,
                    errorCount: this.srtpErrorCount,
                    ssrc: `0x${ssrc.toString(16).padStart(8, '0')}`,
                    expectedPeerSsrcs: this.peerSsrcs.map((value) =>
                        `0x${value.toString(16).padStart(8, '0')}`
                    ),
                    acceptedByJid: this.acceptedByJid,
                    relaySelfParticipantJid: this.info.relayData?.selfParticipantJid,
                    relayPeerParticipantJid: this.info.relayData?.peerParticipantJid,
                    selfMediaJid: this.selfMediaJid,
                    message: toError(err).message
                })
            }
            return
        }

        try {
            for (const frame of this.inboundPcmFrames.push(audioData)) {
                this.audioEngine.onPlaybackData(frame)
                this.delegate.emitInboundAudio(this.info, frame)
                this.pcmDeliveredFrameCount++
            }
        } catch (err: unknown) {
            this.pcmDeliveryErrorCount++
            if (this.pcmDeliveryErrorCount <= 5) {
                this.logger.debug('inbound pcm delivery error', {
                    callId: this.info.callId,
                    errorCount: this.pcmDeliveryErrorCount,
                    decodedSamples: audioData.length,
                    pendingSamples: this.inboundPcmFrames.pendingSamples,
                    message: toError(err).message
                })
            }
        }
    }

    private async connectRelays(endpoints: RelayEndpoint[]): Promise<void> {
        this.logger.debug('connecting relays', {
            callId: this.info.callId,
            endpointCount: endpoints.length
        })

        const candidates = orderMediaRelayCandidates(
            endpoints,
            this.info.direction === CallDirection.Incoming
        )

        if (candidates.length === 0) {
            this.logger.error('no relay configs', { callId: this.info.callId })
            return
        }

        if (this.relayCandidates.length > 0 && this.relayCandidateIndex >= 0) {
            this.logger.trace('relay candidates already initialized', {
                callId: this.info.callId,
                currentAttempt: this.relayCandidateIndex + 1,
                candidateCount: this.relayCandidates.length
            })
            return
        }

        this.stopRemoteMediaWatchdog(false)
        this.relayCandidates = candidates
        this.relayCandidateIndex = 0
        this.remoteMediaEstablished = false
        this.resetRemoteMediaTracking()

        this.logger.debug('media relay recovery sequence initialized', {
            callId: this.info.callId,
            direction: this.info.direction,
            candidateCount: candidates.length,
            candidates: candidates.map((candidate, index) => ({
                attempt: index + 1,
                relayName: candidate.name,
                relayId: candidate.relayId,
                ip: candidate.ip,
                port: candidate.port,
                addressFamily: candidate.addressFamily,
                tokenId: candidate.tokenId,
                authTokenId: candidate.authTokenId,
                isFna: candidate.isFna === true
            }))
        })

        try {
            if (
                this.info.direction === CallDirection.Incoming &&
                candidates.length > 1
            ) {
                const first = candidates[0]
                this.provisionalRelayId = first.relayId
                this.relayAttemptStartedAt = Date.now()
                this.sctpRelay.setSsrc(this.selfSsrc)
                this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs)
                this.sctpRelay.setSubscriptionSsrcs(this.peerSsrcs)
                this.sctpRelay.setParticipantPids(
                    this.info.relayData?.selfPid,
                    this.info.relayData?.peerPid
                )

                // Keep every advertised relay allocated and publish startup RTP
                // on all of them until authenticated remote media confirms the
                // path selected by the caller. Some direct incoming offers do
                // not include a later relay-election stanza, so sending only on
                // our provisional path can leave a live relay with control
                // pongs but no bidirectional media.
                this.sctpRelay.setStartupMediaFanout(true)
                this.logger.info('inbound relay candidates preconnected with startup media fanout', {
                    callId: this.info.callId,
                    candidateCount: candidates.length,
                    provisionalRelayId: first.relayId,
                    relayIds: candidates.map((candidate) => candidate.relayId),
                    relayNames: candidates.map((candidate) => candidate.name),
                    relayAddressFamilies: candidates.map(
                        (candidate) => candidate.addressFamily
                    )
                })
                await this.sctpRelay.configureRelays(candidates)

                const provisionalApplied = this.sctpRelay.selectMediaConnectionByRelayId(
                    first.relayId
                )
                this.logger.debug('inbound relay candidates configured', {
                    callId: this.info.callId,
                    connected: this.sctpRelay.getConnectedCount(),
                    candidateCount: candidates.length,
                    provisionalRelayId: first.relayId,
                    provisionalApplied
                })
            } else {
                await this.connectRelayCandidate(0, 'initial_selection')
            }
        } finally {
            // Relay setup may finish while the native transport is still
            // connecting. Start the bounded watchdog here as well as on the
            // open event so a candidate that never opens cannot wait for the
            // native transport's longer connection timeout.
            this.armRemoteMediaWatchdog()
        }
    }

    private async connectRelayCandidate(index: number, reason: string): Promise<void> {
        const candidate = this.relayCandidates[index]
        if (!candidate || this.info.isEnded) return

        if (this.selfStreamSsrcs.length !== 9) {
            this.logger.error('WASM relay streams not initialized', { callId: this.info.callId })
            return
        }

        this.provisionalRelayId = candidate.relayId
        this.relayAttemptStartedAt = Date.now()
        this.sctpRelay.setSsrc(this.selfSsrc)
        this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs)
        this.sctpRelay.setSubscriptionSsrcs(this.peerSsrcs)
        this.sctpRelay.setParticipantPids(
            this.info.relayData?.selfPid,
            this.info.relayData?.peerPid
        )

        this.logger.info('relay candidate attempt started', {
            callId: this.info.callId,
            reason,
            attempt: index + 1,
            candidateCount: this.relayCandidates.length,
            relayName: candidate.name,
            relayId: candidate.relayId,
            ip: candidate.ip,
            port: candidate.port,
            addressFamily: candidate.addressFamily,
            tokenId: candidate.tokenId,
            authTokenId: candidate.authTokenId,
            isFna: candidate.isFna === true
        })

        try {
            // One native transport at a time. A recovery always resets the
            // previous candidate before reaching this method.
            await this.sctpRelay.configureRelays([candidate])
            const provisionalApplied =
                this.provisionalRelayId !== undefined &&
                this.sctpRelay.selectMediaConnectionByRelayId(this.provisionalRelayId)
            this.logger.debug('sctp relays configured', {
                callId: this.info.callId,
                connected: this.sctpRelay.getConnectedCount(),
                attempt: index + 1,
                candidateCount: this.relayCandidates.length,
                provisionalRelayId: this.provisionalRelayId,
                provisionalApplied
            })
        } catch (err: unknown) {
            this.logger.error('sctp relay error', {
                callId: this.info.callId,
                message: toError(err).message
            })
        }
    }

    private isCallAcceptedForMedia(): boolean {
        if (this.info.isEnded) return false

        const state = this.info.stateData.state
        if (state !== CallState.Connecting && state !== CallState.Active) return false

        return this.info.direction === CallDirection.Incoming
            ? this.acceptSent
            : this.acceptedByJid !== null
    }

    private isRemoteMediaExpected(): boolean {
        // The watchdog also covers a candidate whose native transport never
        // opens. Relay connectivity is evaluated separately and is not a
        // prerequisite for starting the bounded recovery timer.
        return this.isCallAcceptedForMedia() && !this.remoteMuted
    }

    private get authenticatedAudioCountForAttempt(): number {
        return Math.max(0, this.audioRecvCount - this.relayAttemptAudioBaseCount)
    }

    private resetRemoteMediaTracking(): void {
        this.remoteMediaStarted = false
        this.lastRemoteMediaProgressAt = 0
        this.relayAttemptAudioBaseCount = this.audioRecvCount
        this.lastAuthenticatedAudioCount = 0
        this.firstRelayRtpLogged = false
        this.firstAudioRecvLogged = false
    }

    private markRemoteMediaEstablished(authenticatedAudio: number): void {
        if (this.remoteMediaEstablished) return
        this.remoteMediaEstablished = true
        this.stopRemoteMediaWatchdog(false)
        this.logger.info('remote media established; relay recovery watchdog stopped', {
            callId: this.info.callId,
            attempt: this.relayCandidateIndex + 1,
            authenticatedAudio,
            threshold: REMOTE_MEDIA_ESTABLISHED_AUDIO_FRAMES
        })
    }

    private noteRemoteMediaProgress(): void {
        if (!this.isRemoteMediaExpected() || this.remoteMediaEstablished) return

        const authenticatedAudio = this.authenticatedAudioCountForAttempt
        if (authenticatedAudio <= this.lastAuthenticatedAudioCount) return

        this.remoteMediaStarted = true
        this.lastRemoteMediaProgressAt = Date.now()
        this.lastAuthenticatedAudioCount = authenticatedAudio

        if (authenticatedAudio >= REMOTE_MEDIA_ESTABLISHED_AUDIO_FRAMES) {
            this.markRemoteMediaEstablished(authenticatedAudio)
            return
        }

        if (!this.relayRecoveryTimer && !this.relayRecoveryInFlight) {
            this.scheduleRemoteMediaWatchdog(REMOTE_MEDIA_STALL_TIMEOUT_MS)
        }
    }

    private armRemoteMediaWatchdog(): void {
        if (
            !this.isRemoteMediaExpected() ||
            this.remoteMediaEstablished ||
            this.relayRecoveryTimer ||
            this.relayRecoveryInFlight
        ) {
            return
        }

        const authenticatedAudio = this.authenticatedAudioCountForAttempt
        if (authenticatedAudio >= REMOTE_MEDIA_ESTABLISHED_AUDIO_FRAMES) {
            this.markRemoteMediaEstablished(authenticatedAudio)
            return
        }
        if (authenticatedAudio > 0) {
            this.remoteMediaStarted = true
            this.lastRemoteMediaProgressAt = Date.now()
            this.lastAuthenticatedAudioCount = authenticatedAudio
            this.scheduleRemoteMediaWatchdog(REMOTE_MEDIA_STALL_TIMEOUT_MS)
            return
        }

        this.scheduleRemoteMediaWatchdog(REMOTE_MEDIA_FIRST_PACKET_TIMEOUT_MS)
    }

    private scheduleRemoteMediaWatchdog(delayMs: number): void {
        if (this.relayRecoveryTimer || this.info.isEnded) return

        const generation = this.relayRecoveryGeneration
        this.relayRecoveryTimer = setTimeout(() => {
            this.relayRecoveryTimer = null
            void this.evaluateRemoteMediaWatchdog(generation)
        }, Math.max(1, delayMs))
    }

    private async evaluateRemoteMediaWatchdog(generation: number): Promise<void> {
        if (
            generation !== this.relayRecoveryGeneration ||
            !this.isRemoteMediaExpected() ||
            this.remoteMediaEstablished ||
            this.relayRecoveryInFlight
        ) {
            return
        }

        const stats = this.sctpRelay.getReceiveStats()
        const authenticatedAudio = this.authenticatedAudioCountForAttempt
        if (authenticatedAudio > this.lastAuthenticatedAudioCount) {
            this.remoteMediaStarted = true
            this.lastRemoteMediaProgressAt = Date.now()
            this.lastAuthenticatedAudioCount = authenticatedAudio
        }

        if (authenticatedAudio >= REMOTE_MEDIA_ESTABLISHED_AUDIO_FRAMES) {
            this.markRemoteMediaEstablished(authenticatedAudio)
            return
        }

        const controlAgeMs = Math.max(0, Date.now() - stats.lastControlResponseAt)
        const controlAlive =
            stats.readyConnections > 0 &&
            stats.pongs > 0 &&
            stats.lastControlResponseAt > 0 &&
            controlAgeMs <= REMOTE_MEDIA_CONTROL_FRESH_MS
        if (!controlAlive) {
            const controlUnavailableForMs = Math.max(
                0,
                Date.now() - this.relayAttemptStartedAt
            )
            if (
                this.relayAttemptStartedAt > 0 &&
                controlUnavailableForMs >= REMOTE_MEDIA_CONTROL_STARTUP_TIMEOUT_MS
            ) {
                await this.recoverRemoteMedia('relay_control_unavailable', stats)
                return
            }

            this.logger.trace('remote media watchdog waiting for live relay control', {
                callId: this.info.callId,
                attempt: this.relayCandidateIndex + 1,
                readyConnections: stats.readyConnections,
                pongs: stats.pongs,
                controlAgeMs,
                controlUnavailableForMs,
                rtp: stats.rtp,
                rtcp: stats.rtcp,
                authenticatedAudio
            })
            this.scheduleRemoteMediaWatchdog(
                Math.min(
                    REMOTE_MEDIA_CONTROL_RECHECK_MS,
                    Math.max(
                        1,
                        REMOTE_MEDIA_CONTROL_STARTUP_TIMEOUT_MS - controlUnavailableForMs
                    )
                )
            )
            return
        }

        if (!this.remoteMediaStarted) {
            if (this.info.direction === CallDirection.Incoming) {
                // A direct inbound call has no protocol message that elects a new
                // relay after our accept. MeowCaller keeps the endpoint selected
                // from the offer for the whole call. Resetting a live transport
                // here makes the caller continue sending to the old relay while
                // we listen on another one, which produces control pongs but no
                // remote RTP. Keep the current relay when control is healthy and
                // allow a late first packet to establish media normally.
                this.stopRemoteMediaWatchdog(false)
                this.logger.warn('inbound remote media delayed; retaining live relay candidate', {
                    callId: this.info.callId,
                    attempt: this.relayCandidateIndex + 1,
                    relayName: this.relayCandidates[this.relayCandidateIndex]?.name,
                    relayId: this.relayCandidates[this.relayCandidateIndex]?.relayId,
                    rtp: stats.rtp,
                    rtcp: stats.rtcp,
                    pongs: stats.pongs,
                    authenticatedAudio
                })
                return
            }
            await this.recoverRemoteMedia('no_first_remote_media', stats)
            return
        }

        const stalledForMs = Math.max(0, Date.now() - this.lastRemoteMediaProgressAt)
        if (stalledForMs < REMOTE_MEDIA_STALL_TIMEOUT_MS) {
            this.scheduleRemoteMediaWatchdog(
                REMOTE_MEDIA_STALL_TIMEOUT_MS - stalledForMs
            )
            return
        }

        if (this.info.direction === CallDirection.Incoming) {
            // As above, there is no post-accept relay re-election for direct
            // inbound calls. Preserve a transport that still has live control;
            // a hard transport/control failure remains eligible for recovery.
            this.stopRemoteMediaWatchdog(false)
            this.logger.warn('inbound remote media stalled; retaining live relay candidate', {
                callId: this.info.callId,
                attempt: this.relayCandidateIndex + 1,
                relayName: this.relayCandidates[this.relayCandidateIndex]?.name,
                relayId: this.relayCandidates[this.relayCandidateIndex]?.relayId,
                stalledForMs,
                rtp: stats.rtp,
                rtcp: stats.rtcp,
                pongs: stats.pongs,
                authenticatedAudio
            })
            return
        }

        await this.recoverRemoteMedia('remote_media_stalled', stats)
    }

    private async handleRelayFailure(failure: {
        connectionId: string
        relayId: number
        relayName?: string
        ip: string
        port: number
        reason: string
    }): Promise<void> {
        if (this.info.isEnded || this.relayRecoveryInFlight) return

        const current = this.relayCandidates[this.relayCandidateIndex]
        if (
            !current ||
            current.relayId !== failure.relayId ||
            current.ip !== failure.ip ||
            current.port !== failure.port
        ) {
            this.logger.trace('stale relay failure ignored', {
                callId: this.info.callId,
                failure,
                currentRelayId: current?.relayId,
                currentIp: current?.ip,
                currentPort: current?.port
            })
            return
        }

        this.logger.warn('relay transport failed; advancing recovery candidate', {
            callId: this.info.callId,
            attempt: this.relayCandidateIndex + 1,
            candidateCount: this.relayCandidates.length,
            connectionId: failure.connectionId,
            relayName: failure.relayName,
            relayId: failure.relayId,
            reason: failure.reason
        })
        await this.recoverRemoteMedia(
            'relay_transport_failed',
            this.sctpRelay.getReceiveStats()
        )
    }

    private async recoverRemoteMedia(
        reason:
            | 'no_first_remote_media'
            | 'remote_media_stalled'
            | 'relay_control_unavailable'
            | 'relay_transport_failed',
        stats: ReturnType<WaSctpRelay['getReceiveStats']>
    ): Promise<void> {
        if (this.relayRecoveryInFlight || this.info.isEnded) return

        const nextIndex = this.relayCandidateIndex + 1
        const current = this.relayCandidates[this.relayCandidateIndex]
        const next = this.relayCandidates[nextIndex]

        if (!next) {
            this.stopRemoteMediaWatchdog(false)
            this.logger.warn('relay recovery candidates exhausted', {
                callId: this.info.callId,
                reason,
                attempts: this.relayCandidateIndex + 1,
                candidateCount: this.relayCandidates.length,
                relayName: current?.name,
                relayId: current?.relayId,
                rtp: stats.rtp,
                rtcp: stats.rtcp,
                pongs: stats.pongs,
                authenticatedAudio: this.authenticatedAudioCountForAttempt
            })
            return
        }

        this.stopRemoteMediaWatchdog(false)
        const generation = this.relayRecoveryGeneration
        this.relayCandidateIndex = nextIndex

        const recovery = (async () => {
            this.logger.warn('remote media stalled; switching relay candidate', {
                callId: this.info.callId,
                reason,
                fromAttempt: nextIndex,
                toAttempt: nextIndex + 1,
                candidateCount: this.relayCandidates.length,
                fromRelayName: current?.name,
                fromRelayId: current?.relayId,
                toRelayName: next.name,
                toRelayId: next.relayId,
                rtp: stats.rtp,
                rtcp: stats.rtcp,
                pongs: stats.pongs,
                authenticatedAudio: this.authenticatedAudioCountForAttempt
            })

            this.sctpRelay.resetTransport(reason)
            this.remoteMediaEstablished = false
            this.resetRemoteMediaTracking()
            await this.connectRelayCandidate(nextIndex, reason)

            if (generation !== this.relayRecoveryGeneration || this.info.isEnded) return

            this.logger.info('relay recovery candidate configured', {
                callId: this.info.callId,
                attempt: nextIndex + 1,
                candidateCount: this.relayCandidates.length,
                relayName: next.name,
                relayId: next.relayId,
                ip: next.ip,
                port: next.port
            })
        })()

        this.relayRecoveryInFlight = recovery
        try {
            await recovery
        } finally {
            if (this.relayRecoveryInFlight === recovery) {
                this.relayRecoveryInFlight = null
            }
            if (generation === this.relayRecoveryGeneration && !this.info.isEnded) {
                this.armRemoteMediaWatchdog()
            }
        }
    }

    private stopRemoteMediaWatchdog(clearRecovery: boolean): void {
        this.relayRecoveryGeneration++
        if (this.relayRecoveryTimer) {
            clearTimeout(this.relayRecoveryTimer)
            this.relayRecoveryTimer = null
        }
        if (clearRecovery) this.relayRecoveryInFlight = null
    }

    private startMediaFlow(): void {
        this.resetEncodeState()
        this.audioEngine.startPlayback()
        this.audioEngine.startCapture()
    }

    private startSrtcpReports(): void {
        if (
            this.srtcpTimer ||
            !this.srtcpSender ||
            !this.rtpSession ||
            !this.sctpRelay.hasConnection()
        ) {
            return
        }

        this.srtcpTimer = setInterval(() => {
            if (!this.srtcpSender || !this.rtpSession || !this.sctpRelay.hasConnection()) return

            try {
                const stats = this.rtpSession.getSenderStats()
                const packet = this.srtcpSender.createSenderReport(stats)
                this.sctpRelay.broadcast(toArrayBuffer(packet))
                this.srtcpSendCount++
                if (this.srtcpSendCount === 1 || this.srtcpSendCount % 20 === 0) {
                    this.logger.debug('srtcp sender report sent', {
                        callId: this.info.callId,
                        count: this.srtcpSendCount,
                        bytes: packet.length,
                        ...stats
                    })
                }
            } catch (err: unknown) {
                this.logger.warn('srtcp sender report failed', {
                    callId: this.info.callId,
                    message: toError(err).message
                })
            }
        }, 1500)
    }

    private stopSrtcpReports(): void {
        if (this.srtcpTimer) {
            clearInterval(this.srtcpTimer)
            this.srtcpTimer = null
        }
        this.srtcpSendCount = 0
    }
}
