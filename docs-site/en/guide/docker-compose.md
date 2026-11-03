# Docker Compose

The project provides complete single-host models for Nginx or another edge
proxy and for Traefik. Both use the unified `latest` image, separate web,
broker, video and Zapo worker roles, persistent Valkey and RabbitMQ, and host
networking for telephony.

For self-hosted S3 storage, add the [optional RustFS model](/en/guide/storage-rustfs)
with dedicated volumes and HTTPS routing. It does not switch an existing S3 destination.

- [Download the Nginx/edge-proxy model](/examples/docker-compose.unoapi-nginx.yml)
- [Download the Traefik model](/examples/docker-compose.unoapi-traefik.yml)

```bash
curl -fsSL https://docs.yourdomain.com/examples/docker-compose.unoapi-nginx.yml \
  -o docker-compose.yml
nano docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
curl http://127.0.0.1:9876/ping
```

Before deployment, replace every domain, token, password, public address and
storage credential. Keep the same RabbitMQ password in the service and
`AMQP_URL`, and the same Valkey password in `REDIS_URL`, `--requirepass` and the
healthcheck.

Telephony also receives `AMQP_URL` for ViperChat event delivery. Host networking
uses `127.0.0.1:5672`, so RabbitMQ publishes AMQP on loopback only. Other services
use `unoapi-rabbitmq:5672` on the Docker network. Keep both URLs and RabbitMQ
credentials consistent; the host-networked VoIP service cannot rely on container DNS.

## IPv4 and IPv6 Docker network

Public API ingress and Zapo worker egress are separate IPv6 concerns. To give
the internal containers both families, download the optional override:

- [Download the IPv6 network override](/examples/docker-compose.unoapi-ipv6.override.yml)

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  config

docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  up -d --force-recreate
```

Docker cannot change the subnet of an existing network. Schedule a maintenance
window to recreate containers and the network, never use `down -v`, and keep
using the override on later deployments. The `fd42:756e:6f61::/64` ULA is
internal and independent from the ISP's public prefix.

For public IPv6 access, prefer Nginx or Traefik listening on `[::]:443` and
proxying port 9876. A global container address is not required. See the
[IPv4 and IPv6 networking guide](/en/guide/network-ipv6).

## Production-tested Valkey persistence

The downloadable models use:

```yaml
command: >
  valkey-server
  --appendonly yes
  --appendfsync everysec
  --no-appendfsync-on-rewrite no
  --save 3600 1
  --requirepass "CHANGE_THIS_PASSWORD"
  --protected-mode no
```

AOF is flushed every second and remains protected during rewrites. RDB is kept
as an hourly safety snapshot after at least one change. This replaces the old
60, 300 and 900-second snapshots that repeatedly rewrote large datasets. The
6379 port is not published; keep it on the internal network and require a
password.

## Zapo outbound IP family

The Zapo worker supports one global policy plus independent channel overrides:

```yaml
ZAPO_NETWORK_IP_FAMILY: "auto"
ZAPO_CHAT_SOCKET_IP_FAMILY: ""
ZAPO_MEDIA_UPLOAD_IP_FAMILY: ""
ZAPO_MEDIA_DOWNLOAD_IP_FAMILY: ""
ZAPO_LINK_PREVIEW_IP_FAMILY: ""
```

Accepted values are `auto`, `ipv6first` and `ipv4first`. Empty channel values
inherit the global policy. Both ordered modes retain the other family as a
fallback. Set only `ZAPO_NETWORK_IP_FAMILY=ipv6first` to prefer IPv6 on every
direct channel. When `PROXY_URL` is set, the SOCKS proxy remains authoritative;
with `socks5h`, the remote proxy controls DNS and egress family.

## Telephony ports

The telephony container uses `network_mode: host`. Open `3097/tcp`, `5060/udp`,
`12000-13000/udp` and `13001-14000/udp` on IPv4 and IPv6. Do not add a Docker
`ports` block to that service. Keep `SIP_RTP_PUBLIC_IPV4` separate from
`SIP_RTP_PUBLIC_IPV6_HOST`.

When a trusted public SIP proxy or SBC relays media through an address that is
private but routable from the VoIP host, list the proxy signaling IPs in
`SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS`, separated by commas. This allowlist is not
the VoIP server public address and should remain empty for direct extensions.
