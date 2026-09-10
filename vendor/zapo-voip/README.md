# @vipertec/zapo-voip

WhatsApp **VOIP / calling** plugin for [`zapo-js`](https://github.com/vinikjkkj/zapo).

Registers on `WaClient` via the plugin system and exposes everything at **`client.voip`**: MLow voice codec (WhatsApp's Opus variant through [`libmlow-wasm`](https://www.npmjs.com/package/libmlow-wasm)), RTP/SRTP, STUN, native DTLS/SCTP relay transport, and `<call>` signaling (offer / accept / preaccept / transport / relaylatency / mute / terminate).

Incoming `<call>`, call-class `<ack>`, and call `<receipt>` stanzas are handled automatically (prepend handlers return `true` so the core client does not double-ack).

The ViperConnect runtime is explicitly hybrid. The offer and outbound control
flow remain integrated with Zapo, while the direct relay transport and the
inbound 1:1 accept flow follow MeowCaller-derived behavior. An incoming answer
only commits the local state and opens the selected relay; it does not send
`mute_v2` or `transport` proactively. The caller's first `mute_v2` then triggers
`buildDirectAcceptStanza` with the negotiated audio rate, `net medium="2"`,
`encopt`, and metadata, followed by a call-class ACK that preserves
`type="mute_v2"`. That active accept does not carry a second Signal-encrypted
`callKey`.

For outbound calls, the offer ACK selects codec/relay state and triggers the
caller preaccept. A received preaccept sends relay latency plus the initial 0/0
transport; a received accept sends transport 1/1 and `mute_v2(0)` to the exact
device that answered. This is not described as a pure Zapo or pure MeowCaller
state machine.

> Calls flow over WhatsApp relay servers using MLow or RFC Opus, selected per call. This package handles **audio** calls with **pre-recorded** files or **live** 16 kHz mono PCM. Video is offered in signaling but not encoded.

## Integracao no ViperConnect

```json
{
  "dependencies": {
    "@vipertec/zapo-voip": "file:vendor/zapo-voip",
    "libmlow-wasm": "0.1.1",
    "zapo-js": "1.8.1"
  }
}
```

O pacote e privado e vendorizado; ele nao e baixado do npm. O Docker compila o
helper em `native/relay-bridge` e copia o binario para a mesma imagem.

Peer dependencies:

| Package        | Required       | Purpose                                         |
| -------------- | -------------- | ----------------------------------------------- |
| `zapo-js`      | yes            | `WaClient` and plugin host                      |
| `libmlow-wasm` | yes            | MLow/RFC Opus encode/decode (WASM, no native build step) |
| `ffmpeg` (CLI) | optional       | Decode pre-recorded audio files (`loadAudio`)   |

The relay helper is compiled from `native/relay-bridge` by the ViperConnect Docker build and does not require a WebRTC Node package. Relay offers carrying a 6-byte IPv4 endpoint or an 18-byte IPv6 endpoint are supported. The helper opens an explicit `udp4` or `udp6` socket for each numeric endpoint and rejects a mismatched family instead of relying on an implicit dual-stack bind.
If a WhatsApp relay rejects an IPv6 Allocate with `452 Xor Relayed Address
Mismatch`, only that IPv6 candidate is quarantined. Its keepalive and repeated
Allocate traffic stop immediately while parallel IPv4 candidates remain active.

For live signaling comparison, `voip_diag inbound_call_envelope` records only
the stanza tree, an explicit allowlist of routing attributes and content byte
lengths. Unknown attribute values, encrypted content, relay tokens and keys are
never serialized. `voip_diag inbound_accept_sent` includes the same redacted
shape for the direct accept. These diagnostics do not alter stanza ordering or
media behavior.

Relay negotiation can be correlated without exposing credentials:
`voip_diag outbound_relaylatency_response` records the outgoing stanza ID,
relay name, whether that relay was authenticated by the offer and its available
address families. `voip_diag inbound_call_ack_envelope` and
`voip_diag inbound_call_receipt_envelope` record only allowlisted routing
attributes and bounded node shape, allowing the response to be matched by ID.
For inbound calls, the outer `relaylatency` stanza is still acknowledged, but
the plugin only sends a latency response for relay names backed by a usable
offer endpoint (supported protocol, relay key and binary token). Probes for an
unknown relay are recorded as `voip_diag unauthenticated_relaylatency_skipped`
and are not advertised back to the peer.

Node **20.9+**. `libmlow-wasm` is ESM-only; the codec loads it via dynamic `import()`.

## Quick start

Importing from `@vipertec/zapo-voip` applies `WaClient` type extensions (`client.voip` and `voip_*` events):

```ts
import { WaClient } from 'zapo-js'
import { voipPlugin, EndCallReason } from '@vipertec/zapo-voip'

const client = new WaClient({
    store,
    sessionId: 'main',
    plugins: [voipPlugin()]
})

await client.connect()

client.on('voip_call_incoming', async (call) => {
    await client.voip.acceptCall(call.callId)
})

client.on('voip_call_state', (call) => {
    console.log(call.callId, call.stateData.state)
})

client.on('voip_call_inbound_audio', ({ call, pcm }) => {
    // Float32Array @ 16 kHz mono from the peer for this call
})

client.on('voip_call_outbound_audio_finished', (call) => {
    // preloaded file finished sending on this call
})
```

## Multi-call (`maxConcurrentCalls`)

By default only **one** non-ended call is allowed at a time (`maxConcurrentCalls: 1`). Additional incoming offers are tracked with `canAccept: false` (no preaccept sent) until a slot frees; use `call.canReject` to decline manually.

Increase the limit explicitly to enable parallel calls (each with isolated relay/codec/audio):

```ts
plugins: [voipPlugin({ maxConcurrentCalls: 2 })]
```

Every audio/control API is scoped by `callId`. To mirror the same microphone into two active calls, call `feedLiveAudio(callId, chunk)` for each call.

## Outgoing call – pre-recorded audio

`loadAudio` shells out to the `ffmpeg` binary (must be on `PATH`) to decode the file to 16 kHz mono PCM before encoding.

```ts
const callId = await client.voip.startCall({
    peerJid: '5511999999999@s.whatsapp.net'
})

await client.voip.loadAudio(callId, './hello.mp3')

// optional: react when the file finishes playing out
client.on('voip_call_outbound_audio_finished', (call) => {
    console.log('outbound audio done', call.callId)
})

// ... later
await client.voip.endCall(callId, EndCallReason.UserEnded)
```

## Outgoing call – live audio

```ts
const callId = await client.voip.startCall({ peerJid: '5511999999999@s.whatsapp.net' })

client.voip.setExternalAudioMode(callId, true)

// feed 16 kHz mono Float32 chunks as they arrive;
// feedLiveAudio returns the buffered ms still queued to send
const bufferedMs = client.voip.feedLiveAudio(callId, pcmChunk)

// backpressure: pause your source above pauseMs, resume below resumeMs
const { pauseMs, resumeMs } = client.voip.getFeedWatermarksMs()
```

## Incoming calls

The plugin registers incoming handlers; you only need to react to events:

```ts
client.on('voip_call_incoming', (call) => {
    console.log('ringing from', call.peerJid, call.callId)
})

// accept / reject / end
await client.voip.acceptCall(callId)
await client.voip.rejectCall(callId)
await client.voip.endCall(callId)
```

`getCalls()` returns every tracked call. `getCall(callId)` returns one call or `null`.

## Events

Emitted on `WaClient`:

| Event                               | Payload                                 | When                                      |
| ----------------------------------- | --------------------------------------- | ----------------------------------------- |
| `voip_call_incoming`                | `CallInfo`                              | Remote offer received                     |
| `voip_call_state`                   | `CallInfo`                              | State transition                          |
| `voip_call_ended`                   | `CallInfo`                              | Call finished                             |
| `voip_call_inbound_audio`           | `{ call: CallInfo; pcm: Float32Array }` | Decoded peer audio received (16 kHz)      |
| `voip_call_outbound_audio_finished` | `CallInfo`                              | Preloaded outbound audio finished sending |
| `voip_call_error`                   | `Error`                                 | Engine error                              |

You can also use `client.voip.on('call_state', ...)` etc. for the manager-level events (`CallManagerEvents`).

## `client.voip` API

| Method                                                       | Description                                               |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `startCall({ peerJid, isVideo?, audioFile?, peerDevices? })` | Place an outgoing call; returns `callId`                  |
| `acceptCall(callId)`                                         | Accept an incoming call                                   |
| `rejectCall(callId, reason?)`                                | Reject                                                    |
| `endCall(callId, reason?)`                                   | Hang up                                                   |
| `loadAudio(callId, path)`                                    | Load a file for outbound audio on that call               |
| `setExternalAudioMode(callId, enabled)`                      | Switch to live PCM input for that call                    |
| `feedLiveAudio(callId, Float32Array)`                        | Push a capture chunk (external mode); returns buffered ms |
| `getLiveBufferMs(callId)`                                    | Buffered live-audio ms not yet sent                       |
| `getFeedWatermarksMs()`                                      | `{ pauseMs, resumeMs }` backpressure thresholds           |
| `setMute(callId, muted)`                                     | Mute/unmute local capture for that call                   |
| `getCall(callId)`                                            | One call or `null`                                        |
| `getCalls()`                                                 | All tracked calls                                         |
| `on` / `off` / `once`                                        | Manager-level events                                      |

Plugin options: `maxConcurrentCalls?: number` (default `1`), `logLevel?: LogLevel` (caps VOIP diagnostics; defaults to the host client's level).

## Codec

The codec is selected independently for each call from `voip_settings`:

- literal `encode.use_mlow_codec_v1="false"` selects RFC Opus with
  `useSmpl: false` and advertises `audio rate="8000"`;
- absent settings, `"true"`, or malformed settings use the safe MLow fallback
  with `useSmpl: true` and advertise `audio rate="16000"`.

Inbound negotiation is read from the `offer`; outbound negotiation is read from
the offer ACK. Once `preaccept` has been sent, later settings are ignored so the
codec and advertised rate cannot change during the call. Both modes use
**`libmlow-wasm`** (>= 0.1.1), mono PCM and 960-sample frames (60 ms), with DTX
enabled. The local negotiation, initialization order and codec round trips are
covered by tests. MeowCaller currently provides an in-progress codec-selection
scaffold; this README does not claim its RFC Opus fallback is complete upstream.

The decoder can legitimately return a duration that is shorter or longer than
one 960-sample bridge frame. Inbound PCM is therefore accumulated per call and
emitted only as ordered 960-sample frames: long outputs are split, short outputs
are joined with the next decode, and an incomplete remainder is discarded on
call cleanup. Delivery failures are counted separately as `pcmDeliveryErrors`;
they do not inflate `srtpErrors` after authentication and decoding succeeded.

MeowCaller revision `6d9b7b2` observes settings at inbound offer, outbound ACK,
and outbound accept, with the last explicit valid value winning, but its media
loop still instantiates MLow and signals a fixed 16 kHz rate. ViperConnect
intentionally treats only offer/ACK as authoritative and ignores a late accept
setting after caller preaccept.

Relay candidates keep the original wire order of the received `te2` children,
including parallel IPv4 and IPv6 addresses; they are not sorted by RTT before
selection. The IPv6 relay address is also encoded in the Allocate STUN using
the magic cookie followed by the transaction ID interpreted as three
little-endian 32-bit words, as required by WhatsApp's custom WASM endpoint
attribute. IPv4 keeps its previous byte-for-byte encoding. For a call between two sessions in
the same worker, an inbound mirrored leg is stopped locally when the accepting
device matches either the session `meLid` or `meJid`. That guard only cleans the
mirrored local leg and does not send a WhatsApp `terminate`.

Inbound 1:1 preconnects the advertised candidates and fans out startup media
until authenticated remote SRTP confirms the working path. This allows an
IPv4-only SIP extension to keep its existing RTP leg while the independent
WhatsApp relay leg uses IPv6. The internal worker-to-VoIP WebSocket remains on
the current Docker network; this is media termination by the bridge, not packet
level NAT64. Outbound recovery remains sequential and opens only one candidate
at a time. On 2026-08-21, inbound relay media was validated live over IPv6 on
mobile data and over IPv4 on Wi-Fi, both with bidirectional audio and no
SRTP/Opus errors. That result is active as a worker hostpatch and remains an
image-release gate until it ships without `dist` mounts.

No `koffi` or bundled native codec libraries are required.

The signaling and media stack (RTP/SRTP, SCTP relay, codec, audio engine) is internal to the package; use `client.voip` and the events above.

The vendored suite currently has `210/210` passing tests. On 2026-08-05, eight
live calls (two inbound and two outbound on an iPhone 16, then the same matrix
on a Galaxy S9e) completed with bidirectional audio and no SRTP or Opus error.
All used the first relay candidate; forced live failover remains a separate
release criterion.

The exact frozen CommonJS runtime was revalidated in four additional live calls
before commit. Its SHA-256 values are `87d0011588c10451ef68301a22128264a327ac2e8aab8641a5834be35d6c61d8`
for `WaCallMediaSession.js`, `055269c99c8e999f7bcf86362aba45a0544a462fd713a9bc807c7159167aec28`
for `WaCallManager.js`, and `d99a6e28ab14975f15dc1fa682a45ceb868d9a5fc124fde81172c883d720f9cb`
for `signaling/bridge.js`.

## Credits

The VOIP plugin was built by:

- [@vinikjkkj](https://github.com/vinikjkkj)
- [@edgardmessias](https://github.com/edgardmessias) — Edgard Lorraine Messias
- [@w3nder](https://github.com/w3nder) — Wender Teixeira

## License

MIT
