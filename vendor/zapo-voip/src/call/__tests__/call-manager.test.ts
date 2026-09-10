import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Logger } from 'zapo-js'
import type { BinaryNode } from 'zapo-js/transport'

import {
    formatE2ESrtpParticipantId,
    generateSecureSsrc,
    generateWasmRelayStreamSsrcs,
    prepareWasmRelayStreamSsrcs
} from '../../crypto/ssrc.js'
import { CallDirection, CallState, type WaVoipDeps, type WaVoipStores } from '../../types.js'
import { type CallInfo } from '../call-state.js'
import { WaCallManager } from '../WaCallManager.js'
import { WaCallMediaSession } from '../WaCallMediaSession.js'

function createMockDeps(): { deps: WaVoipDeps; stores: WaVoipStores; sent: BinaryNode[] } {
    const sent: BinaryNode[] = []
    const deps = {
        authClient: {
            getCurrentCredentials: () => ({
                meJid: '1111111111@lid',
                meLid: '1111111111@lid',
                signedIdentity: undefined
            })
        },
        lowLevelCoordinator: {
            sendNode: async (node: BinaryNode) => {
                sent.push(node)
            },
            query: async () => undefined
        },
        signalProtocol: {
            encryptMessage: async () => ({ type: 'msg', ciphertext: new Uint8Array([1, 2, 3]) }),
            encryptMessagesBatch: async (requests: readonly unknown[]) =>
                requests.map(() => ({ type: 'msg', ciphertext: new Uint8Array([1, 2, 3]) })),
            decryptMessage: async () => new Uint8Array([1, 2, 3])
        },
        signalDeviceSync: {
            syncDeviceList: async (jids: readonly string[]) => [
                {
                    jid: jids[0],
                    deviceJids: [jids[0].replace(/@lid$/, ':0@lid')]
                }
            ],
            queryLidsByPhoneJids: async () => []
        },
        presenceCoordinator: {
            subscribe: async () => undefined
        },
        messageDispatch: {
            syncSignalSession: async () => undefined
        },
        sessionResolver: {
            ensureSessionsBatch: async () => []
        }
    } as unknown as WaVoipDeps
    const stores = {
        privacyToken: { getByJid: async () => undefined }
    } as unknown as WaVoipStores

    return { deps, stores, sent }
}

function createCaptureLogger(): {
    logger: Logger
    entries: Array<{ level: string; message: string; context: Record<string, unknown> }>
} {
    const entries: Array<{
        level: string
        message: string
        context: Record<string, unknown>
    }> = []
    const createLogger = (bindings: Record<string, unknown>): Logger => {
        const capture =
            (level: string) =>
            (message: string, context: Readonly<Record<string, unknown>> = {}) => {
                entries.push({ level, message, context: { ...bindings, ...context } })
            }
        return {
            level: 'trace',
            trace: capture('trace'),
            debug: capture('debug'),
            info: capture('info'),
            warn: capture('warn'),
            error: capture('error'),
            child: (childBindings) => createLogger({ ...bindings, ...childBindings })
        }
    }

    return { logger: createLogger({}), entries }
}

function buildOfferNode(callId: string, from = '2222222222:0@lid'): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'OFFERMSGID' },
        content: [
            {
                tag: 'offer',
                attrs: {
                    'call-id': callId,
                    'call-creator': from
                },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined }
                ]
            }
        ]
    }
}

function buildTerminateNode(callId: string, from = '2222222222:0@lid'): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'TERMINATEMSGID' },
        content: [
            {
                tag: 'terminate',
                attrs: {
                    'call-id': callId,
                    'call-creator': from
                }
            }
        ]
    }
}

function buildMuteNode(callId: string, from = '2222222222:0@lid'): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'MUTEMSGID' },
        content: [
            {
                tag: 'mute_v2',
                attrs: {
                    'call-id': callId,
                    'call-creator': from,
                    'mute-state': '0'
                }
            }
        ]
    }
}

function buildAcceptNode(callId: string, from = '2222222222:0@lid'): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'ACCEPTMSGID' },
        content: [
            {
                tag: 'accept',
                attrs: {
                    'call-id': callId,
                    'call-creator': '1111111111@lid'
                }
            }
        ]
    }
}

function buildRejectNode(callId: string, from = '2222222222:0@lid'): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'REJECTMSGID' },
        content: [
            {
                tag: 'reject',
                attrs: {
                    'call-id': callId,
                    'call-creator': '1111111111@lid'
                }
            }
        ]
    }
}

function buildRelayOfferAck(callId: string): BinaryNode {
    return {
        tag: 'ack',
        attrs: { class: 'call', type: 'offer' },
        content: [
            {
                tag: 'relay',
                attrs: { 'call-id': callId, uuid: 'UUID-1', self_pid: '5', peer_pid: '7' },
                content: [
                    {
                        tag: 'participant',
                        attrs: { jid: '2222222222:28@lid', pid: '7' },
                        content: undefined
                    },
                    {
                        tag: 'participant',
                        attrs: { jid: '1111111111:59@lid', pid: '5' },
                        content: undefined
                    },
                    { tag: 'key', attrs: {}, content: new TextEncoder().encode('RELAYKEY') },
                    { tag: 'token', attrs: { id: '0' }, content: new Uint8Array([1, 2, 3]) },
                    {
                        tag: 'te2',
                        attrs: {
                            token_id: '0',
                            relay_name: 'gru1c01',
                            relay_id: '1',
                            c2r_rtt: '20'
                        },
                        content: new Uint8Array([192, 168, 1, 1, 0x0d, 0x96])
                    }
                ]
            }
        ]
    }
}

function buildRelayPatch(
    callId: string,
    relayName: string,
    relayId: number,
    address: Uint8Array
): BinaryNode {
    const source = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    return {
        ...source,
        content: (source.content as BinaryNode[]).map((child) =>
            child.tag === 'te2'
                ? {
                      ...child,
                      attrs: {
                          ...child.attrs,
                          relay_name: relayName,
                          relay_id: String(relayId)
                      },
                      content: address
                  }
                : child
        )
    }
}

function withVoipSettings(
    node: BinaryNode,
    useMlowCodecV1: boolean,
    targetBitrate = 25_000
): BinaryNode {
    const settings = {
        encode: {
            use_mlow_codec_v1: String(useMlowCodecV1),
            frame_ms: '20'
        },
        rc: {
            target_bitrate: String(targetBitrate)
        }
    }
    const envelopeContent = node.content as BinaryNode[]
    const innerContent = envelopeContent[0]?.content
    const settingsContainer = Array.isArray(innerContent)
        ? innerContent
        : envelopeContent
    settingsContainer.push({
        tag: 'voip_settings',
        attrs: {},
        content: new TextEncoder().encode(JSON.stringify(settings))
    })
    return node
}

test('WaCallManager rejects invalid maxConcurrentCalls', () => {
    const { deps, stores } = createMockDeps()
    assert.throws(
        () => new WaCallManager({ deps, stores, maxConcurrentCalls: 0 }),
        /maxConcurrentCalls must be a positive safe integer/
    )
})

test('already-ended offer notification is ignored without preaccepting it', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const node = buildOfferNode('ENDED-CALL')
    const offer = (node.content as BinaryNode[])[0]
    const attrs = offer.attrs as Record<string, string>
    attrs.is_call_ended = '1'
    attrs.terminate_reason = 'accepted_elsewhere'

    await manager.handleCallOffer(node, '2222222222:0@lid')

    assert.equal(manager.getCall('ENDED-CALL'), null)
    assert.equal(sent.length, 0)
})

test('incoming offer sends only preaccept without opening media or proactive relay latency', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMINGCALLWITHRELAY00000001'
    const peer = '2222222222:28@lid'
    const offerNode = buildOfferNode(callId, peer)
    const offer = (offerNode.content as BinaryNode[])[0]
    const relay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;(offer.content as BinaryNode[]).push(relay)

    const originalPrepare = WaCallMediaSession.prototype.prepareIncomingRelay
    let prepares = 0
    WaCallMediaSession.prototype.prepareIncomingRelay = async () => {
        prepares++
    }
    try {
        await manager.handleCallOffer(offerNode, peer)
    } finally {
        WaCallMediaSession.prototype.prepareIncomingRelay = originalPrepare
    }

    const actions = sent.map((node) => (node.content as BinaryNode[])?.[0])
    assert.equal(prepares, 0)
    assert.deepEqual(actions.map((node) => node?.tag), ['preaccept'])
    assert.deepEqual(sent.map((node) => node.attrs.to), [peer])
    assert.equal(actions.filter((node) => node?.tag === 'preaccept').length, 1)
    assert.equal(actions.filter((node) => node?.tag === 'relaylatency').length, 0)
    const preaccept = actions.find((node) => node?.tag === 'preaccept')!
    const session = (manager as any).calls.get(callId)
    const audio = (preaccept.content as BinaryNode[]).find(
        (node) => node.tag === 'audio'
    )
    assert.equal(session.opusCodec.getMode(), 'mlow')
    assert.equal(audio?.attrs.rate, '16000')
    const capability = (preaccept.content as BinaryNode[]).find(
        (node) => node.tag === 'capability'
    )
    assert.deepEqual(
        capability?.content,
        new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x07])
    )
})

test('incoming offer selects RFC Opus and advertises 8000 when voip_settings disables MLow', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-OPUS-FALLBACK'
    const peer = '2222222222:0@lid'

    await manager.handleCallOffer(
        withVoipSettings(buildOfferNode(callId, peer), false),
        peer
    )

    const session = (manager as any).calls.get(callId)
    assert.equal(session.opusCodec.getMode(), 'opus')
    assert.equal(session.opusCodec.usesSmpl(), false)

    const preacceptEnvelope = sent.find(
        (node) => (node.content as BinaryNode[])?.[0]?.tag === 'preaccept'
    )
    assert.ok(preacceptEnvelope)
    const preaccept = (preacceptEnvelope.content as BinaryNode[])[0]
    const audio = (preaccept.content as BinaryNode[]).find(
        (node) => node.tag === 'audio'
    )
    assert.equal(audio?.attrs.rate, '8000')
})

test('incoming relay preparation is idempotent', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-RELAY-PREPARE-ONCE'

    await manager.handleCallOffer(buildOfferNode(callId), '2222222222:0@lid')
    const session = (manager as any).calls.get(callId)
    session.info.relayData = {
        endpoints: [
            {
                ip: '57.144.137.57',
                port: 3478,
                token: 'relay-token',
                rawToken: new Uint8Array([1, 2, 3]),
                key: 'relay-key',
                relayId: 0,
                relayName: 'bsb1c01',
                tokenId: '0',
                authTokenId: '0'
            }
        ],
        participantJids: ['2222222222:0@lid'],
        uuid: ''
    }
    let connects = 0
    session.connectRelays = async () => {
        connects++
    }

    await Promise.all([
        session.prepareIncomingRelay(),
        session.prepareIncomingRelay(),
        session.prepareIncomingRelay()
    ])

    assert.equal(connects, 1)
})

test('incoming transport records the relay but does not start media before answer', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-TRANSPORT-WAITS-ANSWER'
    const peer = '2222222222:28@lid'

    await manager.handleCallOffer(buildOfferNode(callId, peer), peer)
    const session = (manager as any).calls.get(callId)
    let connects = 0
    session.connectRelays = async () => {
        connects++
    }

    await session.handleCallTransport({
        tag: 'call',
        attrs: { from: peer, id: 'TRANSPORT-MSG' },
        content: [
            {
                tag: 'transport',
                attrs: { 'call-id': callId, 'call-creator': peer },
                content: [
                    {
                        tag: 'relay',
                        attrs: {
                            ip: '57.144.137.57',
                            port: '3478',
                            token: 'relay-token',
                            key: 'relay-key'
                        }
                    }
                ]
            }
        ]
    })

    assert.equal(connects, 0)
    manager.getCall(callId)!.encryptionKey = new Uint8Array(32).fill(9)
    await manager.acceptCall(callId)
    assert.equal(connects, 1)
})

test('outgoing media relay preparation opens exactly one selected UDP candidate', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    let configuredRelays: unknown[] = []
    const selectedRelayIds: number[] = []
    const startupFanoutModes: boolean[] = []

    session.sctpRelay.configureRelays = async (relays: unknown[]) => {
        configuredRelays = relays
    }
    session.sctpRelay.selectMediaConnectionByRelayId = (relayId: number) => {
        selectedRelayIds.push(relayId)
        return true
    }
    session.sctpRelay.setStartupMediaFanout = (enabled: boolean) => {
        startupFanoutModes.push(enabled)
    }

    await session.connectRelays([
        {
            ip: '157.240.226.133',
            port: 3478,
            token: 'relay-token-1',
            rawToken: new Uint8Array([1, 2, 3]),
            key: 'relay-key-1',
            relayId: 1,
            relayName: 'gru1c02',
            tokenId: '1',
            authTokenId: '0',
            protocol: 0
        },
        {
            ip: '57.144.137.57',
            port: 3478,
            token: 'relay-token-2',
            rawToken: new Uint8Array([4, 5, 6]),
            key: 'relay-key-2',
            relayId: 0,
            relayName: 'bsb1c01',
            tokenId: '0',
            authTokenId: '0',
            protocol: 0
        }
    ])

    assert.deepEqual(
        configuredRelays.map((relay: any) => relay.name),
        ['bsb1c01']
    )
    assert.deepEqual(selectedRelayIds, [0])
    assert.deepEqual(startupFanoutModes, [])
})

test('incoming media relay preparation fans startup media across preconnected candidates', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-MULTI-RELAY'
    const peer = '2222222222:28@lid'

    await manager.handleCallOffer(buildOfferNode(callId, peer), peer)
    const session = (manager as any).calls.get(callId)
    let configuredRelays: unknown[] = []
    const selectedRelayIds: number[] = []
    const startupFanoutModes: boolean[] = []

    session.sctpRelay.configureRelays = async (relays: unknown[]) => {
        configuredRelays = relays
    }
    session.sctpRelay.selectMediaConnectionByRelayId = (relayId: number) => {
        selectedRelayIds.push(relayId)
        return true
    }
    session.sctpRelay.setStartupMediaFanout = (enabled: boolean) => {
        startupFanoutModes.push(enabled)
    }

    await session.connectRelays([
        {
            ip: '157.240.226.133',
            port: 3478,
            token: 'relay-token-1',
            rawToken: new Uint8Array([1, 2, 3]),
            key: 'relay-key-1',
            relayId: 1,
            relayName: 'gru1c02',
            tokenId: '1',
            authTokenId: '0',
            protocol: 0
        },
        {
            ip: '57.144.137.57',
            port: 3478,
            token: 'relay-token-2',
            rawToken: new Uint8Array([4, 5, 6]),
            key: 'relay-key-2',
            relayId: 0,
            relayName: 'bsb1c01',
            tokenId: '0',
            authTokenId: '0',
            protocol: 0
        }
    ])

    assert.deepEqual(
        configuredRelays.map((relay: any) => relay.name),
        ['gru1c02', 'bsb1c01']
    )
    assert.deepEqual(selectedRelayIds, [1])
    assert.deepEqual(startupFanoutModes, [true])
    session.handleCallTerminate()
})

test('remote-media startup stall resets only the relay and advances one candidate', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    const resetReasons: string[] = []
    let stats = {
        rtp: 0,
        rtcp: 0,
        pongs: 1,
        received: 3,
        readyConnections: 1,
        lastControlResponseAt: Date.now()
    }

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.hasConnection = () => true
    session.sctpRelay.getReceiveStats = () => stats
    session.sctpRelay.resetTransport = (reason: string) => {
        resetReasons.push(reason)
    }

    await session.connectRelays([
        {
            ip: '157.240.226.133',
            port: 3499,
            token: 'relay-token-1',
            rawToken: new Uint8Array([1, 2, 3]),
            key: 'relay-key-1',
            relayId: 1,
            relayName: 'gru1c02',
            tokenId: '1',
            authTokenId: '0'
        },
        {
            ip: '57.144.137.57',
            port: 3501,
            token: 'relay-token-2',
            rawToken: new Uint8Array([4, 5, 6]),
            key: 'relay-key-2',
            relayId: 0,
            relayName: 'bsb1c01',
            tokenId: '0',
            authTokenId: '0'
        }
    ])

    session.info.stateData.state = CallState.Active
    session.acceptedByJid = '2222222222:0@lid'
    const generation = session.relayRecoveryGeneration
    await session.evaluateRemoteMediaWatchdog(generation)

    assert.deepEqual(configured, ['bsb1c01', 'gru1c02'])
    assert.deepEqual(resetReasons, ['no_first_remote_media'])
    assert.equal(session.relayCandidateIndex, 1)
    assert.equal(session.sctpRelay.getConfiguredRelayCount(), 0)

    stats = { ...stats, pongs: 2 }
    session.stopRemoteMediaWatchdog(true)
    session.cleanup()
})

test('incoming call retains a live relay while waiting for the first remote media', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    const resetReasons: string[] = []

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.hasConnection = () => true
    session.sctpRelay.getReceiveStats = () => ({
        rtp: 0,
        rtcp: 0,
        pongs: 2,
        received: 4,
        readyConnections: 1,
        lastControlResponseAt: Date.now()
    })
    session.sctpRelay.resetTransport = (reason: string) => resetReasons.push(reason)

    session.info.direction = CallDirection.Incoming
    await session.connectRelays([
        {
            ip: '57.144.137.57', port: 3478, token: 'a', rawToken: new Uint8Array([1]),
            key: 'a', relayId: 0, relayName: 'bsb1c01', authTokenId: '0'
        },
        {
            ip: '157.240.226.133', port: 3478, token: 'b', rawToken: new Uint8Array([2]),
            key: 'b', relayId: 1, relayName: 'gru1c02', authTokenId: '0'
        }
    ])

    session.info.stateData.state = CallState.Active
    session.acceptSent = true
    const generation = session.relayRecoveryGeneration
    await session.evaluateRemoteMediaWatchdog(generation)

    assert.deepEqual(configured, ['bsb1c01'])
    assert.deepEqual(resetReasons, [])
    assert.equal(session.relayCandidateIndex, 0)
    assert.equal(session.relayRecoveryTimer, null)
    session.cleanup()
})

test('relay candidate that never opens or answers control advances after the bounded startup deadline', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    const resetReasons: string[] = []
    let resolveSecondCandidate!: () => void
    const secondCandidateConfigured = new Promise<void>((resolve) => {
        resolveSecondCandidate = resolve
    })

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
        if (configured.length === 1) {
            // Keep the production timer path but avoid making the test wait
            // the full control deadline after connectRelays returns.
            session.relayAttemptStartedAt = Date.now() - 3001
        } else if (configured.length === 2) {
            resolveSecondCandidate()
        }
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.hasConnection = () => false
    session.sctpRelay.getReceiveStats = () => ({
        rtp: 0,
        rtcp: 0,
        pongs: 0,
        received: 0,
        readyConnections: 0,
        lastControlResponseAt: 0
    })
    session.sctpRelay.resetTransport = (reason: string) => resetReasons.push(reason)

    session.info.stateData.state = CallState.Active
    session.acceptedByJid = '2222222222:0@lid'

    await session.connectRelays([
        {
            ip: '57.144.137.57', port: 3478, token: 'a', rawToken: new Uint8Array([1]),
            key: 'a', relayId: 0, relayName: 'bsb1c01', authTokenId: '0'
        },
        {
            ip: '157.240.226.133', port: 3478, token: 'b', rawToken: new Uint8Array([2]),
            key: 'b', relayId: 1, relayName: 'gru1c02', authTokenId: '0'
        }
    ])
    assert.equal(session.relayRecoveryTimer !== null, true)
    let timeout: NodeJS.Timeout | null = null
    try {
        await Promise.race([
            secondCandidateConfigured,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('relay recovery watchdog did not advance')),
                    2500
                )
            })
        ])
    } finally {
        if (timeout) clearTimeout(timeout)
    }
    if (session.relayRecoveryInFlight) {
        await session.relayRecoveryInFlight
    }

    assert.deepEqual(configured, ['bsb1c01', 'gru1c02'])
    assert.deepEqual(resetReasons, ['relay_control_unavailable'])
    assert.equal(session.relayCandidateIndex, 1)
    session.stopRemoteMediaWatchdog(true)
    session.cleanup()
})

test('relay transport failures advance each advertised candidate once and preserve media state', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    const resetReasons: string[] = []
    const reapplied = { ssrc: 0, streams: 0, subscriptions: 0, pids: 0 }

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.getReceiveStats = () => ({
        rtp: 0,
        rtcp: 0,
        pongs: 0,
        received: 0,
        readyConnections: 0,
        lastControlResponseAt: 0
    })
    session.sctpRelay.resetTransport = (reason: string) => resetReasons.push(reason)
    session.sctpRelay.setSsrc = () => reapplied.ssrc++
    session.sctpRelay.setStreamSsrcs = () => reapplied.streams++
    session.sctpRelay.setSubscriptionSsrcs = () => reapplied.subscriptions++
    session.sctpRelay.setParticipantPids = () => reapplied.pids++

    await session.connectRelays([
        {
            ip: '57.144.137.57', port: 3478, token: 'a', rawToken: new Uint8Array([1]),
            key: 'a', relayId: 0, relayName: 'bsb1c01', authTokenId: '0'
        },
        {
            ip: '157.240.226.133', port: 3478, token: 'b', rawToken: new Uint8Array([2]),
            key: 'b', relayId: 1, relayName: 'gru1c02', authTokenId: '0'
        },
        {
            ip: '31.13.93.53', port: 3480, token: 'c', rawToken: new Uint8Array([3]),
            key: 'c', relayId: 2, relayName: 'fna1c01', authTokenId: '2', isFna: true
        }
    ])

    const preservedRtp = { kind: 'rtp' }
    const preservedSrtp = { kind: 'srtp' }
    session.rtpSession = preservedRtp
    session.srtpSession = preservedSrtp

    await session.handleRelayFailure({
        connectionId: 'stale', relayId: 99, ip: '127.0.0.1', port: 3478,
        reason: 'native_transport_error'
    })
    assert.deepEqual(configured, ['bsb1c01'])

    const first = session.relayCandidates[0]
    await Promise.all([
        session.handleRelayFailure({
            connectionId: 'first', relayId: first.relayId, ip: first.ip, port: first.port,
            reason: 'native_transport_error'
        }),
        session.handleRelayFailure({
            connectionId: 'first-duplicate', relayId: first.relayId, ip: first.ip, port: first.port,
            reason: 'native_transport_error'
        })
    ])

    const second = session.relayCandidates[1]
    await session.handleRelayFailure({
        connectionId: 'second', relayId: second.relayId, ip: second.ip, port: second.port,
        reason: 'connection_timeout'
    })
    const third = session.relayCandidates[2]
    await session.handleRelayFailure({
        connectionId: 'third', relayId: third.relayId, ip: third.ip, port: third.port,
        reason: 'native_transport_error'
    })

    assert.deepEqual(configured, ['bsb1c01', 'gru1c02', 'fna1c01'])
    assert.deepEqual(resetReasons, ['relay_transport_failed', 'relay_transport_failed'])
    assert.deepEqual(reapplied, { ssrc: 3, streams: 3, subscriptions: 3, pids: 3 })
    assert.equal(session.rtpSession, preservedRtp)
    assert.equal(session.srtpSession, preservedSrtp)
    session.stopRemoteMediaWatchdog(true)
    session.cleanup()
})

test('relay recovery does not switch candidates while muted or on hold', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    let resets = 0

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.getReceiveStats = () => ({
        rtp: 0, rtcp: 0, pongs: 0, received: 0, readyConnections: 0,
        lastControlResponseAt: 0
    })
    session.sctpRelay.resetTransport = () => resets++

    await session.connectRelays([
        {
            ip: '57.144.137.57', port: 3478, token: 'a', rawToken: new Uint8Array([1]),
            key: 'a', relayId: 0, relayName: 'bsb1c01', authTokenId: '0'
        },
        {
            ip: '157.240.226.133', port: 3478, token: 'b', rawToken: new Uint8Array([2]),
            key: 'b', relayId: 1, relayName: 'gru1c02', authTokenId: '0'
        }
    ])
    session.info.stateData.state = CallState.Active
    session.acceptedByJid = '2222222222:0@lid'
    session.relayAttemptStartedAt = Date.now() - 3001
    session.remoteMuted = true
    await session.evaluateRemoteMediaWatchdog(session.relayRecoveryGeneration)

    session.remoteMuted = false
    session.info.stateData.state = CallState.OnHold
    await session.evaluateRemoteMediaWatchdog(session.relayRecoveryGeneration)

    assert.deepEqual(configured, ['bsb1c01'])
    assert.equal(resets, 0)
    session.stopRemoteMediaWatchdog(true)
    session.cleanup()
})

test('two authenticated Opus frames followed by three seconds of silence advance the relay candidate', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    const resetReasons: string[] = []
    const stats = {
        rtp: 2,
        rtcp: 0,
        pongs: 5,
        received: 12,
        readyConnections: 1,
        lastControlResponseAt: Date.now()
    }

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.hasConnection = () => true
    session.sctpRelay.getReceiveStats = () => stats
    session.sctpRelay.resetTransport = (reason: string) => resetReasons.push(reason)

    await session.connectRelays([
        {
            ip: '57.144.137.57', port: 3478, token: 'a', rawToken: new Uint8Array([1]),
            key: 'a', relayId: 0, relayName: 'bsb1c01', authTokenId: '0'
        },
        {
            ip: '157.240.226.133', port: 3478, token: 'b', rawToken: new Uint8Array([2]),
            key: 'b', relayId: 1, relayName: 'gru1c02', authTokenId: '0'
        }
    ])
    session.info.stateData.state = CallState.Active
    session.acceptedByJid = '2222222222:0@lid'
    session.audioRecvCount = 2
    session.relayAttemptAudioBaseCount = 0
    session.remoteMediaStarted = true
    session.lastAuthenticatedAudioCount = 2
    session.lastRemoteMediaProgressAt = Date.now() - 3001

    await session.evaluateRemoteMediaWatchdog(session.relayRecoveryGeneration)

    assert.deepEqual(configured, ['bsb1c01', 'gru1c02'])
    assert.deepEqual(resetReasons, ['remote_media_stalled'])
    session.stopRemoteMediaWatchdog(true)
    session.cleanup()
})

test('ten authenticated Opus frames establish media and stop relay recovery', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const configured: string[] = []
    let resets = 0
    const stats = {
        rtp: 46,
        rtcp: 6,
        pongs: 5,
        received: 60,
        readyConnections: 1,
        lastControlResponseAt: Date.now()
    }

    session.sctpRelay.configureRelays = async (relays: Array<{ name: string }>) => {
        configured.push(relays[0]?.name)
    }
    session.sctpRelay.selectMediaConnectionByRelayId = () => true
    session.sctpRelay.hasConnection = () => true
    session.sctpRelay.getReceiveStats = () => stats
    session.sctpRelay.resetTransport = () => resets++

    await session.connectRelays([
        {
            ip: '57.144.137.57', port: 3478, token: 'a', rawToken: new Uint8Array([1]),
            key: 'a', relayId: 0, relayName: 'bsb1c01', authTokenId: '0'
        },
        {
            ip: '157.240.226.133', port: 3478, token: 'b', rawToken: new Uint8Array([2]),
            key: 'b', relayId: 1, relayName: 'gru1c02', authTokenId: '0'
        }
    ])
    session.info.stateData.state = CallState.Active
    session.acceptedByJid = '2222222222:0@lid'
    session.audioRecvCount = 10
    session.relayAttemptAudioBaseCount = 0
    session.remoteMediaStarted = true
    session.lastAuthenticatedAudioCount = 2
    session.lastRemoteMediaProgressAt = Date.now() - 3001

    await session.evaluateRemoteMediaWatchdog(session.relayRecoveryGeneration)

    assert.deepEqual(configured, ['bsb1c01'])
    assert.equal(resets, 0)
    assert.equal(session.lastAuthenticatedAudioCount, 10)
    assert.equal(session.remoteMediaEstablished, true)
    assert.equal(session.relayRecoveryTimer, null)

    session.stopRemoteMediaWatchdog(true)
    session.cleanup()
})

test('incoming relaylatency skips a relay absent from the authenticated offer', async () => {
    const { deps, stores, sent } = createMockDeps()
    const { logger, entries } = createCaptureLogger()
    const manager = new WaCallManager({ deps, stores, logger })
    const callId = 'INCOMING-RELAYLATENCY-MEOW'
    const peer = '2222222222:28@lid'

    const offerNode = buildOfferNode(callId, peer)
    const relay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;((offerNode.content as BinaryNode[])[0].content as BinaryNode[]).push(relay)
    await manager.handleCallOffer(offerNode, peer)
    sent.length = 0

    await manager.handleCallRelaylatency(
        {
            tag: 'call',
            attrs: { from: peer, id: 'RELAYLATENCY-MSG' },
            content: [
                {
                    tag: 'relaylatency',
                    attrs: { 'call-id': callId, 'call-creator': peer },
                    content: [
                        {
                            tag: 'te',
                            attrs: { relay_name: 'bsb1c01', latency: String(0x2000000 + 42) },
                            content: new Uint8Array([57, 144, 137, 57, 0x0d, 0x96])
                        }
                    ]
                }
            ]
        },
        peer
    )

    assert.equal(sent.length, 0)
    const session = (manager as any).calls.get(callId)
    assert.equal(session.info.relayData.endpoints[0].relayName, 'gru1c01')

    const offerLog = entries.find((entry) => entry.message === 'voip_diag incoming_offer_identity')
    const offerSummary = offerLog?.context.relaySignaling as
        | { candidateNodeCount: number; candidates: Array<{ tokenBytes: number }> }
        | undefined
    assert.equal(offerSummary?.candidateNodeCount, 1)
    assert.equal(offerSummary?.candidates[0]?.tokenBytes, 3)

    const latencyLog = entries.find(
        (entry) => entry.message === 'voip_diag inbound_relaylatency_received'
    )
    const latencySummary = latencyLog?.context.relaySignaling as
        | {
              probeCount: number
              probes: Array<{
                  relayName: string
                  ip?: string
                  port?: number
                  addressBytes: number
              }>
          }
        | undefined
    assert.equal(latencySummary?.probeCount, 1)
    assert.deepEqual(latencySummary?.probes[0], {
        relayName: 'bsb1c01',
        encodedLatency: 0x2000000 + 42,
        latency: 42,
        addressBytes: 6,
        addressFamily: 'ipv4',
        ip: '57.144.137.57',
        port: 3478,
        parseOutcome: 'parsed_ipv4'
    })
    const responseLog = entries.find(
        (entry) => entry.message === 'voip_diag outbound_relaylatency_response'
    )
    assert.equal(responseLog, undefined)
    const skippedLog = entries.find(
        (entry) => entry.message === 'voip_diag unauthenticated_relaylatency_skipped'
    )
    assert.equal(skippedLog?.context.relayName, 'bsb1c01')
    assert.equal(skippedLog?.context.latency, 42)
    assert.deepEqual(skippedLog?.context.availableRelayNames, ['gru1c01'])
    const completedLog = entries.find(
        (entry) => entry.message === 'voip_diag inbound_relaylatency_responded'
    )
    assert.equal(completedLog?.context.probeCount, 1)
    assert.equal(completedLog?.context.responded, 0)
    assert.equal(completedLog?.context.skipped, 1)
})

test('incoming relaylatency answers authenticated probes and skips unknown probes independently', async () => {
    const { deps, stores, sent } = createMockDeps()
    const { logger, entries } = createCaptureLogger()
    const manager = new WaCallManager({ deps, stores, logger })
    const callId = 'INCOMING-RELAYLATENCY-MIXED'
    const peer = '2222222222:28@lid'

    const offerNode = buildOfferNode(callId, peer)
    const relay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;((offerNode.content as BinaryNode[])[0].content as BinaryNode[]).push(relay)
    await manager.handleCallOffer(offerNode, peer)
    sent.length = 0

    await manager.handleCallRelaylatency(
        {
            tag: 'call',
            attrs: { from: peer, id: 'RELAYLATENCY-MIXED-MSG' },
            content: [
                {
                    tag: 'relaylatency',
                    attrs: { 'call-id': callId, 'call-creator': peer },
                    content: [
                        {
                            tag: 'te',
                            attrs: {
                                relay_name: 'fcgb9c01',
                                latency: String(0x2000000 + 27)
                            },
                            content: new Uint8Array([201, 26, 223, 32, 0x0d, 0x96])
                        },
                        {
                            tag: 'te',
                            attrs: {
                                relay_name: 'gru1c01',
                                latency: String(0x2000000 + 41)
                            },
                            content: new Uint8Array([192, 168, 1, 1, 0x0d, 0x96])
                        }
                    ]
                }
            ]
        },
        peer
    )

    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.attrs.to, peer)
    const response = (sent[0]?.content as BinaryNode[])[0]
    const responseChildren = response.content as BinaryNode[]
    assert.equal(response.tag, 'relaylatency')
    assert.equal(responseChildren.some((child) => child.tag === 'destination'), false)
    assert.equal(responseChildren[0]?.attrs.relay_name, 'gru1c01')
    assert.equal(responseChildren[0]?.attrs.latency, String(0x2000000 + 41))

    const skippedLog = entries.find(
        (entry) => entry.message === 'voip_diag unauthenticated_relaylatency_skipped'
    )
    assert.equal(skippedLog?.context.relayName, 'fcgb9c01')
    const responseLog = entries.find(
        (entry) => entry.message === 'voip_diag outbound_relaylatency_response'
    )
    assert.equal(responseLog?.context.stanzaId, sent[0]?.attrs.id)
    assert.equal(responseLog?.context.relayName, 'gru1c01')
    assert.equal(responseLog?.context.authenticatedRelay, true)
    assert.deepEqual(responseLog?.context.authenticatedRelayIds, [1])
    assert.deepEqual(responseLog?.context.authenticatedAddressFamilies, [4])
    const completedLog = entries.find(
        (entry) => entry.message === 'voip_diag inbound_relaylatency_responded'
    )
    assert.equal(completedLog?.context.probeCount, 2)
    assert.equal(completedLog?.context.responded, 1)
    assert.equal(completedLog?.context.skipped, 1)
})

test('incoming relaylatency applies a nested authenticated relay before media starts', async () => {
    const { deps, stores, sent } = createMockDeps()
    const { logger, entries } = createCaptureLogger()
    const manager = new WaCallManager({ deps, stores, logger })
    const callId = 'INCOMING-RELAYLATENCY-RELAY-PATCH'
    const peer = '2222222222:28@lid'
    const offerNode = buildOfferNode(callId, peer)
    const initialRelay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;((offerNode.content as BinaryNode[])[0].content as BinaryNode[]).push(initialRelay)
    await manager.handleCallOffer(offerNode, peer)
    sent.length = 0

    const relayPatch = buildRelayPatch(
        callId,
        'gig4c02',
        2,
        new Uint8Array([31, 13, 91, 133, 0x0d, 0x96])
    )

    await manager.handleCallRelaylatency(
        {
            tag: 'call',
            attrs: { from: peer, id: 'RELAYLATENCY-PATCH-MSG' },
            content: [
                {
                    tag: 'relaylatency',
                    attrs: { 'call-id': callId, 'call-creator': peer },
                    content: [
                        {
                            tag: 'te',
                            attrs: { relay_name: 'gig4c02', latency: String(0x2000000 + 30) },
                            content: new Uint8Array([31, 13, 91, 133, 0x0d, 0x96])
                        },
                        relayPatch
                    ]
                }
            ]
        },
        peer
    )

    const session = (manager as any).calls.get(callId)
    assert.equal(session.info.relayData.endpoints.length, 1)
    assert.equal(session.info.relayData.endpoints[0].relayName, 'gig4c02')
    assert.equal(session.info.relayData.endpoints[0].relayId, 2)
    assert.equal(session.info.relayData.endpoints[0].ip, '31.13.91.133')
    assert.equal(sent.length, 1)
    const responseLog = entries.find(
        (entry) => entry.message === 'voip_diag outbound_relaylatency_response'
    )
    assert.equal(responseLog?.context.relayName, 'gig4c02')
    assert.equal(responseLog?.context.authenticatedRelay, true)
    assert.deepEqual(responseLog?.context.authenticatedRelayIds, [2])
    assert.deepEqual(responseLog?.context.authenticatedAddressFamilies, [4])
})

test('incoming transport understands a nested relay allocation', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-TRANSPORT-RELAY-PATCH'
    const peer = '2222222222:28@lid'
    const offerNode = buildOfferNode(callId, peer)
    const initialRelay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;((offerNode.content as BinaryNode[])[0].content as BinaryNode[]).push(initialRelay)
    await manager.handleCallOffer(offerNode, peer)

    const relayPatch = buildRelayPatch(
        callId,
        'bsb1c01',
        0,
        new Uint8Array([57, 144, 137, 57, 0x0d, 0x96])
    )

    await manager.handleCallTransport(
        {
            tag: 'call',
            attrs: { from: peer, id: 'TRANSPORT-PATCH-MSG' },
            content: [
                {
                    tag: 'transport',
                    attrs: { 'call-id': callId, 'call-creator': peer },
                    content: [relayPatch]
                }
            ]
        },
        peer
    )

    const session = (manager as any).calls.get(callId)
    assert.equal(session.info.relayData.endpoints.length, 1)
    assert.equal(session.info.relayData.endpoints[0].relayName, 'bsb1c01')
    assert.equal(session.info.relayData.endpoints[0].relayId, 0)
    assert.equal(session.info.relayData.endpoints[0].ip, '57.144.137.57')
})

test('relaylatency received before the inbound offer session is replayed after preaccept', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-EARLY-RELAYLATENCY'
    const peer = '2222222222:28@lid'
    const relaylatency: BinaryNode = {
        tag: 'call',
        attrs: { from: peer, id: 'EARLY-RELAYLATENCY-MSG' },
        content: [
            {
                tag: 'relaylatency',
                attrs: { 'call-id': callId, 'call-creator': peer },
                content: [
                    {
                        tag: 'te',
                        attrs: { relay_name: 'gru1c01', latency: String(0x2000000 + 18) },
                        content: new Uint8Array([57, 144, 67, 57, 0x0d, 0x96])
                    }
                ]
            }
        ]
    }

    await manager.handleCallRelaylatency(relaylatency, peer)
    assert.equal(sent.length, 0)

    const offerNode = buildOfferNode(callId, peer)
    const relay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;((offerNode.content as BinaryNode[])[0].content as BinaryNode[]).push(relay)
    await manager.handleCallOffer(offerNode, peer)

    const actions = sent.map((node) => (node.content as BinaryNode[])?.[0])
    assert.deepEqual(actions.map((node) => node?.tag), ['preaccept', 'relaylatency'])
    assert.equal(sent[1]?.attrs.to, peer)
    const response = (sent[1]?.content as BinaryNode[])[0]
    assert.equal(response.tag, 'relaylatency')
    assert.equal(
        (response.content as BinaryNode[]).some((child) => child.tag === 'destination'),
        false
    )
    assert.equal((manager as any).pendingRelaylatency.size, 0)
})

test('relay election applies the announced relay id to media egress', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    let selectedRelayId = -1

    session.sctpRelay.selectMediaConnectionByRelayId = (relayId: number) => {
        selectedRelayId = relayId
        return true
    }
    session.handleRelayElection({
        tag: 'call',
        attrs: { from: '2222222222:0@lid', id: 'ELECTION-STANZA' },
        content: [
            {
                tag: 'relay_election',
                attrs: {
                    'call-id': callId,
                    'call-creator': '1111111111:59@lid',
                    elected_relay_idx: '1'
                }
            }
        ]
    })

    assert.equal(session.info.electedRelayIdx, 1)
    assert.equal(selectedRelayId, 1)
})

test('media path is confirmed only after remote SRTP authentication succeeds', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const peerSsrc = session.peerSsrcs[0]
    const packet = new Uint8Array(12)
    packet[0] = 0x80
    packet[1] = 120
    packet[8] = (peerSsrc >>> 24) & 0xff
    packet[9] = (peerSsrc >>> 16) & 0xff
    packet[10] = (peerSsrc >>> 8) & 0xff
    packet[11] = peerSsrc & 0xff
    const selected: Array<{ connectionId: string; confirmed: boolean }> = []

    session.sctpRelay.selectMediaConnection = (connectionId: string, confirmed: boolean) => {
        selected.push({ connectionId, confirmed })
        return true
    }
    session.opusCodec = {
        decode: () => new Float32Array(960),
        getStats: () => ({ success: 1, errors: 0 })
    }
    session.srtpSession = {
        unprotect: () => {
            throw new Error('invalid auth tag')
        }
    }

    session.onRelayData(packet, 'relay-invalid')
    assert.deepEqual(selected, [])

    session.srtpSession = {
        unprotect: () => ({
            header: { sequenceNumber: 1, timestamp: 960, ssrc: peerSsrc },
            payload: new Uint8Array([0xf8, 0xff, 0xfe])
        })
    }
    session.onRelayData(packet, 'relay-valid')

    assert.deepEqual(selected, [{ connectionId: 'relay-valid', confirmed: true }])
})

test('inbound media splits a 1920-sample decode into exact bridge frames', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const peerSsrc = session.peerSsrcs[0]
    const packet = new Uint8Array(12)
    packet[0] = 0x80
    packet[1] = 120
    packet[8] = (peerSsrc >>> 24) & 0xff
    packet[9] = (peerSsrc >>> 16) & 0xff
    packet[10] = (peerSsrc >>> 8) & 0xff
    packet[11] = peerSsrc & 0xff
    const decoded = Float32Array.from({ length: 1920 }, (_, index) => index)
    const received: Float32Array[] = []

    session.sctpRelay.selectMediaConnection = () => true
    session.audioEngine.onPlaybackData = () => undefined
    session.opusCodec = {
        decode: () => decoded,
        getStats: () => ({ success: 1, errors: 0 }),
        destroy: () => undefined
    }
    session.srtpSession = {
        unprotect: () => ({
            header: { sequenceNumber: 1, timestamp: 1920, ssrc: peerSsrc },
            payload: new Uint8Array([0xf8, 0xff, 0xfe])
        })
    }
    manager.on('call_inbound_audio', (_call, pcm) => received.push(pcm))

    session.onRelayData(packet, 'relay-valid')

    assert.equal(received.length, 2)
    assert.deepEqual(received[0], decoded.slice(0, 960))
    assert.deepEqual(received[1], decoded.slice(960))
    assert.deepEqual(received.map((frame) => frame.length), [960, 960])
    assert.equal(session.srtpErrorCount, 0)
    assert.equal(session.pcmDeliveryErrorCount, 0)
    assert.equal(session.pcmDeliveredFrameCount, 2)
    manager.destroy()
})

test('inbound media delivery failures are not reported as SRTP failures', async () => {
    const { deps, stores } = createMockDeps()
    const { logger, entries } = createCaptureLogger()
    const manager = new WaCallManager({ deps, stores, logger })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const peerSsrc = session.peerSsrcs[0]
    const packet = new Uint8Array(12)
    packet[0] = 0x80
    packet[1] = 120
    packet[8] = (peerSsrc >>> 24) & 0xff
    packet[9] = (peerSsrc >>> 16) & 0xff
    packet[10] = (peerSsrc >>> 8) & 0xff
    packet[11] = peerSsrc & 0xff

    session.sctpRelay.selectMediaConnection = () => true
    session.audioEngine.onPlaybackData = () => undefined
    session.opusCodec = {
        decode: () => new Float32Array(960),
        getStats: () => ({ success: 1, errors: 0 }),
        destroy: () => undefined
    }
    session.srtpSession = {
        unprotect: () => ({
            header: { sequenceNumber: 1, timestamp: 960, ssrc: peerSsrc },
            payload: new Uint8Array([0xf8, 0xff, 0xfe])
        })
    }
    manager.on('call_inbound_audio', () => {
        throw new Error('bridge unavailable')
    })

    session.onRelayData(packet, 'relay-valid')

    assert.equal(session.srtpErrorCount, 0)
    assert.equal(session.pcmDeliveryErrorCount, 1)
    assert.equal(session.pcmDeliveredFrameCount, 0)
    assert.ok(entries.some((entry) => entry.message === 'inbound pcm delivery error'))
    assert.equal(entries.some((entry) => entry.message === 'srtp recv error'), false)
    manager.destroy()
})

test('startCall blocks when maxConcurrentCalls is reached', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    await manager.startCall({ peerJid: '2222222222@lid' })

    await assert.rejects(
        () => manager.startCall({ peerJid: '3333333333@lid' }),
        /max concurrent calls reached \(1\)/
    )
})

test('startCall allows parallel calls when maxConcurrentCalls > 1', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 2 })

    const callIdA = await manager.startCall({ peerJid: '2222222222@lid' })
    const callIdB = await manager.startCall({ peerJid: '3333333333@lid' })

    assert.notEqual(callIdA, callIdB)
    assert.equal(manager.getCalls().length, 2)
})

test('startCall uses an inline enc for one explicit peer device', async () => {
    const { deps, stores, sent } = createMockDeps()
    let syncCalls = 0
    deps.signalDeviceSync.syncDeviceList = async () => {
        syncCalls++
        return [{ jid: '2222222222@lid', deviceJids: ['2222222222:99@lid'] }]
    }
    const manager = new WaCallManager({ deps, stores })

    await manager.startCall({
        peerJid: '2222222222@lid',
        peerDevices: ['2222222222:7@lid', '2222222222:7@lid']
    })

    assert.equal(syncCalls, 0)
    const offer = (sent[0].content as BinaryNode[])[0]
    const destination = (offer.content as BinaryNode[]).find((node) => node.tag === 'destination')
    const inlineEnc = (offer.content as BinaryNode[]).find((node) => node.tag === 'enc')
    assert.equal(destination, undefined)
    assert.ok(inlineEnc)
})

test('startCall prepares PN and resolved LID presence before a single-device inline offer', async () => {
    const { deps, stores, sent } = createMockDeps()
    const subscribed: string[] = []
    deps.signalDeviceSync.queryLidsByPhoneJids = async () => [
        { lidJid: '2222222222@lid' }
    ] as any
    ;(deps.presenceCoordinator as any).subscribe = async (jid: string) => {
        subscribed.push(jid)
    }
    deps.signalDeviceSync.syncDeviceList = async () => [
        { jid: '2222222222@lid', deviceJids: ['2222222222:28@lid'] }
    ]
    const manager = new WaCallManager({ deps, stores })

    await manager.startCall({ peerJid: '5511999999999@s.whatsapp.net' })

    assert.deepEqual(subscribed, ['5511999999999@s.whatsapp.net', '2222222222@lid'])
    const offer = (sent[0].content as BinaryNode[])[0]
    const destination = (offer.content as BinaryNode[]).find((node) => node.tag === 'destination')
    const inlineEnc = (offer.content as BinaryNode[]).find((node) => node.tag === 'enc')
    assert.equal(destination, undefined)
    assert.ok(inlineEnc)
})

test('startCall keeps destination routing for multiple peer devices', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })

    await manager.startCall({
        peerJid: '2222222222@lid',
        peerDevices: ['2222222222:7@lid', '2222222222:8@lid']
    })

    const offer = (sent[0].content as BinaryNode[])[0]
    const destination = (offer.content as BinaryNode[]).find((node) => node.tag === 'destination')
    const inlineEnc = (offer.content as BinaryNode[]).find((node) => node.tag === 'enc')
    assert.ok(destination)
    assert.equal(inlineEnc, undefined)
    assert.deepEqual(
        (destination.content as BinaryNode[]).map((node) => node.attrs.jid),
        ['2222222222:7@lid', '2222222222:8@lid']
    )
})

test('startCall rejects explicit peerDevices from another account', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })

    await assert.rejects(
        () =>
            manager.startCall({
                peerJid: '2222222222@lid',
                peerDevices: ['3333333333:7@lid']
            }),
        /no explicit peer devices match/
    )
})

test('outgoing preaccept and accept emit the official relay signaling once', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const peer = '2222222222:0@lid'
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    session.connectRelays = async () => undefined
    await session.handleCallAck(buildRelayOfferAck(callId))

    sent.length = 0
    await manager.handleCallPreaccept(
        {
            tag: 'call',
            attrs: { from: peer, id: 'PREACCEPTMSGID' },
            content: [
                {
                    tag: 'preaccept',
                    attrs: { 'call-id': callId, 'call-creator': '1111111111@lid' }
                }
            ]
        },
        peer
    )
    await manager.handleCallPreaccept(
        {
            tag: 'call',
            attrs: { from: peer, id: 'PREACCEPTMSGID-RETRY' },
            content: [
                {
                    tag: 'preaccept',
                    attrs: { 'call-id': callId, 'call-creator': '1111111111@lid' }
                }
            ]
        },
        peer
    )

    await manager.handleCallAccept(buildAcceptNode(callId, peer), peer)
    await manager.handleCallAccept(buildAcceptNode(callId, peer), peer)

    const actionNodes = sent.flatMap((node) =>
        Array.isArray(node.content)
            ? node.content
                  .filter(
                      (child): child is BinaryNode =>
                          typeof child === 'object' && child !== null && 'tag' in child
                  )
            : []
    )
    const transports = actionNodes.filter((node) => node.tag === 'transport')
    const muteNodes = actionNodes.filter((node) => node.tag === 'mute_v2')
    const relayLatencyNodes = actionNodes.filter((node) => node.tag === 'relaylatency')
    const initialTransports = transports.filter(
        (node) => node.attrs['transport-message-type'] === '0'
    )
    const acceptedTransports = transports.filter(
        (node) => node.attrs['transport-message-type'] === '1'
    )

    assert.equal(relayLatencyNodes.length, 2)
    assert.equal(initialTransports.length, 1)
    assert.equal(acceptedTransports.length, 1)
    assert.equal(muteNodes.length, 1)
    assert.equal(initialTransports[0]?.attrs['p2p-cand-round'], '0')
    assert.equal(acceptedTransports[0]?.attrs['p2p-cand-round'], '1')
    assert.deepEqual(
        (acceptedTransports[0]?.content as BinaryNode[]).map((node) => [node.tag, node.attrs]),
        [['net', { medium: '2', protocol: '0' }]]
    )
    assert.equal(muteNodes[0]?.attrs['mute-state'], '0')

    const transportEnvelope = sent.find(
        (node) => Array.isArray(node.content) && node.content.includes(acceptedTransports[0]!)
    )
    const initialTransportEnvelope = sent.find(
        (node) => Array.isArray(node.content) && node.content.includes(initialTransports[0]!)
    )
    const muteEnvelope = sent.find(
        (node) => Array.isArray(node.content) && node.content.includes(muteNodes[0]!)
    )
    assert.equal(initialTransportEnvelope?.attrs.to, '2222222222@lid')
    assert.equal(transportEnvelope?.attrs.to, peer)
    assert.equal(muteEnvelope?.attrs.to, peer)
})

test('outgoing accept does not terminate the answering device when relay uses bare device zero', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    session.info.relayData = {
        endpoints: [],
        participantJids: ['2222222222@lid', '2222222222:28@lid'],
        peerParticipantJid: '2222222222@lid',
        uuid: ''
    }

    sent.length = 0
    await manager.handleCallAccept(buildAcceptNode(callId, '2222222222:0@lid'), '2222222222:0@lid')

    const actionTags = sent.flatMap((node) =>
        Array.isArray(node.content)
            ? node.content
                  .filter(
                      (child): child is BinaryNode =>
                          typeof child === 'object' && child !== null && 'tag' in child
                  )
                  .map((child) => child.tag)
            : []
    )
    assert.equal(actionTags.includes('terminate'), false)
})

test('incoming mirrored leg stops when the same local account accepts the outbound call', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'LOCAL-ZAPO-MIRRORED-CALL'
    const caller = '2222222222:0@lid'
    let ended = 0
    manager.on('call_ended', () => {
        ended++
    })

    await manager.handleCallOffer(buildOfferNode(callId, caller), caller)
    sent.length = 0

    const localDevice = '1111111111:15@lid'
    await manager.handleCallAccept(
        buildAcceptNode(callId, localDevice),
        localDevice
    )
    await manager.handleCallAccept(
        buildAcceptNode(callId, localDevice),
        localDevice
    )

    assert.equal(manager.getCall(callId)?.stateData.state, CallState.Ended)
    assert.equal(ended, 1)
    assert.equal(sent.length, 0)
})

test('local mirrored target ends without cleaning the matching outbound source call', async () => {
    const sourceMocks = createMockDeps()
    const targetMocks = createMockDeps()
    targetMocks.deps.authClient.getCurrentCredentials = () => ({
        meJid: '5511998888888@s.whatsapp.net',
        meLid: '2222222222@lid',
        signedIdentity: undefined
    }) as any

    const sourceManager = new WaCallManager({
        deps: sourceMocks.deps,
        stores: sourceMocks.stores
    })
    const targetManager = new WaCallManager({
        deps: targetMocks.deps,
        stores: targetMocks.stores
    })
    const callId = await sourceManager.startCall({ peerJid: '2222222222@lid' })
    const caller = '1111111111:0@lid'
    await targetManager.handleCallOffer(buildOfferNode(callId, caller), caller)

    const sourceSession = (sourceManager as any).calls.get(callId)
    const targetSession = (targetManager as any).calls.get(callId)
    let sourceCleanups = 0
    let targetCleanups = 0
    const originalSourceCleanup = sourceSession.cleanup.bind(sourceSession)
    const originalTargetCleanup = targetSession.cleanup.bind(targetSession)
    sourceSession.cleanup = () => {
        sourceCleanups++
        originalSourceCleanup()
    }
    targetSession.cleanup = () => {
        targetCleanups++
        originalTargetCleanup()
    }

    let sourceEnded = 0
    let targetEnded = 0
    sourceManager.on('call_ended', () => sourceEnded++)
    targetManager.on('call_ended', () => targetEnded++)
    sourceMocks.sent.length = 0
    targetMocks.sent.length = 0

    const acceptingPnDevice = '5511998888888:15@s.whatsapp.net'
    const accept = buildAcceptNode(callId, acceptingPnDevice)
    await sourceManager.handleCallAccept(accept, acceptingPnDevice)
    await targetManager.handleCallAccept(accept, acceptingPnDevice)
    await targetManager.handleCallAccept(accept, acceptingPnDevice)

    assert.notEqual(sourceManager.getCall(callId)?.stateData.state, CallState.Ended)
    assert.equal(targetManager.getCall(callId)?.stateData.state, CallState.Ended)
    assert.equal(sourceCleanups, 0)
    assert.equal(targetCleanups, 1)
    assert.equal(sourceEnded, 0)
    assert.equal(targetEnded, 1)
    const sourceActionTags = sourceMocks.sent.flatMap((node) =>
        Array.isArray(node.content)
            ? node.content.map((child) => child.tag)
            : []
    )
    assert.equal(sourceActionTags.includes('terminate'), false)
    assert.equal(targetMocks.sent.length, 0)
})

test('offer ACK is routed by relay call-id after the call is already active', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const peer = '2222222222:0@lid'
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })

    await manager.handleCallAccept(buildAcceptNode(callId, peer), peer)
    assert.equal(manager.getCall(callId)?.stateData.state, CallState.Connecting)

    await manager.handleCallAck({
        tag: 'ack',
        attrs: { class: 'call', type: 'offer' },
        content: [{ tag: 'relay', attrs: { 'call-id': callId }, content: [] }]
    })

    assert.ok(manager.getCall(callId))
})

test('outgoing offer ACK sends caller-side preaccept exactly once', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })

    const session = (manager as any).calls.get(callId)
    const initialCodec = session.opusCodec
    session.connectRelays = async () => undefined

    sent.length = 0
    const ack = buildRelayOfferAck(callId)
    await manager.handleCallAck(ack)
    await manager.handleCallAck(ack)

    const preaccepts = sent.filter(
        (node) => (node.content as BinaryNode[])?.[0]?.tag === 'preaccept'
    )
    assert.equal(preaccepts.length, 1)
    const preaccept = (preaccepts[0].content as BinaryNode[])[0]
    const audio = (preaccept.content as BinaryNode[]).find(
        (node) => node.tag === 'audio'
    )
    assert.equal(session.opusCodec, initialCodec)
    assert.equal(session.opusCodec.getMode(), 'mlow')
    assert.equal(audio?.attrs.rate, '16000')
    const capability = (preaccept.content as BinaryNode[]).find(
        (node) => node.tag === 'capability'
    )
    assert.deepEqual(
        capability?.content,
        new Uint8Array([0x01, 0x05, 0xff, 0x09, 0xe4, 0xbb, 0x07])
    )
})

test('outgoing offer ACK switches to RFC Opus and advertises 8000 from voip_settings', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    session.connectRelays = async () => undefined

    const initialCodec = session.opusCodec
    assert.equal(initialCodec.getMode(), 'mlow')
    sent.length = 0
    await manager.handleCallAck(
        withVoipSettings(buildRelayOfferAck(callId), false)
    )

    assert.equal(session.opusCodec.getMode(), 'opus')
    assert.equal(session.opusCodec.usesSmpl(), false)
    assert.notEqual(session.opusCodec, initialCodec)
    const preacceptEnvelope = sent.find(
        (node) => (node.content as BinaryNode[])?.[0]?.tag === 'preaccept'
    )
    assert.ok(preacceptEnvelope)
    const preaccept = (preacceptEnvelope.content as BinaryNode[])[0]
    const audio = (preaccept.content as BinaryNode[]).find(
        (node) => node.tag === 'audio'
    )
    assert.equal(audio?.attrs.rate, '8000')
})

test('outgoing offer ACK preserves the local media identity initialized from the session LID', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const session = (manager as any).calls.get(callId)
    const initialSelfSsrc = session.selfSsrc
    const initialSelfStreamSsrcs = [...session.selfStreamSsrcs]

    session.connectRelays = async () => undefined

    await session.handleCallAck(buildRelayOfferAck(callId))

    const ackSelfJid = formatE2ESrtpParticipantId('1111111111:59@lid')
    const ackSelfSsrc = generateSecureSsrc(callId, ackSelfJid)
    const ackSelfStreams = prepareWasmRelayStreamSsrcs(
        generateWasmRelayStreamSsrcs(callId, ackSelfJid),
        generateSecureSsrc(callId, ackSelfJid, 6)
    )

    assert.equal(session.selfMediaJid, formatE2ESrtpParticipantId('1111111111@lid'))
    assert.equal(session.selfSsrc, initialSelfSsrc)
    assert.deepEqual(session.selfStreamSsrcs, initialSelfStreamSsrcs)
    assert.notEqual(session.selfSsrc, ackSelfSsrc)
    assert.notDeepEqual(session.selfStreamSsrcs, ackSelfStreams)
})

test('remote reject ends and removes the outgoing call', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    let ended: CallInfo | undefined
    manager.on('call_ended', (call) => { ended = call })

    await manager.handleCallReject(buildRejectNode(callId))

    assert.equal(manager.getCall(callId), null)
    assert.equal(ended?.stateData.state, CallState.Ended)
    assert.equal(ended?.stateData.endReason, 'declined')
})

test('hosted-device reject does not end an incoming ringing call', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-HOSTED-REJECT-IGNORED'
    const peer = '2222222222:0@lid'
    let ended: CallInfo | undefined
    manager.on('call_ended', (call) => { ended = call })

    await manager.handleCallOffer(buildOfferNode(callId, peer), peer)
    await manager.handleCallReject(
        buildRejectNode(callId, '182222711709908:99@hosted.lid')
    )

    const call = manager.getCall(callId)
    assert.ok(call)
    assert.equal(call.stateData.state, CallState.IncomingRinging)
    assert.equal(call.canAccept, true)
    assert.equal(ended, undefined)
})

test('server offer ACK error ends and removes the routed call', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    let ended: CallInfo | undefined
    manager.on('call_ended', (call) => { ended = call })

    await manager.handleCallAck({
        tag: 'ack',
        attrs: { class: 'call', type: 'offer', error: '439' },
        content: [{ tag: 'error', attrs: { 'call-id': callId }, content: undefined }]
    })

    assert.equal(manager.getCall(callId), null)
    assert.equal(ended?.stateData.state, CallState.Ended)
    assert.equal(ended?.stateData.endReason, 'failed')
})

test('incoming offer at capacity is tracked with canAccept false', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    await manager.startCall({ peerJid: '2222222222@lid' })
    const before = sent.length

    const incomingCallId = 'INCOMINGCALL0000000000000001'
    await manager.handleCallOffer(buildOfferNode(incomingCallId), '2222222222:0@lid')

    assert.equal(manager.getCalls().length, 2)
    const incoming = manager.getCall(incomingCallId)
    assert.ok(incoming)
    assert.equal(incoming.canAccept, false)
    assert.equal(incoming.isAcceptBlocked, true)

    const rejectNode = sent.slice(before).find((node) => {
        const inner = Array.isArray(node.content) ? node.content[0] : null
        return inner && typeof inner === 'object' && 'tag' in inner && inner.tag === 'reject'
    })
    assert.equal(rejectNode, undefined)

    const preacceptNode = sent.slice(before).find((node) => {
        const inner = Array.isArray(node.content) ? node.content[0] : null
        return inner && typeof inner === 'object' && 'tag' in inner && inner.tag === 'preaccept'
    })
    assert.equal(preacceptNode, undefined)

    await assert.rejects(() => manager.acceptCall(incomingCallId), /cannot be accepted/)
})

test('waiting incoming call unblocks when a slot frees', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    const activeCallId = await manager.startCall({ peerJid: '2222222222@lid' })
    const incomingCallId = 'INCOMINGCALL0000000000000003'

    await manager.handleCallOffer(buildOfferNode(incomingCallId), '3333333333:0@lid')
    assert.equal(manager.getCall(incomingCallId)!.canAccept, false)

    const beforeEnd = sent.length
    await manager.endCall(activeCallId)

    const incoming = manager.getCall(incomingCallId)
    assert.ok(incoming)
    assert.equal(incoming.canAccept, true)
    assert.equal(incoming.isAcceptBlocked, false)

    const preacceptNode = sent.slice(beforeEnd).find((node) => {
        const inner = Array.isArray(node.content) ? node.content[0] : null
        return inner && typeof inner === 'object' && 'tag' in inner && inner.tag === 'preaccept'
    })
    assert.ok(preacceptNode, 'expected preaccept after slot freed')
})

test('incoming offer with capacity creates a second session', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 2 })

    await manager.startCall({ peerJid: '2222222222@lid' })

    await manager.handleCallOffer(
        buildOfferNode('INCOMINGCALL0000000000000002'),
        '3333333333:0@lid'
    )

    assert.equal(manager.getCalls().length, 2)
})

test('incoming answer opens media without proactive signaling and defers accept until caller mute_v2', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMINGCALL0000000000000004'
    const peer = '2222222222:0@lid'

    const offerNode = buildOfferNode(callId, peer)
    const relay = (buildRelayOfferAck(callId).content as BinaryNode[])[0]
    ;((offerNode.content as BinaryNode[])[0].content as BinaryNode[]).push(relay)
    await manager.handleCallOffer(offerNode, peer)
    manager.getCall(callId)!.encryptionKey = new Uint8Array(32).fill(9)
    const session = (manager as any).calls.get(callId)
    let relayPrepares = 0
    let answerTagsBeforeRelay: string[] = []
    session.prepareIncomingRelay = async () => {
        relayPrepares++
        answerTagsBeforeRelay = sent.slice(beforeAnswer).map(
            (node: BinaryNode) => (node.content as BinaryNode[])?.[0]?.tag
        )
    }
    const beforeAnswer = sent.length
    await manager.acceptCall(callId)

    assert.equal(relayPrepares, 1)
    assert.deepEqual(answerTagsBeforeRelay, [])
    assert.deepEqual(sent.slice(beforeAnswer), [])

    await manager.handleCallMuteV2(buildMuteNode(callId, peer), peer)
    const answerNodes = sent.slice(beforeAnswer)
    assert.equal(answerNodes.length, 1)
    assert.deepEqual(
        answerNodes.map((node) => (node.content as BinaryNode[])?.[0]?.tag),
        ['accept']
    )
    assert.equal(answerNodes[0]?.attrs.to, peer)
    const accept = (answerNodes[0]?.content as BinaryNode[])[0]
    const acceptChildren = accept.content as BinaryNode[]
    assert.equal(accept.tag, 'accept')
    assert.deepEqual(
        acceptChildren.map((node) => node.tag),
        ['audio', 'net', 'encopt', 'metadata']
    )
    assert.equal(acceptChildren[1]?.attrs.medium, '2')

    await manager.handleCallMuteV2(buildMuteNode(callId, peer), peer)
    assert.equal(sent.slice(beforeAnswer).length, 1)
})

test('mute_v2 before local answer preserves its exact device and call creator for accept', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMING-MUTE-BEFORE-ANSWER'
    const offerPeer = '2222222222:0@lid'
    const mutePeer = '2222222222:28@lid'
    const muteCreator = '2222222222@lid'

    await manager.handleCallOffer(buildOfferNode(callId, offerPeer), offerPeer)
    manager.getCall(callId)!.encryptionKey = new Uint8Array(32).fill(9)
    sent.length = 0

    const muteNode = buildMuteNode(callId, mutePeer)
    ;((muteNode.content as BinaryNode[])[0].attrs as Record<string, string>)[
        'call-creator'
    ] = muteCreator
    await manager.handleCallMuteV2(muteNode, mutePeer)
    assert.equal(sent.length, 0)

    await manager.acceptCall(callId)
    assert.equal(sent.length, 1)
    assert.deepEqual(
        sent.map((node) => (node.content as BinaryNode[])?.[0]?.tag),
        ['accept']
    )
    assert.equal(sent[0]?.attrs.to, mutePeer)
    const accept = (sent[0]?.content as BinaryNode[])[0]
    assert.equal(accept.attrs['call-creator'], muteCreator)
})

test('incoming relaylatency responds to every probe without destination nodes', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores })
    const callId = 'INCOMINGCALL0000000000000005'
    const peer = '2222222222:28@lid'

    await manager.handleCallOffer(buildOfferNode(callId, peer), peer)
    const session = (manager as any).calls.get(callId)
    session.info.relayData = {
        endpoints: [
            {
                ip: '1.2.3.4',
                port: 3478,
                addressFamily: 4,
                token: 'token-1',
                rawToken: new Uint8Array([1]),
                key: 'key-1',
                relayId: 0,
                relayName: 'gru2c01'
            },
            {
                ip: '5.6.7.8',
                port: 3478,
                addressFamily: 4,
                token: 'token-2',
                rawToken: new Uint8Array([2]),
                key: 'key-2',
                relayId: 1,
                relayName: 'gru2c02'
            }
        ],
        participantJids: ['1111111111:59@lid', peer],
        uuid: ''
    }
    sent.length = 0
    await manager.handleCallRelaylatency(
        {
            tag: 'call',
            attrs: { from: peer, id: 'RELAYLATENCYMSGID' },
            content: [
                {
                    tag: 'relaylatency',
                    attrs: { 'call-id': callId, 'call-creator': peer },
                    content: [
                        { tag: 'te', attrs: { latency: String(0x02000000 + 18), relay_name: 'gru2c01' }, content: new Uint8Array([1, 2, 3, 4, 0x0d, 0x96]) },
                        { tag: 'te', attrs: { latency: String(0x02000000 + 27), relay_name: 'gru2c02' }, content: new Uint8Array([5, 6, 7, 8, 0x0d, 0x96]) }
                    ]
                }
            ]
        },
        peer
    )

    assert.equal(sent.length, 2)
    assert.deepEqual(sent.map((node) => node.attrs.to), [peer, peer])
    const actions = sent.map((node) => (node.content as BinaryNode[])[0])
    assert.deepEqual(
        actions.map((action) => (action.content as BinaryNode[])[0]?.attrs.relay_name),
        ['gru2c01', 'gru2c02']
    )
    assert.equal(
        actions.some((action) =>
            (action.content as BinaryNode[]).some((child) => child.tag === 'destination')
        ),
        false
    )
})

test('handleCallTerminate only ends the matching call', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 2 })

    const callIdA = await manager.startCall({ peerJid: '2222222222@lid' })
    const callIdB = await manager.startCall({ peerJid: '3333333333@lid' })

    await manager.handleCallTerminate(buildTerminateNode(callIdA))

    assert.equal(manager.getCall(callIdA), null)
    assert.ok(manager.getCall(callIdB))
    assert.equal(manager.getCall(callIdB)!.stateData.state, CallState.Ringing)
})

test('call_inbound_audio event includes CallInfo', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const call = manager.getCall(callId)
    assert.ok(call)

    let receivedCall: CallInfo | null = null
    manager.on('call_inbound_audio', (info) => {
        receivedCall = info
    })

    manager.emit('call_inbound_audio', call, new Float32Array(960))
    assert.equal(receivedCall, call)
})
