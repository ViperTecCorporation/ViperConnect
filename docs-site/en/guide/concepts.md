---
title: How the API works
description: The minimum mental model for sessions, identities, messages, media and webhooks.
---

# How the API works

These five concepts explain the message path without requiring knowledge of the
internal implementation.

## 1. A session is one connected account

The `{phone}` route value identifies the session carrying traffic; it is not the
message recipient.

```http
POST /v15.0/{session}/messages
```

- `{session}` is the connected account;
- `to` is the destination conversation;
- `version` preserves the HTTP contract version.

### WhatsApp version and reconnection

ViperConnect selects the initial WhatsApp Web version: the session's Manager
value → owning worker's `ZAPO_WEB_VERSION` → code default `2.3000.1054816457`.
A blank Manager value inherits the worker; an unset/blank ENV inherits code.
This is neither the product's `4.x` version nor the HTTP `v15.0` prefix.

`recoverFromClientTooOld:true` lets Zapo fetch the current version from
`https://web.whatsapp.com/sw.js` only after `405/failure_client_too_old`, then
reconnect the same client. The override lasts one attempt and does not update
Manager, ENV or credentials; a new instance starts with the configured version.
The manual value is therefore an initial version, not an absolute pin. Recovery
does not guarantee future protocol compatibility or fix fetch/parser failures.

ViperConnect retains its lease and generation for at most 45s, permits one SDK
connection attempt per episode and does not start a competing client. Each
connect revalidates ownership, configuration and storage state. Manual disconnect,
logout, migration and lease loss prevent a late recovery from reopening the
socket. If recovery does not complete, normal cleanup discards the client and
waits at least 60s before retrying. An outstanding SDK fetch may finish, but
cannot authorize connecting a discarded client.

Saving the Manager version uses the existing reload flow and may reconnect the
session/interrupt calls; HTTP success does not confirm Online. Only Web accepts
overrides (3–5 numeric parts, at most 54 characters); invalid values are rejected
without silent fallback. `ZAPO_CONNECTION_POLICY` logs the initial version and
owner. Mobile Primary retains `deviceInfo.appVersion` and its previous policy,
without Web ENV or automatic Android versions on iOS credentials. This error
does not justify deleting credentials, SQLite or pairing again.

## 2. The token authenticates the installation

```http
Authorization: Bearer YOUR_TOKEN
```

Never place tokens in query strings, logs or public examples. The
[interactive API](/en/api-reference) lets you edit the URL and token locally.

## 3. One person may have multiple identity forms

The phone number is useful for display and compatibility. When available,
`user_id` is the canonical identity. `username` is an optional alias.

```json
{
  "to": "15557654321",
  "user_id": "273877414502425@lid",
  "username": "maria",
  "type": "text",
  "text": { "body": "Hello" }
}
```

Resolution prefers a valid `user_id`, then the local identity cache, then a
network lookup only when needed. See [Identities and contacts](/en/guide/contacts).

## 4. Request acceptance and delivery are different moments

HTTP `200` from `/messages` means the request was accepted. Final state arrives
asynchronously in the webhook.

| Moment | Observe | Meaning |
| --- | --- | --- |
| accepted | HTTP response | valid payload and send started |
| sent | `statuses[].status = sent` | message published |
| delivered | `delivered` | destination device received it |
| read or played | `read` or `played` | recipient confirmation |
| failed | `failed` with `errors[]` | final error to record |

Store the returned ID and correlate later status events with it.

## 5. Media has a source, persistence and download path

Use exactly one outgoing source: `link`, `id` or the ViperConnect `base64`
extension. For persisted incoming media, webhooks keep both `id` and `url` for
compatibility. New consumers should prefer the ID and the API download route
instead of coupling directly to a storage bucket.

```text
HTTP client
   | authenticate, register and send
   v
ViperConnect API -> queue -> session worker -> network
   ^                                      |
   | normalized webhook                   | events and receipts
   +--------------------------------------+
```

Heavy work such as video preparation can run in a dedicated worker without
blocking regular messages. Valkey stores state and indexes; RabbitMQ transports
jobs and retries.

Core payloads follow a Cloud API-compatible shape. ViperConnect-only features
are marked as extensions and do not replace the existing URL or ID contracts.
Use guides to learn flows and the [interactive API](/en/api-reference) for exact
schemas and responses.

