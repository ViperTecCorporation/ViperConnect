# Environment Variables Ã¢â‚¬â€ Reference and Examples

This guide explains key environment variables, when to use them, and why. Copy `.env.example` to `.env` and adjust for your setup.

See [FRONTEND.md](FRONTEND.md) for the panel architecture and legacy Baileys
worker operation.
See [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) for single-container and
role-separated deployments.

## Core Server

- `PORT` Ã¢â‚¬â€ HTTP port. Default `9876`.
  - Use when running multiple services or behind a reverse proxy.
  - Example: `PORT=8080`
- `BASE_URL` Ã¢â‚¬â€ Public base URL used to compose media links in responses.
  - Use when your service is behind a proxy/CDN and clients download media via a public URL.
  - Example: `BASE_URL=https://api.example.com`

## Session & Connection

- `CONNECTION_TYPE` Ã¢â‚¬â€ `qrcode` | `pairing_code`. Default `qrcode`.
  - Use `pairing_code` for headless pairing without showing QR.
  - Example: `CONNECTION_TYPE=pairing_code`
- `CLEAN_CONFIG_ON_DISCONNECT` Ã¢â‚¬â€ Clean saved configs when disconnecting. Default `false`.
  - Use to force a fresh state on disconnect.
  - Example: `CLEAN_CONFIG_ON_DISCONNECT=true`

## Logging

- `LOG_LEVEL` Ã¢â‚¬â€ Unoapi service log level. Default `warn`.
  - Use `debug` during development.
  - Example: `LOG_LEVEL=debug`
- `UNO_LOG_LEVEL` Ã¢â‚¬â€ Internal Uno logger override (falls back to LOG_LEVEL).
  - Example: `UNO_LOG_LEVEL=info`

## Redis & RabbitMQ

- `REDIS_URL` Ã¢â‚¬â€ Redis/Valkey connection string. Required for every UnoAPI runtime.
  - Startup fails before opening HTTP or AMQP consumers when it is missing or Redis cannot answer `PING`.
  - Filesystem is only a media backend when S3 is absent; it is not a fallback for sessions, configuration, IDs, leases or caches.
  - Example: `REDIS_URL=redis://localhost:6379`
- `WHATSAPP_ENGINE` — default engine for new sessions without a persisted `provider`; defaults to `zapo`. Persisted legacy sessions without the field are identified as Baileys, shown offline and must be removed before a new Zapo pairing.
- `UNOAPI_WORKER_ENGINE` — engine owned by the worker process. The supported runtime value is `zapo`; Baileys is suppressed in code and has no container.
- `UNOAPI_PROCESS_ROLE` — optional role loaded by the cloud entrypoint: `web`, `broker`, `video` or `worker`. When omitted, the process starts all roles. The `broker` role also runs bulk, commander and bulk-status consumers.
- `UNOAPI_VIDEO_WORKER_MODE` — `broker` by default for backward compatibility, or `dedicated` to leave video staging/transcoding exclusively to a process with `UNOAPI_PROCESS_ROLE=video`. Dedicated mode deliberately has no automatic broker failover.
- `AMQP_URL` Ã¢â‚¬â€ RabbitMQ URL for broker features.
  - Use to enable queue processing (web/worker model, retries, dead letters).
  - Example: `AMQP_URL=amqp://guest:guest@localhost:5672?frameMax=8192`

## Storage (S3/MinIO)

- `STORAGE_ENDPOINT` Ã¢â‚¬â€ S3-compatible endpoint.
- `STORAGE_REGION` Ã¢â‚¬â€ S3 region (e.g., `us-east-1`).
- `STORAGE_BUCKET_NAME` Ã¢â‚¬â€ Bucket name for media.
- `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` Ã¢â‚¬â€ Credentials.
- `STORAGE_FORCE_PATH_STYLE` Ã¢â‚¬â€ `true` for MinIO/compatibility.
  - Use these to store media in S3/MinIO instead of local filesystem.
  - Example:
    ```env
    STORAGE_ENDPOINT=http://minio:9000
    STORAGE_REGION=us-east-1
    STORAGE_BUCKET_NAME=unoapi
    STORAGE_ACCESS_KEY_ID=minioadmin
    STORAGE_SECRET_ACCESS_KEY=minioadmin
    STORAGE_FORCE_PATH_STYLE=true
    ```

## Status/Broadcast Behavior

- `STATUS_ALLOW_LID` Ã¢â‚¬â€ Allow LID JIDs in status recipients. Default `true`.
  - Set `false` to normalize to PN (`@s.whatsapp.net`) for consistency.
  - Example: `STATUS_ALLOW_LID=false`
- `STATUS_BROADCAST_ENABLED` Ã¢â‚¬â€ Enable Status (status@broadcast) sending. Default `true`.
  - Set `false` to block any outgoing Status before reaching WhatsApp (useful to avoid account risk).
  - Example: `STATUS_BROADCAST_ENABLED=false`

## Group Sending

Baileys group membership checks, LID addressing and Signal assert limits are
internal policies in `src/services/baileys_group_policy.ts`. They have no
environment overrides and are not used by Zapo.

## Baileys delivery recovery

Recovery for Baileys messages stuck at `sent` is an internal bounded policy in
`src/services/baileys_delivery_policy.ts`. It has no environment overrides and
is not used by Zapo.

## One‑to‑One (Direct) Sending

- Direct chats always use the canonical LID (`@lid`) for transport. Phone numbers remain additional identity metadata and this behavior is not configurable.
- Baileys Signal pre-assert, decrypt self-heal, periodic assert and session-purge safeguards are internal policies. They are not runtime environment settings and are never read by the Zapo adapter.
- Baileys LID-to-PN background enrichment is bounded by `src/services/baileys_identity_policy.ts`; it has no environment overrides and is not used by Zapo.

Large-group metadata refresh and bounded No-sessions recovery are internal
Baileys policies in `src/services/baileys_group_policy.ts`. The generic
server-ACK resend loop and BR 12/13 digit send-order heuristic were removed.

Reliability note:
- On a rare libsignal error Ã¢â‚¬Å“No sessionsÃ¢â‚¬Â during group sends, the service applies the bounded internal Baileys recovery policy.

### Group receipt/status fan-out controls

When groups get large, per-recipient receipts (read/played/delivered per participant) can flood your webhook/socket. These toggles reduce event fanÃ¢â‚¬â€˜out while preserving a single groupÃ¢â‚¬â€˜level delivery signal.

- `GROUP_IGNORE_INDIVIDUAL_RECEIPTS` Ã¢â‚¬â€ Suppress `message-receipt.update` per participant for group messages. Default `true`.
  - Set `false` to receive perÃ¢â‚¬â€˜user read/played/delivery receipts in groups.
- `GROUP_ONLY_DELIVERED_STATUS` Ã¢â‚¬â€ On `messages.update` for groups, forward only `DELIVERY_ACK` (delivered). Default `true`.
  - Set `false` to forward all status updates (including read/played) for groups.
- `UNOAPI_META_GROUPS_ENABLED` - Enables the Meta-like group API shape, group details route, and group management endpoints. Default `false`.
  - Group management uses the local Baileys client when available; AMQP deployments use a synchronous RPC command to the session owner.

Example (keep load low in big groups):
```env
GROUP_IGNORE_INDIVIDUAL_RECEIPTS=true
GROUP_ONLY_DELIVERED_STATUS=true
```
Restore legacy behavior (full receipts per user):
```env
GROUP_IGNORE_INDIVIDUAL_RECEIPTS=false
GROUP_ONLY_DELIVERED_STATUS=false
```


## One-to-One (Direct) Sending

Direct chats always use the canonical LID (`@lid`) for transport. Phone numbers remain additional identity metadata and this behavior is not configurable.

Webhook normalization
- WEBHOOK_PREFER_PN_OVER_LID â€” If 	rue (default), webhook payloads prefer PN in wa_id, rom and 
ecipient_id when safely resolvable; otherwise a LID/JID may be returned.## LID/PN Mapping Cache

- `JIDMAP_CACHE_ENABLED` Ã¢â‚¬â€ Enable PNÃ¢â€ â€LID cache. Default `true`.
  - Stores perÃ¢â‚¬â€˜session mapping between LID JIDs and PN JIDs to reduce runtime lookups and improve delivery in large groups.

## Baileys Signal recovery

Signal assert/recovery values are maintained in `src/services/baileys_assert_policy.ts`.
They remain isolated from Zapo and intentionally have no environment overrides.
  - Example: `JIDMAP_CACHE_ENABLED=true`
- `JIDMAP_TTL_SECONDS` Ã¢â‚¬â€ TTL for cache entries. Default `604800` (7 days).
  - Example: `JIDMAP_TTL_SECONDS=604800`
  - Set `0` or a negative value to keep mappings without expiration.

Baileys auth-to-JIDMAP enrichment is an internal bounded policy in
`src/services/baileys_auth_policy.ts`.

## LID/PN Behavior

- Webhooks prefer PN. When PN cannot be resolved safely, LID/JID is returned as a fallback.
- Internally, the API uses LID when available for 1:1 and groups. For 1:1, PNÃ¢â€ â€™LID mappings are learned on-the-fly (assertSessions/exists, and events).
- Profile pictures are stored and retrieved by canonical PN and, when known, by stable LID/user id as separate keys (same for S3 keys), so PN and BSUID lookups can both resolve the image.

## AntiÃ¢â‚¬â€˜Spam / Rate Limits

- `RATE_LIMIT_GLOBAL_PER_MINUTE` Ã¢â‚¬â€ Max messages per minute per session. Default `0` (disabled).
  - Example: `RATE_LIMIT_GLOBAL_PER_MINUTE=60`
- `RATE_LIMIT_PER_TO_PER_MINUTE` Ã¢â‚¬â€ Max messages per minute per destination (per session). Default `0` (disabled).
  - Example: `RATE_LIMIT_PER_TO_PER_MINUTE=20`
- `RATE_LIMIT_BLOCK_SECONDS` Ã¢â‚¬â€ Suggested delay (in seconds) when limits are exceeded. Default `60`.
  - When a limit is hit, the API schedules the send via RabbitMQ with this delay instead of returning HTTP 429.
  - Example: `RATE_LIMIT_BLOCK_SECONDS=60`

## Webhooks / Queues / Retries

- `UNOAPI_MESSAGE_RETRY_LIMIT` Ã¢â‚¬â€ Max delivery attempts in AMQP consumers before deadÃ¢â‚¬â€˜letter. Default `5`.
  - Example: `UNOAPI_MESSAGE_RETRY_LIMIT=7`
- `UNOAPI_MESSAGE_RETRY_DELAY` Ã¢â‚¬â€ Default delay used by helpers when publishing delayed messages (ms). Default `10000`.
  - Note: the consumer retry path uses a fixed 60s requeue delay.
  - Example: `UNOAPI_MESSAGE_RETRY_DELAY=15000`
- `CONSUMER_TIMEOUT_MS` — Max time (ms) allowed for a consumer to process a message before forcing retry. Default `450000`.
  - Keep it greater than the largest session webhook timeout.
  - Example: `CONSUMER_TIMEOUT_MS=450000`
- `NOTIFY_FAILED_MESSAGES` Ã¢â‚¬â€ Send a diagnostic text to the session number when retries are exhausted. Default `true`.
  - Example: `NOTIFY_FAILED_MESSAGES=false`

## Webhook Delivery (Async)

- `WEBHOOK_ASYNC` ÇŸ¶½Ç½ƒ?s¶ªÇ½ƒ'ª¶? Send webhooks in background (fire-and-forget). Default `true`.
  - Use `false` to block the request until all webhooks finish.
- `WEBHOOK_ASYNC_MODE` ÇŸ¶½Ç½ƒ?s¶ªÇ½ƒ'ª¶? Async delivery backend. Default `amqp`.
  - `amqp`: enqueue webhooks in RabbitMQ (recommended in production). Requires `AMQP_URL`.
  - When `AMQP_URL` is missing, the service falls back to direct HTTP send and logs a warning.

## Webhook Circuit Breaker

Fail fast when a webhook endpoint is offline to avoid queue backlog.

- `WEBHOOK_CB_ENABLED` — Enable/disable the circuit breaker. Default `true`.
- `WEBHOOK_CB_FAILURE_THRESHOLD` — Transient failures within the window required to open the circuit. Default `3`.
- `WEBHOOK_CB_FAILURE_TTL_MS` — Failure counting window (ms). Default `300000`.
- `WEBHOOK_CB_OPEN_MS` — How long the circuit stays open (skip sends) after tripping. Default `120000`.
- `WEBHOOK_CB_REQUEUE_DELAY_MS` — Delay (ms) used to requeue when the circuit is open. Default `120000`.
- `WEBHOOK_CB_HALF_OPEN_PROBE_MS` — Minimum lease for the single half-open recovery probe. Default `30000`; the webhook timeout wins when larger.

Behavior:
- When open, webhook delivery is skipped for that endpoint.
- Circuit state is isolated by session and webhook ID.
- Network errors, HTTP `408`, `425`, `429`, and `5xx` count as circuit failures. Permanent `4xx` payload/auth errors do not take the whole endpoint offline.
- After the open window, exactly one request probes the endpoint. Other deliveries remain queued until the probe succeeds or the circuit opens again.
- Deliveries skipped because the circuit is already open do not consume the AMQP retry budget. Real HTTP/network attempts still consume retries.
- The default requeue delay matches the open window so recovered endpoints resume without an extra idle gap.

## Media & Timeouts

### Inbound deduplication

Baileys suppresses immediate duplicate events through the internal bounded
window in `src/services/baileys_listener_policy.ts`.

### Baileys app-state sync

Baileys app-state clearing remains disabled and full-history override remains
disabled in `src/services/baileys_connection_policy.ts`. New unmarked sessions
can still perform their normal first sync when history import is enabled.
- `AUTO_CONNECT_CONCURRENCY` - Maximum sessions connecting in parallel during service startup. Default `1`.
  - Keep low on small containers to avoid reconnect storms and memory spikes.

### Outgoing idempotency

Skip sending the same message again when a job retry happens after a successful send.

- `OUTGOING_IDEMPOTENCY_ENABLED` Ã¢â‚¬â€ When `true` (default), the incoming job checks the store (key/status) for the UNO id before sending; if it looks processed, it skips the send.
  - Example: `OUTGOING_IDEMPOTENCY_ENABLED=false` (to disable)

### Webhook payload size

- `WEBHOOK_INCLUDE_MEDIA_DATA` ÇŸ¶½Ç½ƒ?s¶ªÇ½ƒ'ª¶? Include media binary/base64 in webhook payloads. Default `false`.
  - When `false`, payloads keep `url` and `filename` but remove heavy binary/base64 fields.

### Profile Pictures

- Canonical identity: Zapo uses LID and preserves PN as an additional alias when known; groups keep `@g.us`. Baileys remains compatible with PN-first lookups.
- Force refresh: `PROFILE_PICTURE_FORCE_REFRESH=true` (default) re-fetches from WhatsApp before returning the local/storage URL.
- Missing-picture cache: `PROFILE_PICTURE_NOT_FOUND_TTL_SEC=10800` (default: 3 hours) prevents repeated Zapo lookups after privacy/404/no-picture responses. Redis stores one ZSET per session and picture events invalidate the matching member immediately. Set `0` to disable.
- Webhook interval: `PROFILE_PICTURE_WEBHOOK_INTERVAL_SEC=10800` (default: 3 hours) controls when the same contact/group picture is included again. Redis stores one ZSET per session, not one key per contact. Set `0` for the legacy always-populated behavior.
- Prefetch on send: the client prefetches the destination picture on outbound messages (1:1 and groups) to keep the cache fresh.
- Robust fetch order: for 1:1, attempts PN first, then mapped LID, using modes `image` then `preview`.
- S3 safety: checks object existence (HeadObject) before generating a presigned URL.

### Status/Webhook Behavior

- 1:1 normalization: `recipient_id` always PN (digits), even when events arrive with @lid.
- Timestamps: statuses (delivered/read) contain a timestamp (receipt/read when available; else `payload.messageTimestamp`).
- ID normalization: map provider ids to UNO ids before sending to webhooks.
- Anti-regression/duplicate: ignore lower-rank updates (e.g., Ã¢â‚¬Å“sentÃ¢â‚¬Â after Ã¢â‚¬Å“deliveredÃ¢â‚¬Â) and repeated statuses for the same message id.

## Base64 media input

- `UNOAPI_MEDIA_BASE64_MAX_BYTES` — Maximum decoded size for media supplied in
  the `base64` field. Default: `33554432` (32 MiB).
- `UNOAPI_MESSAGES_JSON_LIMIT` — Express JSON limit applied only to
  `messages` and `marketing_messages` routes. Default: `48mb`.
- Base64 is decoded and persisted before AMQP publication. RabbitMQ, provider
  webhooks and application logs receive only the staged media reference.
- Existing media payloads using `link` are not changed.

## Profile Pictures

- Overview: The service can enrich webhook payloads with contact and group profile pictures. When enabled, images are stored either on S3 (recommended in production) or on the local filesystem and exposed as URLs in webhook events.

- Enable/disable
  - `SEND_PROFILE_PICTURE` Ã¢â‚¬â€ Include profile pictures in webhook payloads. Default `true`.

- Storage backends
  - S3 (preferred): enabled when `STORAGE_ENDPOINT` is set. Uses `@aws-sdk/client-s3` with credentials from `STORAGE_*` envs. Files are written as `<phone>/profile-pictures/<pn>.jpg` and also `<phone>/profile-pictures/<lid>.jpg` when a stable LID/user id is known; groups use the group JID.
  - Filesystem: default when no S3 endpoint is configured. Files are stored under `<baseStore>/medias/<phone>/profile-pictures/<pn-or-lid>.jpg`.

- URLs returned to webhooks
  - S3: A preÃ¢â‚¬â€˜signed URL is generated per request using `DATA_URL_TTL` (seconds). Link expires after TTL.
  - Filesystem: A public URL is generated from `BASE_URL`, using the download route: `BASE_URL/v15.0/download/<phone>/profile-pictures/<canonical>.jpg`.
  - First fetch: the provider URL is persisted before enrichment; webhooks receive the Uno storage URL, never the temporary Zapo CDN URL.

- Lifetime and cleanup
  - `DATA_TTL` Ã¢â‚¬â€ Default retention for stored media (including profile pictures) in seconds. Default 30 days.
  - When S3 is enabled and AMQP is configured, the service enqueues a timed job to delete the object after `DATA_TTL`.
  - For filesystem storage, cleanup is performed directly in the local media path.

- Integration points (high level)
  - The client enriches outgoing webhook payloads with:
    - Contact: `contacts[0].profile.picture`
    - Group: `group_picture`
  - The data store resolves a cached URL when available; otherwise it queries WhatsApp (`profilePictureUrl`), persists to storage, and returns a URL.

- Required configuration
  - For S3: `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET_NAME`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, and optionally `STORAGE_FORCE_PATH_STYLE`.
  - For filesystem: ensure `BASE_URL` points to a publicly reachable domain so that `/v15.0/download/...` links work for webhook consumers.

- `FETCH_TIMEOUT_MS` Ã¢â‚¬â€ Timeout for media HEAD/download checks. Default per code.
  - Increase when sending large media from slow servers.
  - Example: `FETCH_TIMEOUT_MS=15000`
- `SEND_AUDIO_MESSAGE_AS_PTT` Ã¢â‚¬â€ Mark outgoing audio as PTT (voice note). Default `false`.
  - Use when clients expect voice notes with waveform.
  - Example:
    ```env
    SEND_AUDIO_MESSAGE_AS_PTT=true
    CONVERT_AUDIO_MESSAGE_TO_OGG=true
    ```

## Proxy

- `PROXY_URL` — SOCKS proxy shared by Baileys and Zapo. Zapo applies it to
  the WhatsApp WebSocket, media CDN upload/download and link-preview fetches.
  - Example: `PROXY_URL=socks5://user:pass@proxy.local:1080`

## Zapo outbound IP family

- `ZAPO_NETWORK_IP_FAMILY` — global policy for Zapo outbound channels. Default:
  `auto`. Accepted values: `auto`, `ipv6first`, `ipv4first`.
- `ZAPO_CHAT_SOCKET_IP_FAMILY` — optional WhatsApp WebSocket override.
- `ZAPO_MEDIA_UPLOAD_IP_FAMILY` — optional media CDN upload override.
- `ZAPO_MEDIA_DOWNLOAD_IP_FAMILY` — optional media CDN download override.
- `ZAPO_LINK_PREVIEW_IP_FAMILY` — optional link-preview HTTP(S) override.

An empty channel override inherits `ZAPO_NETWORK_IP_FAMILY`. `ipv6first` and
`ipv4first` only change address order: Node family autoselection remains enabled,
so the alternate family is retained as a connection fallback. `auto` creates no
custom agent and preserves the previous runtime path exactly. Invalid values stop
the Zapo session startup with an explicit configuration error.

```env
# Prefer IPv6 on every direct Zapo channel, with IPv4 fallback.
ZAPO_NETWORK_IP_FAMILY=ipv6first

# Optional exception: keep media download IPv4-first.
ZAPO_MEDIA_DOWNLOAD_IP_FAMILY=ipv4first
```

When `PROXY_URL` is configured, the SOCKS agent remains authoritative for every
channel. In particular, `socks5h` resolves the destination at the proxy, so local
family-order settings cannot force the proxy's DNS result or egress family.

## Webhooks & Notifications

- `WEBHOOK_SESSION` Ã¢â‚¬â€ Receive session notifications (QR, status) via HTTP.
  - Use to integrate with external systems (e.g., show QR in another UI).
  - Example: `WEBHOOK_SESSION=https://hooks.example.com/uno/session`

## Examples by Scenario

- Local development with filesystem store only:
  ```env
  PORT=9876
  LOG_LEVEL=debug
  ```
- Dev with Redis + MinIO + RabbitMQ (compose defaults):
  ```env
  BASE_URL=http://web:9876
  REDIS_URL=redis://redis:6379
  AMQP_URL=amqp://guest:guest@rabbitmq:5672?frameMax=8192
  STORAGE_ENDPOINT=http://minio:9000
  STORAGE_BUCKET_NAME=unoapi
  STORAGE_ACCESS_KEY_ID=minioadmin
  STORAGE_SECRET_ACCESS_KEY=minioadmin
  STORAGE_FORCE_PATH_STYLE=true
  ```
- Headless pairing:
  ```env
  CONNECTION_TYPE=pairing_code
  ```

## Ready-to-use examples

- English: /docs/examples/.env.example.en
- PortuguÃƒÂªs (Brasil): /docs/pt-BR/exemplos/.env.exemplo



### Id Mapping (Baileys -> Unoapi)

To keep a stable Unoapi id for the same Baileys message under retries or concurrent consumers, the service uses a Redis SET NX guard when persisting idBaileys -> idUno. This prevents multiple unoapi-id_rev entries for the same message when races occur.
### Zapo e caches temporais

| Variavel | Padrao | Uso |
|---|---:|---|
| `STATUS_RECIPIENT_RETENTION_SEC` | `2592000` | Retencao de destinatarios recentes de Status |
| `CONTACT_INFO_TTL_SEC` | `2592000` | Expiracao do cache legado de contatos |
| `ZAPO_REDIS_MESSAGES_TTL_MS` | `2592000000` | TTL do store oficial de mensagens Zapo |
| `ZAPO_REDIS_THREADS_TTL_MS` | `2592000000` | TTL do store oficial de threads Zapo |
| `ZAPO_REDIS_CONTACTS_TTL_MS` | `2592000000` | TTL do store oficial de contatos Zapo |
| `ZAPO_REDIS_KEY_PREFIX` | `unoapi:zapo:` | Namespace exclusivo do store oficial Zapo; o valor legado `unoapi-zapo:` e convertido automaticamente |
| `ZAPO_REDIS_MAINTENANCE_INTERVAL_MS` | `3600000` | Intervalo da remocao incremental de IDs vencidos dos indices de mensagem |
| `ZAPO_SESSION_LEASE_TTL_MS` | `60000` | Validade da posse distribuida de uma sessao por worker |
| `ZAPO_SESSION_LEASE_RENEW_MS` | `20000` | Renovacao da posse; o runtime limita o intervalo a metade do TTL |

Layout das chaves:

- `unoapi:zapo:*`: store oficial da Zapo. Mensagens, threads e contatos possuem TTL por dominio; auth, estado criptografico e privacidade permanecem persistentes. A atualizacao remove TTLs antigos desses dominios antes de abrir o socket; veja [migracao de persistencia](zapo-state-persistence.md).
- `unoapi-lease:zapo-session:<sessao>`: trava distribuida. Somente um worker abre o socket ou conduz o novo pareamento da sessao.
- `unoapi-status-recipients:<sessao>`: um sorted set temporal por sessao, sem criar uma chave por contato.
- `unoapi-zapo-username-lid:<sessao>` e `:seen`: hash de aliases mais sorted set de expiracao por campo.
- `unoapi-id*`, status e media: contratos publicos Uno compartilhados pelos dois motores.

O indice oficial `msg:idx` e limpo incrementalmente porque o TTL do sorted set de uma conversa ativa pode ser renovado enquanto hashes de mensagens antigas ja expiraram. Se a renovacao da trava falhar, o worker Zapo desconecta de forma conservadora para evitar dois sockets na mesma conta. Todos os runtimes e replicas Zapo exigem Redis; SQLite permanece apenas como codigo de migracao/compatibilidade e nao e um modo de execucao suportado.
