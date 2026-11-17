import { randomBytes } from 'node:crypto'

// Exercise the actual compiled plugin shipped in Docker, with artificial keys.
const { WaCallMediaSession } = require('../../vendor/zapo-voip/dist/call/WaCallMediaSession.js')
const { SrtpContext } = require('../../vendor/zapo-voip/dist/crypto/srtp.js')
const { derivePerJidSrtpKey } = require('../../vendor/zapo-voip/dist/crypto/encryption.js')
const { RtpHeader, RtpPacket } = require('../../vendor/zapo-voip/dist/media/rtp.js')
const { SRTP_RECV_AUTH_TAG_LEN } = require('../../vendor/zapo-voip/dist/types.js')

function fixture(relayPeer: string | undefined, acceptedPeer: string | null, callPeer = '222@lid', direction = 'outgoing') {
  const key = randomBytes(32), logs: any[] = []
  const session: any = {
    deps: { authClient: { getCurrentCredentials: () => ({ meLid: '111:24@lid' }) } },
    info: { callId: 'synthetic', direction, peerJid: callPeer, encryptionKey: key, relayData: { peerParticipantJid: relayPeer, participantJids: [] } },
    selfMediaJid: '111:24@lid', selfSsrc: 123, peerSsrcs: [456], acceptedByJid: acceptedPeer,
    logger: { debug: (msg, data) => logs.push({ msg, data }), error: jest.fn(), trace: jest.fn() }, startSrtcpReports: jest.fn(),
  }
  const init = (receiveKey?: Uint8Array) => WaCallMediaSession.prototype.initSrtpKeys.call(session, receiveKey)
  const identity = () => logs.filter(e => e.msg === 'voip_diag srtp_key_identity').at(-1)?.data
  return { session, key, init, identity }
}

function packets(f: ReturnType<typeof fixture>, senderJid: string, callKey = f.key, count = 50) {
  const sender = new SrtpContext(derivePerJidSrtpKey(callKey, senderJid), SRTP_RECV_AUTH_TAG_LEN)
  const payload = Buffer.from([10, 20, 30, 40, 50])
  return Array.from({ length: count }, (_, n) => ({
    encrypted: sender.protect(new RtpPacket(new RtpHeader(120, n + 1, n * 960, 456), payload)), payload,
  }))
}

describe('SRTP keys follow the signaled peer device, not a stale relay account', () => {
  test.each([
    ['base relay / linked device', '222@lid', '222:42@lid', '222@lid', 'outgoing', '222:42@lid'],
    ['primary relay / linked device', '222:0@lid', '222:42@lid', '222@lid', 'outgoing', '222:42@lid'],
    ['stale linked relay', '222:8@lid', '222:42@lid', '222@lid', 'outgoing', '222:42@lid'],
    ['primary handset', '222@lid', '222:0@lid', '222@lid', 'outgoing', '222:0@lid'],
    ['matching linked relay', '222:42@lid', '222:42@lid', '222@lid', 'outgoing', '222:42@lid'],
    ['no relay peer', undefined, '222:42@lid', '222@lid', 'outgoing', '222:42@lid'],
    ['incoming linked offer before mute/accept', '222@lid', null, '222:42@lid', 'incoming', '222:42@lid'],
    ['incoming linked offer / generic mute', '222@lid', '222@lid', '222:42@lid', 'incoming', '222:42@lid'],
    ['generic accept preserves specific relay', '222:42@lid', '222@lid', '222@lid', 'incoming', '222:42@lid'],
    ['unrelated contact remains independent', '333@lid', '333:17@lid', '333@lid', 'outgoing', '333:17@lid'],
    ['PN same-account linked device', '222@s.whatsapp.net', '222:42@s.whatsapp.net', '222@s.whatsapp.net', 'outgoing', '222:42@s.whatsapp.net'],
  ])('%s authenticates all packets and keeps the sending identity', (_name, relay, accepted, peer, direction, senderJid) => {
    const f = fixture(relay, accepted, peer, direction); f.init()
    expect(f.identity().recvJids[0]).toBe(senderJid)
    expect(f.identity().sendJid).toBe('111:24@lid')
    for (const { encrypted, payload } of packets(f, senderJid)) {
      expect(Buffer.from(f.session.srtpSession.unprotect(encrypted).payload)).toEqual(payload)
    }
  })

  test('a late linked-device accept repairs reception after primary-device key attempts', () => {
    const f = fixture('222@lid', null); f.init()
    const wire = packets(f, '222:42@lid')
    expect(() => f.session.srtpSession.unprotect(wire[0].encrypted)).toThrow('SRTP auth tag verification failed')
    f.session.acceptedByJid = '222:42@lid'; f.init()
    for (const { encrypted, payload } of wire) expect(Buffer.from(f.session.srtpSession.unprotect(encrypted).payload)).toEqual(payload)
    expect(f.identity().recvJids[0]).toBe('222:42@lid')
  })

  test('the real accept handler reinitializes SRTP for the answering device after early RTP fails', async () => {
    const f = fixture('222@lid', null); f.init()
    const wire = packets(f, '222:42@lid')
    expect(() => f.session.srtpSession.unprotect(wire[0].encrypted)).toThrow('SRTP auth tag verification failed')
    Object.assign(f.session, {
      actualPeerSsrc: 456, initSrtpKeys: f.init,
      sctpRelay: { setSubscriptionSsrcs: jest.fn(), setParticipantPids: jest.fn(), resendSubscriptions: jest.fn(), hasConnection: () => false },
      delegate: { emitState: jest.fn() }, connectRelays: jest.fn(async () => undefined),
      sendOutgoingPostAcceptSignaling: jest.fn(async () => undefined), armRemoteMediaWatchdog: jest.fn(),
    })
    f.session.info.applyTransition = jest.fn()
    await WaCallMediaSession.prototype.handleCallAccept.call(f.session, {
      tag: 'call', attrs: { from: '222:42@lid', id: 'synthetic-accept' },
      content: [{ tag: 'accept', attrs: { 'call-id': 'synthetic', 'call-creator': '111@lid' } }],
    }, '222:42@lid')
    expect(f.session.acceptedByJid).toBe('222:42@lid')
    expect(f.identity().recvJids[0]).toBe('222:42@lid')
    for (const { encrypted, payload } of wire) expect(Buffer.from(f.session.srtpSession.unprotect(encrypted).payload)).toEqual(payload)
  })

  test('the participant-list fallback remains unchanged when no device has been confirmed', () => {
    const f = fixture(undefined, null)
    f.session.info.relayData.participantJids = ['111:24@lid', '222:17@lid']
    f.init()
    expect(f.identity().recvJids[0]).toBe('222:17@lid')
    expect(f.session.srtpSession.unprotect(packets(f, '222:17@lid')[0].encrypted)).toBeDefined()
  })

  test.each([
    ['another account', '999:42@lid'],
    ['our own account', '111:24@lid'],
    ['unproven PN/LID alias', '222:42@s.whatsapp.net'],
  ])('does not use %s as a receive identity', (_name, accepted) => {
    const f = fixture('222@lid', accepted); f.init()
    expect(f.identity().recvJids).toEqual(['222:0@lid', '222@lid'])
    expect(() => f.session.srtpSession.unprotect(packets(f, accepted)[0].encrypted)).toThrow('SRTP auth tag verification failed')
    expect(Buffer.from(f.session.srtpSession.unprotect(packets(f, '222:0@lid')[0].encrypted).payload)).toEqual(Buffer.from([10, 20, 30, 40, 50]))
  })

  test('preserves legacy base-JID variants and rejects unknown linked devices', () => {
    const f = fixture('222@lid', '222:42@lid'); f.init()
    expect(f.identity().recvJids).toEqual(['222:42@lid', '222:0@lid', '222@lid'])
    for (const sender of ['222:0@lid', '222@lid']) {
      f.init()
      expect(f.session.srtpSession.unprotect(packets(f, sender)[0].encrypted)).toBeDefined()
    }
    f.init()
    expect(() => f.session.srtpSession.unprotect(packets(f, '222:99@lid')[0].encrypted)).toThrow('SRTP auth tag verification failed')
  })

  test('keeps authentication, tamper detection and replay rejection active', () => {
    const f = fixture('222@lid', '222:42@lid'); f.init()
    const wire = packets(f, '222:42@lid'), tampered = Uint8Array.from(wire[0].encrypted)
    tampered[tampered.length - 1] ^= 1
    expect(() => f.session.srtpSession.unprotect(tampered)).toThrow('SRTP auth tag verification failed')
    expect(f.session.srtpSession.unprotect(wire[0].encrypted)).toBeDefined()
    expect(() => f.session.srtpSession.unprotect(wire[0].encrypted)).toThrow('SRTP replay detected')
  })

  test('preserves a distinct received call key without changing the local sending key', () => {
    const f = fixture('222@lid', '222:42@lid'), receivedKey = randomBytes(32); f.init(receivedKey)
    expect(f.identity().peerCallKey).toBe(true)
    expect(f.session.srtpSession.unprotect(packets(f, '222:42@lid', receivedKey)[0].encrypted)).toBeDefined()
    const localPacket = new RtpPacket(new RtpHeader(120, 1, 0, 123), Buffer.from([1, 2, 3]))
    const localReceiver = new SrtpContext(derivePerJidSrtpKey(f.key, '111:24@lid'), SRTP_RECV_AUTH_TAG_LEN)
    expect(Buffer.from(localReceiver.unprotect(f.session.srtpSession.protect(localPacket)).payload)).toEqual(Buffer.from([1, 2, 3]))
  })
})
