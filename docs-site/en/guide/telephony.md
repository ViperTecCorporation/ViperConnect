# Zapo telephony

The unified image includes the VoIP service and the authenticated bridge used
by the Zapo session worker. The bridge remains internal; SIP, WebRTC and media
are exposed by the dedicated telephony process.

## Extension modes

- **Extension**: one traditional endpoint registration with the normal
  per-extension behavior.
- **Trunk**: multiple simultaneous calls are allowed up to the configured
  account and service limits.

The Manager exposes the mode next to the generated extension credentials so an
administrator does not need per-customer code exceptions.

## SIP proxy/SBC with a private RTP relay

By default, a public peer that advertises a private `c=IN IP4` address is
handled as NAT and the signaling source address remains authoritative. Some
SBCs and SIP proxies signal through a public IP while relaying media through a
private address that is routable from the VoIP host.

Allow only their public signaling IPs:

```ini
SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS=203.0.113.20,203.0.113.21
```

This is a peer allowlist, not the ViperConnect public address. It applies to
offers, answers and re-INVITEs. Leave it empty for direct extensions; do not use
wildcards, hostnames or broad networks. It does not create routes or firewall
rules, so forward the complete configured RTP range when NAT is present.

## Recording

Recording is controlled by the recording settings. When disabled, no new call
recording is created. Retention removes expired local or stored recordings
according to `retentionDays`; zero disables automatic removal.

The video worker is unrelated to call audio. It remains a separate process so
large WhatsApp video conversions do not delay normal message queues.

## Routing and concurrency

Configure companies, accounts, line groups, extension groups and extensions in
the Manager. `maxConcurrentCalls` accepts values from 2 to 32. The effective
capacity is still limited by the upstream line and available media resources.

### Manual outbound line selection

Each Zapo line can have an optional `outboundAccessPrefix`. The accepted format
is an asterisk, one to six digits, and another asterisk, for example `*81*`.
Prefixes must be unique within the same company.

Dial normally to keep the advanced routing order, or prepend the configured
prefix from WebRTC, MicroSIP, or another SIP endpoint:

```text
5566996269251       -> automatic selection
*81*5566996269251   -> request the line configured with *81*
```

SIP/UDP and WebRTC gateways preserve the prefix (including `%2A`) until router
validation. Prefixed dial targets are not handled as internal extension calls.
The service strips the prefix before sending the WhatsApp destination. The
prefix does not grant additional permission: the selected line must already be
available through the extension's advanced outbound routing and belong to the
same company. Unknown or unauthorized prefixes are rejected. An explicitly
selected offline or full line fails without silently falling back to another
line. Internal extension calls remain internal when no line prefix is used.

### Outbound country and area codes

Lines have editable `defaultDdi` (country code) and `defaultDdd` (area code).
A complete Brazilian line number such as `5566996269251` suggests `55` and `66`.
Saving empty fields disables their defaults and does not restore the suggestion.
Foreign and incomplete line numbers are not inferred.

Each nonempty extension field overrides the corresponding selected-line field;
empty extension fields inherit. Completion follows line selection and keeps
advanced-routing permissions and capacity checks; internal extension calls are unchanged.
With `55`/`66`, `996269251` becomes `5566996269251`. Local 8/9-digit targets
require both defaults; 10/11-digit targets receive only the country code.
Targets with 12 or more digits and explicit international `+` targets are preserved.
Length rules are Brazilian; other plans should use a complete `+` number.
Carrier prefixes are not removed. Country codes accept 1–3 digits, area codes
2–4 digits, without leading zero; existing line/extension edit permissions apply.

## Post-call AI providers

Under **Companies → Post-call AI**, choose transcription and summary providers
independently: Groq, OpenAI, OpenRouter or custom OpenAI-compatible. Known
providers fill their endpoint; custom URLs stay editable. Existing configurations
without an explicit provider continue using their saved URL.

OpenRouter model selectors load its current public catalog, filtering STT with
`output_modalities=transcription` and summaries by text input/output. Catalog
requests send no key or audio and do not verify account credit/model access.
On failure, the UI reports the error and preserves a saved model without silent
replacement. Other providers retain an editable model ID. Administrator access
is required for configuration and `GET /admin/voip/console/ai/models`.

The **Atualizar catálogo de modelos OpenRouter** button refreshes both lists
without clearing the selected model or a newly entered key. Saved retired
models remain visible and are never silently replaced. As in ViperChat Super
Admin, changed selections are validated server-side: STT requires audio input
and transcription output; summaries require text input/output. An incompatible
selection returns `422 invalid_openrouter_model`; catalog failure while changing
a model returns `502 ai_model_catalog_unavailable`. Both preserve the previous
configuration. Unchanged saved models do not require a catalog fetch when
editing unrelated company settings.
External catalog requests do not hold the voice configuration queue. Concurrent
AI edits return `409 ai_configuration_changed`, requiring the company editor
to be reopened rather than overwriting newer configuration.

Changing endpoint/provider clears an old secret unless a new key is supplied;
blank fields preserve secrets only for the same endpoint. A transcription key
can serve summaries only when both endpoints match. Secrets remain redacted.
OpenRouter receives MP3/WAV as base64 JSON on `/audio/transcriptions`, then text
on `/chat/completions`. The local conservative audio cap is 25 MiB; long calls
may exceed upstream processing limits. Automatic audio splitting is not implemented.
Errors use the existing retry queue, without switching providers. Review costs
and data policies: recordings/transcripts are sent to the selected provider.
This does not implement a realtime voice agent or IVR; those remain future work.

Sources: [OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt)
and [model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

## Transfer hold audio

Unified release: ViperConnect `4.0.37` includes VoIP `0.1.67`, pinned to
revision `9615a6f78582fb84a9f10647f98744cc41e1befe` in the image workflow.

**Fix integrated in 4.0.37 / VoIP 0.1.67:** when NAT path changes deliver REFER from
a different IP, matching dialog tags alone are insufficient. The server requests
Digest authentication (`401` / `WWW-Authenticate`) for the originating extension.
The client must resend authenticated REFER with the correct Request-URI/realm,
a valid nonce and a non-replayed nonce count before the dialog peer changes.
Disabled sources, another extension's password and invalid tags remain blocked.
Port-only changes on the same IP retain the existing behavior. Subnets and
client-declared Via/Contact do not grant trust. Clients without REFER Digest
support cannot transfer through this path. The fix is incorporated into the
source code. On 2026-10-13 the user validated the real 1001 → 1010 transfer on
the VPS with the temporary hotfix, in the reported IPv6-registered destination
scenario. Tag publication triggers the build, not VPS deployment. Remove the temporary host-path
override when upgrading so it does not shadow the new image's code.

The MP3/WAV uploaded to an extension group plays to the WhatsApp participant
while the transfer destination rings. The enabled source group with audio has
priority, then an enabled destination group in the same company. Configuration
order resolves multiple eligible groups. Source microphone capture is suspended
only during playback; other calls remain unaffected. Playback loops until answer,
all targets reject, the 30-second transfer timeout expires, or the call ends.
SIP CANCEL preserves the original INVITE Request-URI, including port and
parameters, so pending ringing can be cancelled when WhatsApp hangs up.

Uploads use the existing VoIP authorization and company scope. The worker needs
ffmpeg and access to the persisted file. Decode failures log a warning without
silencing the original call; at most 300 seconds of the file are decoded.
This does not add an IVR, realtime voice agent or attended transfer.
After upgrading, validate audible hold playback and hangup cancellation on
the actual phones; automated checks do not replace an end-to-end call test.

## Health validation

Confirm the HTTP health endpoint, the worker bridge, SIP registration, RTP in
both directions, WebSocket upgrade and storage access. Use the
[dual-stack guide](/en/guide/voip-ipv6) when IPv6 is enabled.

The WhatsApp media relay also supports parallel IPv4 and IPv6 endpoints with
explicit `udp4` and `udp6` sockets. Relay family is independent from the SIP/RTP
extension family, so an IPv6 relay can feed an IPv4 extension without NAT64.
Zapo owns the session, public Meow Caller contracts are used as wire references,
and ViperConnect adds the PCM bridge, codec policy, dual-stack handling,
recovery and safe telemetry.

## ViperChat call events

In Manager, an administrator opens **Telephony → Companies → Edit** and configures
**ViperChat call events** (current UI labels may be Portuguese). The company owns
the destination/token; only its linked extensions contribute events. Internal
extension calls do not need an arbitrary WhatsApp line. Tokens are write-only;
blank preserves the token and explicit removal requires disabling delivery.

Choose `artifactsDelivery: legacy` for existing recording/AI-note compatibility,
or `webhook` for the ViperChat private artifact processor. Webhook mode disables
effective legacy recording and AI-note sending, including queued jobs, without
deleting the old configuration. Never silently fall back to both delivery paths.

The [complete webhook contract](/en/guide/voip-webhooks) documents every company
option, field, event/state, recording/transcript/summary example, authentication,
RabbitMQ setting, retry/HTTP rule, deduplication and recovery/native limitation.
Webhook delivery neither registers a SIP endpoint nor changes the media path.

### Administrative diagnostics and replay

In **Companies → Edit → ViperChat delivery diagnostics**, administrators inspect
counts, state, attempts, next retry and technical errors. The UI does not expose
payloads, phone numbers, audio or credentials. It requests up to 50 recent
deliveries; **Refresh** fetches the current state again.

Replay is only offered for pending/dead events matching the original enabled
destination. An explicit confirmation explains the scope before submission.
The server checks company, event, state and destination again, preserving the
original payload, IDs and attempt count. Delivered events cannot be replayed and
the request cannot redirect data to another company. A UUID `requestId` makes
repeated submissions idempotent. Conflicts return 409 and require investigation,
never automatic scope expansion.
