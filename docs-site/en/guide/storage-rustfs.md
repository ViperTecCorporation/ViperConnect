# S3 storage with RustFS

RustFS is an S3-compatible storage option for ViperConnect media. Examples pin `rustfs/rustfs:1.0.3` and use dedicated data/log volumes. It is optional: existing MinIO, R2 or other S3 configurations can remain unchanged.

The add-on does not migrate objects, reuse MinIO volumes or automatically change `STORAGE_ENDPOINT` or stored session credentials.

## Performance and limits

RustFS is an alternative to evaluate, not a guarantee of better MinIO performance. Disks, network, object sizes and concurrency affect results. This project's compatibility smoke test is not a performance benchmark.

The model is single-node, without high availability. Keep external backups and monitor capacity/latency. Do not increase replica count against the same local volume. Follow official RustFS planning and requirements for distributed production storage.

## Docker Compose

For the Portainer editor, download a complete single-file model:

- [Complete Compose: Nginx and RustFS](/examples/docker-compose.unoapi-nginx-rustfs.yml)
- [Complete Compose: Traefik and RustFS](/examples/docker-compose.unoapi-traefik-rustfs.yml)

These include API, broker, workers, RabbitMQ, Valkey, VoIP and RustFS, retaining `base` and `base-environment` anchors. Edit credentials, configure the proxy and create the bucket as described below. The S3 endpoint remains explicit to avoid silently switching existing storage.

For separate files, use the following add-ons.

Download a [main deployment model](/en/guide/docker-compose) and add:

- [RustFS Compose add-on](/examples/docker-compose.rustfs.yml)
- [Traefik HTTPS route](/examples/docker-compose.rustfs-traefik.yml), if applicable.

Replace `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` before starting. Generate unique administrative credentials; do not use `rustfsadmin` or keep placeholders.

```bash
docker compose -f docker-compose.yml -f docker-compose.rustfs.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.rustfs.yml up -d rustfs
curl --fail http://127.0.0.1:9000/health/ready
```

Use the same `-f` files on subsequent operations so storage remains part of the configuration. Preserve `rustfs-data` and `rustfs-logs` when recreating containers. New named volumes need no manual ownership changes; host-directory mounts must be writable by RustFS user `10001:10001`.

### Nginx or edge proxy

The add-on binds S3 to `127.0.0.1:9000` and the Console to `127.0.0.1:9001`. Configure a public HTTPS hostname such as `s3.yourdomain.com`, proxying the domain root to the S3 API on 9000, without a path prefix.

Preserve `Host`, path and query parameters. Configure upload sizes/timeouts for expected media. Never rewrite a URL after signing it.

If Nginx Proxy Manager runs in a separate container, its loopback is not the Docker host. Attach it to `unoapi` and target `http://rustfs:9000`, or use a reachable private host address with firewall restrictions. Do not expose the Console publicly as a workaround.

### Traefik

Use all three files and adjust domain, entrypoint and certificate resolver:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.rustfs.yml \
  -f docker-compose.rustfs-traefik.yml \
  config --quiet

docker compose \
  -f docker-compose.yml \
  -f docker-compose.rustfs.yml \
  -f docker-compose.rustfs-traefik.yml \
  up -d rustfs
```

The external `traefik-public` network must exist. Routing exposes only the S3 API, not the Console.

## Bucket and application credentials

For Compose, access the Console through an administrative network or SSH tunnel:

```bash
ssh -L 9001:127.0.0.1:9001 user@your-server
```

Open `http://127.0.0.1:9001`, sign in as the administrator, create private bucket `unoapi` and configure application-only credentials. Grant only required bucket operations, including listing, reads, writes, deletion and multipart uploads. Do not permanently give workers administrative credentials or make the bucket public.

Configure the UnoAPI shared environment:

```yaml
STORAGE_BUCKET_NAME: "unoapi"
STORAGE_ACCESS_KEY_ID: "APPLICATION_ACCESS_KEY"
STORAGE_SECRET_ACCESS_KEY: "APPLICATION_SECRET_KEY"
STORAGE_REGION: "us-east-1"
STORAGE_ENDPOINT: "https://s3.yourdomain.com"
STORAGE_FORCE_PATH_STYLE: "true"
STORAGE_TIMEOUT_MS: "1200000"
```

The add-on does not create buckets automatically. Create and validate the bucket before switching destinations. Review per-session storage settings too: they can override global defaults.

**Do not use `http://rustfs:9000` as the default production application endpoint.** ViperConnect uses this endpoint to generate signed URLs; external consumers cannot resolve the internal Docker hostname. Both workers and signed-URL consumers must reach the HTTPS hostname.

VoIP recording storage has separate settings. Configure its S3 destination explicitly if recordings should also use RustFS; UnoAPI `STORAGE_*` changes do not change telephony storage automatically.

## Docker Swarm

Single-file models are also available for Portainer Swarm:

- [Complete stack: Nginx and RustFS](/examples/docker-stack.unoapi-nginx-rustfs.yml)
- [Complete stack: Traefik and RustFS](/examples/docker-stack.unoapi-traefik-rustfs.yml)

Use Swarm-specific add-ons, not the Compose files:

- [RustFS Swarm add-on](/examples/docker-stack.rustfs.yml)
- [Swarm Traefik route](/examples/docker-stack.rustfs-traefik.yml)

```bash
docker stack config \
  -c docker-stack.unoapi-nginx.yml \
  -c docker-stack.rustfs.yml

docker stack deploy \
  -c docker-stack.unoapi-nginx.yml \
  -c docker-stack.rustfs.yml \
  unoapi
```

For Traefik, replace the main model and add `-c docker-stack.rustfs-traefik.yml` to both commands. Adjust `deploy.labels`.

RustFS uses a single node labeled `viperconnect.data=true` with local volumes. Label only the selected data node: rescheduling elsewhere does not carry objects along. The Swarm model disables the Console. Use an S3 client to create the bucket; configure access using official administrative tools or enable the Console only on an administrative network.

Port 9000 uses host-mode publishing. Unlike Compose, it is not loopback-only: firewall it to trusted proxies/admin networks. An overlay network and local disk do not provide storage high availability.

## Validation and migration

An isolated local fixture passed PUT, HEAD, GET, Range, presigned GET, LIST, 11 MiB multipart upload and deletion. No real media or VPS was accessed.

Reproduce using `scripts/smoke-rustfs-s3.mjs`. It requires `RUSTFS_SMOKE_ENABLED=1`, an HTTP loopback endpoint and isolated-instance credentials; it creates and cleans its own temporary bucket. Do not forward a production instance through a tunnel for this test.

Before migrating, inventory/back up data, copy through S3 APIs, and verify counts, content and signed-URL access before switching. Retain the original and rollback path until acceptance. Do not mount an old MinIO disk directly as a RustFS migration procedure.

Official references: [Docker installation](https://docs.rustfs.com/en/installation/container/docker), [health and readiness](https://docs.rustfs.com/en/operations/status-check) and [release 1.0.3](https://github.com/rustfs/rustfs/releases/tag/1.0.3).
