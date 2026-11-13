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

## Version 4.0.42 preparation

Version 4.0.42 brings per-session SQLite, controlled migration, metrics, an
administrative explorer and S3 backup/restore for sessions and the VoIP database.
New sessions use SQLite only with valid persistent storage and worker capability;
otherwise they keep using Redis and the panel shows a configuration warning.
Redis remains required for coordination, authentication and shared configuration.
Existing Redis sessions are not migrated automatically.

The unified-image workflow pins VoIP **0.1.70** to revision
`76e83b7755c59cd851df8b77bfbb15a330db39be`, including native-call recovery.
Reconnection cues also require updated compatible applications. See
[session storage](/en/guide/session-storage),
[VoIP backups](/en/guide/voip-backups) and the
[preparation notes](https://github.com/ViperTecCorporation/ViperConnect/blob/mobile-primary/docs/release-4.0.42.md).
Versions and the source pin are prepared in code only: this stage publishes no
new tag/release or 4.0.42 image and does not deploy to production.

## Version 4.0.41

Version 4.0.41 upgrades Zapo to 1.11.0 and adds per-contact crypto recovery,
forwarding metadata, media caption editing and Mobile Primary companion fixes.
It keeps VoIP service 0.1.69 at the same pinned revision.
The [release notes](https://github.com/ViperTecCorporation/ViperConnect/blob/v4.0.41/docs/release-4.0.41.md)
describe limitations and the four companion hostpaths to review before upgrading.
Publication does not deploy, migrate data or prove completion on the companion.

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
