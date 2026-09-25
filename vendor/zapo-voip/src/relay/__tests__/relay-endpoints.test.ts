import assert from 'node:assert/strict'
import test from 'node:test'

import {
    normalizeRelayEndpoints,
    orderMediaRelayCandidates,
    selectMediaRelayEndpoint
} from '../relay-endpoints.js'

const rawToken = new Uint8Array([1, 2, 3])
const rawAuthToken = new Uint8Array([4, 5, 6])

for (const incoming of [false, true]) {
    test(`web relay port opt-in preserves credentials and selection (incoming=${incoming})`, () => {
        const endpoint = {
            ip: '57.144.137.54', port: 3478, token: 'token', rawToken,
            authToken: 'auth', rawAuthToken, key: 'key', relayId: 0,
            tokenId: '1', authTokenId: '2', addressFamily: 4 as const
        }
        const endpoints = [endpoint, { ...endpoint, ip: '2001:db8::1', addressFamily: 6 as const, relayId: 1, isFna: true }]
        const original = orderMediaRelayCandidates(endpoints, incoming)
        const mobile = orderMediaRelayCandidates(endpoints, incoming, { preferWebRelayPort: true })
        assert.deepEqual(mobile, original.map(relay => ({ ...relay, port: 3480 })))
        assert.deepEqual(orderMediaRelayCandidates(endpoints, incoming, { preferWebRelayPort: false }), original)
        assert.equal(endpoint.port, 3478)
        assert.equal(mobile[0].rawToken, rawToken)
        assert.equal(mobile[0].rawAuthToken, rawAuthToken)
        assert.deepEqual(orderMediaRelayCandidates([{ ...endpoint, protocol: 1 }], incoming, { preferWebRelayPort: true }), [])
        assert.equal(orderMediaRelayCandidates([{ ...endpoint, port: 3480 }, endpoint], incoming, { preferWebRelayPort: true }).length, 1)
    })
}

test('adds the 3480 web-token relay variant for auth token zero', () => {
    const relays = normalizeRelayEndpoints([
        {
            ip: '57.144.233.57',
            port: 3478,
            token: 'token',
            authToken: 'auth-token',
            rawToken,
            rawAuthToken,
            key: 'key',
            relayId: 1,
            relayName: 'gru2c01',
            tokenId: '3',
            authTokenId: '0'
        }
    ])

    assert.deepEqual(
        relays.map((relay) => ({
            port: relay.port,
            authToken: relay.authToken,
            tokenId: relay.tokenId,
            authTokenId: relay.authTokenId
        })),
        [
            { port: 3478, authToken: 'auth-token', tokenId: '3', authTokenId: '0' },
            { port: 3480, authToken: undefined, tokenId: '3', authTokenId: '0-web-token' }
        ]
    )
})

test('keeps only the 3478 relay when no web-token fallback is required', () => {
    const relays = normalizeRelayEndpoints([
        {
            ip: '57.144.233.57',
            port: 3478,
            token: 'token',
            rawToken,
            key: 'key',
            relayId: 1,
            relayName: 'gru2c01',
            authTokenId: '4'
        }
    ])

    assert.equal(relays.length, 1)
    assert.equal(relays[0]?.port, 3478)
})

test('preserves the relay port advertised by the offer ACK', () => {
    const relays = normalizeRelayEndpoints([
        {
            ip: '57.144.233.57',
            port: 3499,
            token: 'token',
            rawToken,
            key: 'key',
            relayId: 1,
            relayName: 'gru2c01',
            authTokenId: '4'
        }
    ])

    assert.equal(relays.length, 1)
    assert.equal(relays[0]?.port, 3499)
})

test('does not duplicate the web-token fallback when ACK already advertises 3480', () => {
    const relays = normalizeRelayEndpoints([
        {
            ip: '57.144.233.57',
            port: 3480,
            token: 'token',
            rawToken,
            key: 'key',
            relayId: 1,
            relayName: 'fops-gru',
            authTokenId: '0'
        }
    ])

    assert.deepEqual(relays.map((relay) => relay.port), [3480])
})

test('can disable synthetic 3480 and keep only the endpoint advertised by the ACK', () => {
    const relays = normalizeRelayEndpoints(
        [
            {
                ip: '57.144.233.57',
                port: 3478,
                token: 'token',
                rawToken,
                key: 'key',
                relayId: 1,
                relayName: 'gru2c01',
                authTokenId: '0'
            }
        ],
        { includeWebTokenFallback: false }
    )

    assert.deepEqual(relays.map((relay) => relay.port), [3478])
})

test('prefers the caller FNA relay for incoming media', () => {
    const regular = {
        ip: '57.144.233.57',
        port: 3478,
        token: 'token',
        rawToken,
        key: 'key',
        relayId: 1,
        relayName: 'regular',
        authTokenId: '4',
        isFna: false
    }
    const fna = {
        ...regular,
        ip: '157.240.12.63',
        relayId: 2,
        relayName: 'fna',
        authTokenId: '0',
        isFna: true
    }

    assert.equal(selectMediaRelayEndpoint([regular, fna], true), fna)
    assert.equal(selectMediaRelayEndpoint([fna], true), fna)
})

test('selects the authenticated non-FNA relay for outgoing media', () => {
    const fallback = {
        ip: '57.144.233.57',
        port: 3478,
        token: 'token',
        rawToken,
        key: 'key',
        relayId: 1,
        relayName: 'fallback',
        authTokenId: '0',
        isFna: false
    }
    const authenticated = {
        ...fallback,
        ip: '157.240.12.63',
        relayId: 2,
        relayName: 'authenticated',
        authTokenId: '4'
    }

    assert.equal(selectMediaRelayEndpoint([fallback, authenticated], false), authenticated)
})

test('preserves the proven outbound relay-id-zero path when all auth token ids are zero', () => {
    const relays = [
        {
            ip: '157.240.226.133',
            port: 3478,
            token: 'token-1',
            rawToken,
            key: 'key-1',
            relayId: 1,
            relayName: 'gru1c02',
            tokenId: '2',
            authTokenId: '0',
            isFna: false
        },
        {
            ip: '57.144.137.57',
            port: 3478,
            token: 'token-2',
            rawToken,
            key: 'key-2',
            relayId: 0,
            relayName: 'bsb1c01',
            tokenId: '1',
            authTokenId: '0',
            isFna: false
        },
        {
            ip: '31.13.91.133',
            port: 3478,
            token: 'token-3',
            rawToken,
            key: 'key-3',
            relayId: 2,
            relayName: 'gig4c02',
            tokenId: '0',
            authTokenId: '0',
            isFna: false
        }
    ]

    assert.equal(selectMediaRelayEndpoint(relays, false), relays[1])
})

test('incoming keeps first non-FNA while outgoing preserves relay id zero', () => {
    const callerRelay = {
        ip: '57.144.137.57',
        port: 3478,
        token: 'token-0',
        rawToken,
        key: 'key-0',
        relayId: 0,
        relayName: 'bsb1c01',
        tokenId: '0',
        authTokenId: '0',
        isFna: false
    }
    const receiverRelay = {
        ...callerRelay,
        ip: '57.144.67.57',
        token: 'token-1',
        key: 'key-1',
        relayId: 1,
        relayName: 'gru1c01',
        tokenId: '1'
    }

    assert.equal(selectMediaRelayEndpoint([receiverRelay, callerRelay], true), receiverRelay)
    assert.equal(selectMediaRelayEndpoint([receiverRelay, callerRelay], false), callerRelay)
})

test('orders every advertised candidate after the normal first choice without changing ports', () => {
    const firstInOffer = {
        ip: '157.240.226.133',
        port: 3499,
        token: 'token-1',
        rawToken,
        key: 'key-1',
        relayId: 1,
        relayName: 'gru1c02',
        tokenId: '2',
        authTokenId: '0',
        isFna: false
    }
    const preferred = {
        ...firstInOffer,
        ip: '57.144.137.57',
        port: 3501,
        token: 'token-2',
        key: 'key-2',
        relayId: 0,
        relayName: 'bsb1c01',
        tokenId: '1'
    }
    const finalCandidate = {
        ...firstInOffer,
        ip: '31.13.91.133',
        port: 3503,
        token: 'token-3',
        key: 'key-3',
        relayId: 2,
        relayName: 'gig4c02',
        tokenId: '0'
    }

    const candidates = orderMediaRelayCandidates(
        [firstInOffer, preferred, finalCandidate],
        false
    )

    assert.deepEqual(
        candidates.map(({ relayId, ip, port }) => ({ relayId, ip, port })),
        [
            { relayId: 0, ip: '57.144.137.57', port: 3501 },
            { relayId: 1, ip: '157.240.226.133', port: 3499 },
            { relayId: 2, ip: '31.13.91.133', port: 3503 }
        ]
    )
})

test('keeps a later usable candidate when an earlier duplicate is incomplete', () => {
    const incomplete = {
        ip: '57.144.137.57',
        port: 3478,
        token: 'missing-binary-token',
        key: '',
        relayId: 0,
        relayName: 'bsb1c01',
        tokenId: '1',
        authTokenId: '0'
    }
    const usable = {
        ...incomplete,
        token: 'usable-token',
        rawToken,
        key: 'usable-key'
    }

    assert.deepEqual(
        normalizeRelayEndpoints([incomplete, usable], {
            includeWebTokenFallback: false
        }).map((relay) => relay.token),
        ['usable-token']
    )
})

test('keeps sequential credentials that share an address but have distinct relay ids', () => {
    const first = {
        ip: '57.144.137.57',
        port: 3478,
        token: 'token-1',
        rawToken,
        key: 'key-1',
        relayId: 0,
        relayName: 'bsb1c01',
        tokenId: '1',
        authTokenId: '0'
    }
    const second = {
        ...first,
        token: 'token-2',
        key: 'key-2',
        relayId: 1,
        tokenId: '2'
    }

    assert.deepEqual(
        orderMediaRelayCandidates([first, second], false).map(
            ({ relayId, tokenId }) => ({ relayId, tokenId })
        ),
        [
            { relayId: 0, tokenId: '1' },
            { relayId: 1, tokenId: '2' }
        ]
    )
})
