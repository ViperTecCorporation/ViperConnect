# Installation

Choose the deployment path that matches how you operate the platform.

| Scenario | Recommendation | Why |
| --- | --- | --- |
| one VPS or staging environment | [Docker Compose](/en/guide/docker-compose) | fewer components to operate |
| distributed cluster | [Docker Swarm](/en/guide/docker-swarm) | placement, overlay and service-level updates |
| no Docker runtime | [Native Linux](/en/guide/install-native-linux) | immutable releases, `systemd` and rollback |
| telephony directly on the host | [Native Linux telephony](/en/guide/install-voip-native-linux) | predictable SIP and media ports |

For a first installation, start with Docker Compose. As soon as HTTPS and the
API are healthy, follow the [quickstart](/en/guide/quickstart); you do not need
to read every deployment guide before testing a text message.

Choose the deployment model that matches your infrastructure. The unified
container image can run the API, broker, Zapo worker, dedicated video worker
and telephony process. Native Linux packages are also available.

## Deployment options

- [Docker Compose](/en/guide/docker-compose): one host, bridge networking and
  host networking for telephony.
- [Docker Swarm](/en/guide/docker-swarm): clustered services, overlay networks
  and explicit host-mode media ports.
- [Native Linux installer](/en/guide/install-native-linux): versioned releases
  managed by systemd.
- [Native Linux telephony](/en/guide/install-voip-native-linux): SIP, RTP and
  WebRTC directly on the host while the API may remain in Docker.

## Recommended minimum

| Resource | Recommendation |
| --- | --- |
| CPU | 2 cores |
| Memory | 4 GB while building locally |
| State database | Valkey 9 or a compatible Redis server |
| Queue | RabbitMQ 4 |
| HTTP port | `9876` |

Do not publish Valkey or RabbitMQ to the internet. Terminate TLS at your edge
proxy and use strong, unique tokens for every installation.

## Integrated 4.0.40 validation

`ViperConnect 4.0.40` embeds VoIP service `0.1.69` at a pinned source revision.
The [delivery notes](https://github.com/ViperTecCorporation/ViperConnect/blob/v4.0.40/docs/release-4.0.40-viperchat38.md)
record the contracts, embedded revision and validation boundaries.

The `@roamhq/wrtc` `0.10.0` addon has a known limitation: an isolated test
reproduced `SIGSEGV` during natural process finalization after confirming
bidirectional audio. Publication for validation was authorized with the current
library; this shutdown fault remains unresolved. No relationship was established
with the calls validated using hostpath patches or the mobile-network audio delay.
Publishing an image does not deploy it to an installation.

If validation reveals an impact, a library fork may be evaluated with teardown
and media regressions. No fork or SDK replacement is part of this delivery.
