# IPv4 and IPv6 networking

This guide separates three concerns that are often mixed together:

| Purpose | Where IPv6 is required |
| --- | --- |
| Public API and Manager | Host and Nginx/Traefik HTTPS edge |
| Zapo outbound connections | Host default route and worker network |
| SIP, RTP and call relay | Telephony host and dedicated VoIP sockets |

Public IPv6 ingress does not require a global container address. Likewise, the
worker can have IPv6 egress without publishing any worker port.

## 1. Validate the host

```bash
ip -6 address show scope global
ip -6 route show default
sysctl net.ipv6.conf.all.disable_ipv6
ping -6 -c 3 2606:4700:4700::1111
curl -6 --fail-with-body https://cloudflare.com/cdn-cgi/trace
```

`disable_ipv6` must be `0`. Keep ICMPv6 available because neighbor discovery
and path MTU depend on it. Publish a **DNS-only** AAAA record. If the delegated
prefix changes, update DNS with DDNS instead of embedding the prefix in code,
images or versioned YAML.

## 2. Enable a dual-stack Docker bridge

The main model keeps IPv4-only networking as the compatibility default. Use the
optional override to add IPv6:

- [Download the IPv6 override](/examples/docker-compose.unoapi-ipv6.override.yml)

```yaml
networks:
  unoapi:
    name: unoapi-dualstack
    driver: bridge
    enable_ipv6: true
    ipam:
      config:
        - subnet: 172.23.0.0/16
        - subnet: fd42:756e:6f61::/64
```

The ULA is stable and internal; it is not the host's public prefix. Docker's
default bridge gateway mode applies NAT/masquerading for outbound traffic.
Change both subnets if they overlap a company network, VPN or another project.

For a new installation:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  config

docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  up -d
```

Docker cannot change an existing network subnet. For an active installation,
verify volumes, schedule a reconnect window, validate the merged configuration,
run `docker compose down` without `-v`, then recreate with both files and
`--force-recreate`. Keep both files in every later deployment. Never use
`down -v`, which deletes persistent volumes.

The preflight is the merged `docker compose config`; do not recreate the network
if that command reports a conflict or an invalid subnet.

Validate the result:

```bash
docker network inspect unoapi-dualstack
docker exec unoapi-worker-zapo ip -6 address
docker exec unoapi-worker-zapo ip -6 route
docker exec unoapi-worker-zapo node -e \
  "require('node:https').get('https://[2606:4700:4700::1111]',r=>{console.log(r.statusCode);r.resume()}).on('error',e=>{console.error(e.message);process.exit(1)})"
```

Prefer IPv6 on direct Zapo channels while retaining IPv4 fallback:

```yaml
ZAPO_NETWORK_IP_FAMILY: "ipv6first"
ZAPO_CHAT_SOCKET_IP_FAMILY: ""
ZAPO_MEDIA_UPLOAD_IP_FAMILY: ""
ZAPO_MEDIA_DOWNLOAD_IP_FAMILY: ""
ZAPO_LINK_PREVIEW_IP_FAMILY: ""
```

`PROXY_URL` remains authoritative when configured.

**Mobile Primary:** chat connects through Zapo's native TCP transport, not WebSocket.
Neither `ZAPO_CHAT_SOCKET_IP_FAMILY` nor the global family preference injects an
HTTP agent into that socket; chat retains native network selection. Upload,
download and link previews still honor their family preferences. This also
applies after backup restore: transport is detected from stored credentials.
Explicit proxies are never bypassed; SOCKS is not supported by the current
Zapo mobile TCP transport.

## 3. Publish the web container over IPv6

The recommended topology is:

```text
IPv4/IPv6 client -> DNS A/AAAA -> TCP 443 firewall
                  -> Nginx or Traefik -> unoapi:9876
```

The proxy terminates TLS on both families and reaches the service over the
internal network. The application container does not need a global IPv6.

### Nginx or Nginx Proxy Manager

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name unoapi.example.com;

    location / {
        proxy_pass http://127.0.0.1:9876;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

When the proxy is a container on the same network, use
`http://unoapi:9876`. Allow only TCP 80 and 443 at the IPv4/IPv6 edge; port
9876 does not need to be public.

### Direct port publishing

An unspecified mapping such as `"9876:9876"` can create host bindings on
`0.0.0.0` and `[::]`. The current ViperConnect HTTP backend, however, listens
on IPv4 inside the container. Docker only guarantees IPv6-host to IPv4-container
translation on an IPv4-only bridge with `userland-proxy` enabled. Do not assume
that a dual-stack bridge serves port 9876 over IPv6 just because a host binding
is displayed.

Inspect the bindings:

```bash
docker port unoapi 9876
ss -ltnp | grep ':9876\b'
```

For a host-local proxy backend, publish IPv4 loopback and let Nginx receive the
client on `[::]:443`:

```yaml
ports:
  - "127.0.0.1:9876:9876"
```

Do not expose 9876 directly to the Internet when 443 is the public endpoint.
This exposes the web service over IPv6 without requiring an IPv6 Node listener
or a global address on the application container.

### Traefik

Publish the `websecure` entrypoint on host port 443 for both families. The
`traefik-public` network needs dual-stack only if Traefik-to-UnoAPI traffic must
also use IPv6. IPv6 clients only require the external entrypoint on `[::]:443`.

## 4. Native Linux

Native deployments have no Docker bridge. The worker uses the host route
directly. After validating the host, set:

```dotenv
ZAPO_NETWORK_IP_FAMILY=ipv6first
```

Restart only the Zapo worker unit and follow reconnects:

```bash
sudo systemctl restart viperconnect-worker.service
sudo journalctl -u viperconnect-worker.service -f
```

A single-process installation uses `viperconnect.service`, so its restart also
briefly interrupts the API and queues. Restrict Node port 9876 to the host/proxy
with firewall policy and terminate public IPv4/IPv6 TLS in Nginx.

```bash
ss -ltnp | grep -E ':(443|9876)\b'
curl --fail-with-body http://127.0.0.1:9876/ping
curl -6 --fail-with-body https://unoapi.example.com/ping
curl -4 --fail-with-body https://unoapi.example.com/ping
```

## 5. Direct global IPv6 routing to containers

Docker supports an IPv6 `routed` gateway mode. It requires a dedicated `/64`
routed to the Docker host, an upstream route and forwarding firewall policy. No
NAT66 is used and the container becomes directly addressable.

Use this only when the ISP delegates a separate prefix and the team controls
routing, neighbor discovery and prefix renewal. Do not reuse the LAN prefix or
store a dynamic ISP prefix in versioned YAML. A ULA bridge for egress plus a
dual-stack host proxy for ingress is safer for most ViperConnect deployments.

## 6. Operational acceptance

- the worker network reports IPv4 and IPv6 subnets;
- internal service-name resolution still works;
- public `/ping` succeeds with `curl -4` and `curl -6`;
- worker sockets use IPv6 when `ipv6first` is active;
- a controlled IPv6 failure falls back to IPv4;
- the worker has no restart, DNS or TLS regression;
- Valkey, RabbitMQ, media, webhooks and telephony stay healthy.

References: [Docker Engine IPv6](https://docs.docker.com/engine/daemon/ipv6/),
[Compose networks](https://docs.docker.com/reference/compose-file/networks/)
and [port publishing](https://docs.docker.com/engine/network/port-publishing/).
