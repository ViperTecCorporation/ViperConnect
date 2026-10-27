# Docker Swarm

Optional [RustFS Swarm add-ons](/en/guide/storage-rustfs#docker-swarm) provide
self-hosted S3 without migrating or silently switching existing storage.

The telephony service includes `AMQP_URL` for ViperChat events. It connects to
`unoapi-rabbitmq:5672` through the overlay like the workers; publishing AMQP on
the host is not required in Swarm.

The Swarm templates keep persistent services on labeled nodes, use overlay
networks for internal traffic and publish telephony media ranges in host mode.

- [Download the Nginx/edge-proxy stack](/examples/docker-stack.unoapi-nginx.yml)
- [Download the Traefik stack](/examples/docker-stack.unoapi-traefik.yml)

```bash
curl -fsSL https://docs.yourdomain.com/examples/docker-stack.unoapi-nginx.yml \
  -o docker-stack.yml
chmod 600 docker-stack.yml
nano docker-stack.yml
docker stack config -c docker-stack.yml >/dev/null
docker stack deploy -c docker-stack.yml viperconnect
```

Review all placeholders before deploying. Label the node that owns persistent
data and telephony according to the constraints in the model. Local volumes do
not move with a task.

Valkey uses AOF with `appendfsync everysec`,
`no-appendfsync-on-rewrite no`, and the `save 3600 1` RDB safety snapshot. Port
6379 remains private to the overlay network and authentication is mandatory.

The generated stacks expose compact, non-overlapping RTP and WebRTC ranges.
Change the source templates and run `docs/examples/generate-swarm-stack.mjs`
instead of editing thousands of expanded port entries manually.
