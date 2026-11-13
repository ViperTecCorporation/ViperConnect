# Dual-stack IPv4 and IPv6 VoIP

ViperConnect opens independent IPv4 and IPv6 UDP sockets. It does not depend
on an implicit dual-stack bind, so existing IPv4 behavior remains unchanged.

```ini
SIP_RTP_BIND_IPV4=0.0.0.0
SIP_RTP_BIND_IPV6=::
SIP_RTP_PUBLIC_IPV4=203.0.113.10
SIP_RTP_PUBLIC_IPV6_HOST=sip6.yourdomain.com
SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS=
```

IPv4 peers receive `IN IP4` SDP and the configured public IPv4 address. IPv6
peers receive bracketed SIP URIs and `IN IP6` SDP. IPv4 private-address NAT
rules are not applied to IPv6 peers.

`SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS` does not alter address-family selection. It
only allows listed public SIP proxy/SBC signaling IPs to keep a private,
routable IPv4 RTP relay in SDP. Existing NAT protection remains unchanged for
every unlisted peer. Leave it empty unless this topology is intentional.

## WhatsApp media relay

Telephony dual-stack and WhatsApp relay dual-stack are independent layers. The
Zapo worker preserves the IPv4 and IPv6 `te2` endpoints from the offer and
opens an explicit socket for each candidate family (`udp4` or `udp6`). The
native helper terminates UDP, DTLS, SCTP and the DataChannel; only PCM then
crosses the internal bridge.

An IPv6 WhatsApp relay can therefore feed an IPv4 SIP extension without packet
level NAT64. A `452 Xor Relayed Address Mismatch` response quarantines only the
incompatible IPv6 candidate and keeps parallel IPv4 candidates available.

On 2026-08-21, an inbound mobile-data call received remote RTP through the
authenticated IPv6 endpoint of `bsb1c01`. A Wi-Fi regression call received RTP
through the IPv4 endpoint of `gru2c01`. Both had bidirectional audio and no
SRTP/Opus errors. This was validated with worker hostpatch 09 and is not yet a
published unified-image result.

Do not bake a delegated IPv6 prefix into the image or Compose model. Point a
DNS-only AAAA hostname to the current address and configure that hostname as
the public IPv6 identity.

## VPS DDNS and Coturn updater

The operational package in `deploy/ipv6-ddns` tracks the delegated Starlink
and Conecta prefixes. Each cycle checks both IPv6 exits, updates the DNS-only
AAAA records in Cloudflare and, when the preferred address changes, updates
the Coturn IPv6 variables after validating Compose and creating a backup.

Credentials remain only in `/etc/vipertec-ddns/cloudflare.env`; the repository
contains a secret-free example. On hosts where Docker is installed through
Snap, the systemd unit cannot use `NoNewPrivileges=true` because the Snap
launcher must change the execution profile. The unit keeps
`PrivateTmp=true`, but it must still be treated as privileged because it has
root-level Docker access.

See `deploy/ipv6-ddns/README.md` for installation, recovery paths and
post-change validation.

## Validation

### Delivery status on November 13, 2026

The consolidated code includes recovery of the same call for up to 60 seconds,
SDP/ICE/TURN fixes and a local reconnection cue at both native endpoints.
QA build 4161307 was installed on Android and validated/uploaded to App Store
Connect for internal TestFlight. The user confirmed the cue in a physical test;
this does not automatically accept every network, audio route or answering
mode. The cue is mixed into received voice and is never sent over RTP.

The subsections below record earlier diagnostic stages. The central service
received a targeted hotfix, but publishing commits does not create a new image
or automatically replace the production stack.

### Native client after switching cellular and Wi-Fi

If an extension registers but remains waiting for service and responds with
`SIP 500` to the INVITE, the failure happens before audio starts. ViperChat's
native engine now refreshes the operating system's local addresses before
allocating a new ICE/DTLS-SRTP call. This avoids selecting a route from the
previous network's cached addresses; REGISTER alone does not refresh them.

This requires rebuilding and installing the app's native SDK. It is being
validated in an Android QA package, not a new published release. Restarting
the VoIP worker or updating only the ViperConnect image cannot install it.
It does not change credentials, force IPv4 or restart existing call sockets,
and does not promise seamless handover during an active call. iOS background
wake/registration is a separate condition.

The same UI message can also mean that a push offer arrived but no SIP INVITE
arrived before its expiry. After changing networks, a cached registration does
not prove that the old WSS socket is still usable. On Android the app observes
the default network and renews its idle transport after receiving the new
network's addresses. Pending/active calls are not restarted, and the background
push-only policy remains in place. This layer requires rebuilding and installing
the full APK; replacing only the SDK library is insufficient. It is not a VPS
change or a guarantee of seamless audio handover. Check REGISTER, INVITE and its
response separately: a missing INVITE is not an RTP failure or a SIP 500.

In the November 11, 2026 QA retest, the user confirmed the call worked with
both the native Android client and the WhatsApp phone on Wi-Fi. The trace
confirmed connection, secure media in both directions and termination. This
acceptance covers that scenario only, not iOS background wake or a network
change during an active call. The fix has not been published yet.

For iOS, a signed local Mac Archive was generated as `4.16.13`, build
`4161302`, including the updated SDK and native background preparation.
Signatures, production APNs and shared groups were checked. It remains an
experimental QA build and still requires physical iPhone testing, including
locked-screen calls and audio. The simulator's synthetic CallKit flow was
not approved. No TestFlight upload or automatic publication was performed.

### Answered, but still connecting audio

SIP answering can complete before ICE/DTLS is ready. The server's candidate
filter must not remove the default SDP endpoint while still advertising it
in `c=`, `m=audio` or `a=rtcp`. This can leave a registered native client stuck
at “connecting audio”.

For initial offers/answers, the bridge now aligns these fields with a retained
UDP RTP candidate. It preserves the original address family where possible,
without dropping IPv4/IPv6 alternatives, changing credentials or bypassing
ICE/DTLS. No usable candidate produces an explicit error. Re-INVITEs still
require the verified-pair policy described below.

This is a VoIP-service fix; it requires no new configuration or app rebuild.
It was reproduced and tested with the real native SDK in an isolated fixture,
then deployed as a targeted VoIP VPS hotfix on November 11, 2026 without
recreating the stack. The November 11 Android/1010 → iPhone/1001 retest still
failed: ICE connected, but DTLS remained pending and origin RTP stayed at zero.
That direction is not accepted based on the SDP fix alone. It survives a
container restart, not recreation from the old image.

The native engine may need a gathered local base that has no checklist pair
yet when authenticated STUN discovers a new path. The development fix searches
gathered local candidates while retaining UDP, component, address-family and
authentication constraints. It requires an SDK rebuild; it is neither an RB
setting nor an app update already delivered. Pair tests do not replace DTLS,
RTP and audible bidirectional device acceptance. The change alone did not
recover DTLS in the restricted fixture. Another receive-gate failure was then
identified in the real Android call, as described below.

### Android receives packets but DTLS does not complete

A dual-stack IPv6 UDP socket can report an IPv4 packet as an IPv4-mapped
address (`::ffff:a.b.c.d`). The engine required the same address-family
representation when comparing it with the validated IPv4 candidate, dropping
the packet before DTLS even when the IP and port were identical.

The development native patch recognizes only this exact equivalence at the
ICE receive gate. IP, port, the valid-pair list, STUN and the DTLS fingerprint
remain mandatory. It does not authorize other sources or equate NAT64 with
IPv4. Rebuild the SDK/app to include it; a console setting or central-service
restart does not install this fix.

On November 11, 2026, ten real loopback UDP controls passed on Android. The
installed diagnostic APK also completed secure DTLS and bidirectional RTP for
1010/Android Wi-Fi → 1001/iPhone cellular with the iPhone app in the foreground.
The user confirmed audio opened. This is not a substitute for human listening
at both ends or acceptance of every scenario. No new VPS/RB change was made.

A separate locked-iPhone retest remained at “Connecting Audio” before native
SIP registration, despite HTTP 200 for offer resolution/bootstrap. Background
operation remains pending, as does final Android/iOS SDK packaging. The
previous iOS Archive does not contain this new patch.

The user confirmed the locked-screen failure also occurs on build 4161302,
which already includes background preparation. QA Archive 4161303 was then
created with the mapped patch and numeric setup/registration diagnostics;
compilation, signing and synthetic checks passed. This does not establish
iPhone installation, TestFlight availability or a background-operation fix.

### One-way audio after answering

A native SIP client's subsequent offer (`re-INVITE`) must not be answered with
the original IPv4 relay default when ICE has already selected another path,
such as IPv6. The VoIP bridge aligns the SDP destination with the selected,
nominated UDP pair without replacing DTLS, codecs or the existing connection.
It verifies both endpoints against successful ICE pairs before accepting
`remote-candidates`, even before DTLS stats publish selection, and never
reuses the previous pair for an ICE restart.

When a client lists multiple candidates for the same RTP component, the
bridge requires its own transport to confirm the chosen pair; it never
interprets the first listed address as the media destination.

No new configuration or RB/Coturn change is required. The fix is in development
code and a targeted validation VPS hotfix, not a newly published image. Confirm
received/sent RTP after renegotiation **and** audible media at both endpoints.
Online registration or connected ICE alone does not prove bidirectional audio.

```bash
ss -lunp | grep ':5060'
dig +short A sip.yourdomain.com
dig +short AAAA sip6.yourdomain.com
```

Validate registration and bidirectional audio separately with an IPv4 client
and an IPv6 client. Coturn must also have IPv4 and IPv6 listeners and relays;
keep its relay range separate from SIP/RTP and WebRTC media ranges.

The worker's WhatsApp WebSocket, media HTTP and link-preview egress can use the
independent `ZAPO_*_IP_FAMILY` preferences documented in
[Docker Compose](/en/guide/docker-compose#zapo-outbound-ip-family). This remains
separate from call relay media, which accepts numeric IPv4 and IPv6 endpoints.
The internal Zapo worker-to-VoIP WebSocket stays on the existing Docker network.
