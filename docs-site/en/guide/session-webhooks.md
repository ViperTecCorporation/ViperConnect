# Session lifecycle webhooks

The **Webhooks de sessões** dashboard page manages centralized destinations for
Redis-backed Zapo sessions. These events are independent from message webhooks,
`sendConnectionStatus`, WhatsApp presence and VoIP forwarding.

## Management API

All operations require the global `UNOAPI_AUTH_TOKEN` as `Authorization: Bearer ...`.
Session tokens cannot administer destinations. Receiving webhooks does not require
giving the receiver your global API token.

| Method and path | Result |
| --- | --- |
| GET `/admin/session-webhooks` | `{ "destinations": [...] }`, secrets redacted |
| POST `/admin/session-webhooks` | Create, 201 |
| PUT `/admin/session-webhooks/{id}` | Replace non-secret configuration, 200 |
| DELETE `/admin/session-webhooks/{id}` | Delete destination only, 204 |
| GET `/admin/session-webhooks/states` | Latest observations; optional `destination_id` filter |

Required configuration fields: `name`, HTTP(S) `url`, `server`, `enabled`,
`session_ids`, `auto_include_new_sessions`, `events`. Optional `signing_secret`
enables HMAC and must contain at least 32 characters when non-empty. Omitting it
on creation sends unsigned webhooks. Optional `bearer_token` independently adds
Bearer authentication. Omitted secrets are preserved on PUT; an empty string
removes the corresponding secret. The panel offers **Remover assinatura HMAC**.
Responses expose `has_bearer_token` and `has_signing_secret`.

Select existing sessions explicitly. Auto-enrollment affects only future Zapo
sessions created on that server. Turning it off while preserving `session_ids`
keeps existing membership. This boundary is a UnoAPI server, **not a ViperChat
account**: use explicit selection or separate servers for different integrations.
Deleting a session snapshots its recipients before removing memberships.
Recreating it resets the previous snapshot to `unavailable` with reason
`session_registered_pending_observation`, until a fresh worker observation;
this initial state does not emit an outage alert.

Editing invalidates pending deliveries from the prior revision. Disabling or
deleting also cancels subsequent attempts, but an in-flight HTTP request may
finish. Reconcile via the states endpoint. Limits: 100 destinations, 1,000 sessions
each; `heartbeat_interval_seconds` defaults to 300 and accepts 60–86,400.

## Payload v1

Fields: `schema_version: 1`, `event_id`, `event`, `occurred_at`, `destination_id`,
`session: {id,label,provider,server}`, `state: {previous,current,changed_at,sequence}`,
`connection: {reason,code,is_logout,intentional,reconnect_expected,requires_pairing}`,
`last_verified_at`, `last_observed_at`. Dates are ISO 8601 UTC, unknown fields are
null. No message content, credentials, QR or pairing codes are included.

| Event | Meaning |
| --- | --- |
| `session.connected` | Provider opened connection or local observation resumed |
| `session.disconnected` | Connection closed; unlinking is not established |
| `session.unlinked` | Provider reported logout; pairing required |
| `session.removed` | UnoAPI configuration removed |
| `session.unavailable` | Connected worker observation missing for over 120 seconds |
| `session.heartbeat` | Optional local snapshot while the worker considers itself connected |

Heartbeats do not refresh `last_verified_at`: a worker observation is not proof of
a remote WhatsApp response. Reconnection expected does not guarantee success.
No observation does not mean disconnected. Removed tombstones are available in
unfiltered state queries, but no longer belong to destination membership filters.

## Security and delivery

UnoAPI generates the signature only when a signing secret is configured.
Without it, no signature header is sent; timestamp and event ID remain present.
When enabled, verify `X-ViperConnect-Signature: sha256=<hex>` as HMAC SHA-256 over
`X-ViperConnect-Timestamp + "." + original_UTF8_body`, using the signing secret.
Timestamp is Unix seconds, refreshed per attempt. Use a constant-time comparison
and a five-minute acceptance window. `X-ViperConnect-Event-Id` repeats the payload ID.
HTTPS is recommended. Redirects are rejected; internal URLs require trusted admins.

Deduplicate `(destination_id,event_id)`, apply only increasing `state.sequence`,
and acknowledge with 2xx after durable acceptance. Duplicates and out-of-order
delivery are possible. Redis outbox publication is confirmed into the dedicated
`<prefix>.session.events` RabbitMQ queue; prefetch 2, HTTP timeout 10 seconds,
existing retry/dead-letter policy, no automatic dead-letter recovery.

This is not zero-loss delivery: a process crash before persistence or a Redis
outage may lose a transition. Monitor `SESSION_LIFECYCLE_PERSIST_FAILED` and
`SESSION_WEBHOOK_OUTBOX_RETRY`. A stopped broker also stops monitoring/delivery;
use external monitoring for a whole-installation outage.

See complete schemas in the [HTTP reference](/en/api-reference).
