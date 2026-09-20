# Message webhook history and restoration

## Read-only Redis preview

Administrators can inspect snapshot IDs, dates, reasons, servers, enabled events
and destination origins in the Redis browser. URL paths, queries, fragments,
credentials and headers are never returned. Invalid records are not exposed as
raw text. These responses include `readOnly: true`; edits and deletions, including
subtree deletion, return HTTP 403 (`redis_key_read_only`). Restore snapshots through
the session Webhooks screen instead. This preview does not change stored records.

Redis-backed sessions retain up to **20 previous webhook configurations per phone**
under `unoapi-webhook-history:<phone>`, without expiration. This is separate from
WhatsApp authentication and centralized session lifecycle destinations.

Before configuration replacement or removal, the previous webhook list is copied
and submitted for background archival. Restoration also archives replaced configuration.
Ordinary connection, reconnection, QR and pairing flows do not wait for this feature.
New sessions and unchanged webhook lists do not create snapshots.

Archival failures only log `WEBHOOK_HISTORY_ARCHIVE_FAILED`, without secrets or user
alerts. Removal continues. Limits are 100 pending writes per process and 256 KiB per
snapshot. This is best-effort: Redis failures, overload or process termination may
lose a snapshot. Failed configuration updates may leave an archived prior version.
There is no atomic guarantee between archival and the original operation. Previously
deleted configurations cannot be recovered retroactively.

## Dashboard

Open the session **Webhooks** tab to load historical versions. Select webhook IDs from
one snapshot and confirm. Restoration preserves IDs and credentials but always leaves
the selected webhooks **disabled**. Review their destinations before enabling them.
Existing IDs conflict unless explicit replacement is authorized; unselected webhooks
are preserved. Restoration does not resend old messages or reconnect the session.

## Administrative API

Both routes require the global `UNOAPI_AUTH_TOKEN` in the Bearer header; session tokens
are rejected. Phone numbers must contain 5–20 digits; aliases are not resolved.

- `GET /admin/webhooks/history/{phone}` returns `{ "snapshots": [...] }`, including
  after session removal. Each snapshot has `id`, `archived_at`, `reason`, `server` and
  `webhooks`. Reasons are `updated`, `removed`, `restored`. Webhook previews contain
  `id`, `destination` (URL origin only), `has_credentials` and enabled `send*` flags in
  `events`. No tokens, headers, URL paths, queries or user information are returned.
- `POST /admin/webhooks/history/{phone}/restore` requires an existing session on the
  same server as the snapshot. It atomically compares configuration before writing,
  preserves TTL and invalidates configuration caches without reload/logout.

```json
{ "snapshot_id": "snapshot-id", "webhook_ids": ["chatwoot"], "replace_existing": false }
```

Success returns `{ "restored": ["chatwoot"], "enabled": false }`.
Errors: `400` invalid selection, `403` unauthorized, `404` missing session/snapshot,
`409` ID conflict, server mismatch or concurrent configuration change, `503` unavailable.
Refresh before resolving conflicts; do not automatically retry with replacement enabled.

## Security and scope

Snapshots contain only allowed webhook fields, never session authentication, QR or
pairing codes. Full delivery URLs and credentials remain in Redis; protect ACLs,
backups and server access. This is not a separately encrypted vault. Generic Redis
dashboard inspection masks archived values. History access is global-administrator-only.

The boundary is the administrative installation, phone and server, not an implicit
ViperChat tenant. Reused numbers require administrator judgment before restoration.
Retention limits versions per phone, not the total number of archived phones.
Non-Redis sessions, centralized lifecycle destinations and old messages are outside scope.

Tests cover authorization, redaction, conflicts, disabled restoration, TTL, concurrency,
retention and failure isolation. Real Lua tests are opt-in against disposable localhost
Redis only, never production.

See [message webhooks](/en/guide/webhooks) and [session events](/en/guide/session-webhooks).
