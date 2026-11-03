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
