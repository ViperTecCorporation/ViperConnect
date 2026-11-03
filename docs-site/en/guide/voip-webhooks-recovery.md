# VoIP REST recovery and diagnostics

Webhooks deliver realtime events. REST lets ViperChat recover missed or unprocessed events. Both paths use the same event persisted by the producer and update the same call without duplicating calls, notes or attachments.

See [integration setup](/en/guide/voip-webhooks) and the [events and states reference](/en/guide/voip-webhooks-contract).

## Configure recovery

Select the `viperconnect` integration in the ViperChat VoIP service and set:

| Field | Value |
| --- | --- |
| `history_api_url` | VoIP service HTTPS base URL, without appending `/voip-api`. Not the Manager URL. |
| `history_api_token` | PBX `VOIP_SERVICE_TOKEN`, used as Bearer. |
| `history_company_id` | Exact producer company ID; may be a UUID. Never infer it from a phone. |

Account, service and source must match the webhook configuration. The company/integration must be enabled, and current extension associations must authorize the events.

Without an explicit company, recovery reports `configuration_required` rather than making a global query. A service configured only as `webhook` reports REST recovery as `unsupported` while webhook reception remains available.

REST credentials stay on the server, not in the browser. Operators may allow an exact private HTTPS origin using ViperChat's `VOIP_TRUSTED_SERVICE_ORIGINS`. This comma-separated list accepts origins such as `https://host:port` without path, credentials, query or fragment, and defaults to empty. It does not bypass TLS, allow redirects or justify globally expanding `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`.

## Query events

```text
GET /v1/console/history?sync=webhook_events&company_id=company-a&account_id=1&service_id=206&source_instance_id=pbx-company-a&limit=100
Authorization: Bearer <VOIP_SERVICE_TOKEN>
```

| Parameter | Required | Rule |
| --- | --- | --- |
| `sync` | Yes | `webhook_events`. |
| `company_id` | Yes | VoIP company ID. |
| `account_id` / `service_id` | Yes | ViperChat account and service. |
| `source_instance_id` | Yes | Stable source configured at both ends. |
| `limit` | No | Integer 1–100; defaults to `100`. |
| `cursor` | No | Opaque previous-page cursor, up to 2048 bytes. |

Do not mix ordinary history search/date/pagination parameters into this mode. `sync=changes` returns call records, not this integration's canonical envelopes.

### Response and pagination

```json
{
  "version": 1,
  "phase": "snapshot",
  "scope": {
    "company_id": "company-a",
    "account_id": "1",
    "service_id": "206",
    "source_instance_id": "pbx-company-a"
  },
  "items": [],
  "nextCursor": "opaque-signed-cursor",
  "hasMore": false
}
```

This example is an empty page. Each populated item contains `sequence` and `webhook_event`. The event is the complete originally persisted outbox envelope, identical to webhook delivery; `sequence` equals `revision`.

1. Omit the cursor initially to start a retained-event `snapshot`.
2. Safely persist the page before saving `nextCursor` as the checkpoint.
3. Repeat all scope filters and send `cursor=<nextCursor>` on later requests.
4. Follow `hasMore`, not the number of returned items. Once caught up, keep polling with the returned cursor in the `changes` phase.

Responses are not cached. Empty pages also provide valid cursors. Pages are capped at 100 items and 1,500,000 bytes of events, so fewer items may be returned. Revisions need not be consecutive for a company.

Cursors are signed and bound to instance, company and destination. Envelope preparation and checkpoint calculation are atomic: a cursor cannot advance past unprepared events. If preparation exceeds the per-request limit, the API returns `503` for a retry.

### ViperChat consolidation

ViperChat persists an encrypted cursor, configuration fingerprint and temporary processing lease per service. Recovery is scheduled every minute. Configuration and lease are rechecked before persisting a page.

Inbox entries and checkpoint are saved in the same transaction. Processing jobs are queued afterwards; a scanner recovers records left without jobs after failure. An individual webhook does not advance the REST cursor.

Both paths use the same reconciler: deduplicate by service/source/`event_id`/`revision`, preserve `call_id` and ignore stale revisions. Replaying history does not repeat SIP actions or ring completed calls.

### Errors and coverage gaps

| Response | Action |
| --- | --- |
| `400` | Correct query, limit or cursor. Never silently discard the checkpoint. |
| `401` / `403` | Review token, company and permissions; do not retry indefinitely. |
| `409` | Review changed scope/destination without mixing installations. |
| `410` | Expired cursor. Reconcile a fresh retained snapshot and record the gap (`gap_detected`), without deleting local history. |
| `422` | Individual event too large; requires diagnosis. |
| `501` | Storage lacks the SQLite outbox required by this flow. |
| `503`, other `5xx` or network errors | Back off and retry without advancing the cursor. |

The feed covers only retained, authorized events since activation. Missing items do not authorize local deletion. Data outside retention cannot be reconstructed through this API. Configuration changes require revalidation; never redirect old work to another destination.

## Diagnostics and replay

Producer and receiver provide separate operations. Replay cannot change the destination, override authorization or replace missing conversation-binding evidence.

### VoIP service

These routes require service Bearer authentication and a single company. Manager access requires an administrator.

```text
GET /v1/console/companies/:companyId/viperchat-webhook/diagnostics?status=all&limit=50
POST /v1/console/companies/:companyId/viperchat-webhook/replay
```

Diagnostics accepts `status` values `all`, `pending`, `published`, `delivering`, `dead`; `limit` is 1–100, default 50. It returns counts and pending-entry technical metadata without payloads, phone numbers, audio or credentials.

Replay request:

```json
{
  "confirm": true,
  "requestId": "d1957969-33e7-49be-955c-e83fafc06e71",
  "eventIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
}
```

Provide 1–20 distinct event IDs and a new UUID per operation. Retrying the same operation uses the same UUID/IDs without scheduling twice. The batch is atomic and audited; reusing its UUID with different IDs causes a conflict.

The server preserves the envelope, IDs, destination and attempt count. An exhausted failure gets one further attempt and may return directly to `dead`. Delivered events, active delivery leases, changed/disabled destinations or altered authorized extension bindings can return `409`. Scheduling does not confirm ViperChat delivery.

### ViperChat

Routes are under `/api/v1/accounts/:account_id/voip/services/:service_id` and require an account administrator using ViperChat API authentication.

| Route | Purpose |
| --- | --- |
| `GET /diagnostics` | Counts, up to 25 pending/failed events and 25 artifacts, truncation indicator and recovery state, without content or credentials. |
| `POST /reprocess` | `{"kind":"event","record_id":123}` or `{"kind":"artifact","record_id":123}`; returns `202` with `queued`. |
| `POST /recover_history` | Request REST recovery using `{"reset_cursor":false}`. Use `true` only after explicit confirmation to reread retained events. |

Reprocessing preserves IDs, content, conversation binding and downloaded files. It rejects completed records, another account/service, changed sources, disabled services and repeats within 30 seconds. Operator/time are audited. Failed events/artifacts stop after eight attempts.

## Durable delivery and queues

The VoIP service persists the change and outbox in the same SQLite transaction. RabbitMQ carries only the outbox ID, never the full payload or token. Publishing is persistent and confirmed; consumers acknowledge only after safely handling delivery, retry or permanent failure.

The same event may arrive more than once. Consumers check current destinations and require matching JSON receipts. Changing installation/account/service/source quarantines incompatible work. Rotating the token for the same integration preserves events.

Transport uses eight attempts, prefetch 4 and a 15-second HTTP timeout. Receipts are limited to 16 KiB. Exponential backoff starts at 30 seconds with 0.75–1.25 jitter, a 15-minute exponential cap and `Retry-After` capped at one hour. Delays are grouped into 1 s, 5 s, 30 s, 1 min, 2 min, 5 min, 15 min and 1 h; grouping may lengthen the delay.

The main queues are `viperconnect.voip.webhooks.outgoing` and `viperconnect.voip.webhooks.dead`. Retry deadlines persist in the SQLite outbox; transport uses timed `viperconnect.voip.webhooks.retry.<milliseconds>` queues to wait and redeliver. This flow has no `.delayed` queue. Permanent/exhausted failures enter `dead` without deleting the outbox. There is no automatic dead-queue replay; use confirmed administrative replay.

## Persistence and operational limits

Use SQLite for `CALL_HISTORY_STORAGE` and `VOICE_CONFIG_STORAGE`, with `VOIP_SQLITE_PATH` on persistent storage. Back up before migrations; do not delete databases, volumes or recordings to repair delivery.

Recording expiry is not history deletion: retention preserves IDs/references even after the main call record leaves the catalog. Failed removal keeps the reference for a retry. Active recordings must not be removed.

For private certificates, use a trusted chain, such as one configured through producer-side `NODE_EXTRA_CA_CERTS`. Do not disable TLS or follow redirects to bypass errors. RabbitMQ confirmation, HTTP acceptance and completion of a private note are distinct stages.
