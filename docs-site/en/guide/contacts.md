# Contacts

## Recover a contact's encryption {#recover-contact-encryption}

In the session's **Contacts** tab, use the affected contact's refresh icon,
labelled **Recover encryption** in its tooltip and accessible name. The label
does not overlap the icon row. Confirm the warning. Use only when investigating encryption failures
such as “Waiting for this message”, not merely an offline recipient or a missing
delivery receipt.

A worker communication failure while listing contacts returns HTTP 503 with
the stable code `contact_directory_unavailable` or `session_storage_worker_unavailable`,
without terminating the web process. Lightweight SQLite queries have a 15s
deadline; expired queued reads are not executed. This does not cancel accepted
writes or automatically recover encryption or replay a message.

```bash
curl -X POST "https://your-domain/15551234567/contacts/recover-crypto" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"000000000000002@lid","confirm":true}'
```

```json
{"success":true,"user_id":"000000000000002@lid","resent":false,"cooldown_seconds":300}
```

- Uses normal API authentication: global token, session token, or a Manager
  credential assigned to this session. Do not use the VoIP service token.
- Requires an already connected Zapo session and a LID in its contact cache.
  Use the exact `user_id` from `GET /{phone}/contacts`, not a phone number,
  username, group or device address.
- Runs on the owning worker and calls the official Zapo 1.11.0
  `message.syncSignalSession(user_id, { force: true })`. Deletes the Signal
  session for that address and fetches a replacement, preserving the identity.
  Does not request an identity change or refresh the device list.
- Does not clear the account, log out, start pairing, resend old messages or
  change other contacts or the custom VoIP plugin. This is not transactional:
  failure after deletion can leave that address pending reconstruction.
  There is no automatic rollback.
- An atomic Redis reservation allows one attempt per session/LID every five
  minutes, including failed attempts. This action is not automatically retried.
- Success confirms that the SDK operation completed, not message delivery or
  recovery of old content. Validate a new send deliberately. Other devices
  may require further investigation.

Errors: `400` invalid LID/confirmation; `401/403` authentication/scope;
`404 contact_not_found`; `409` incompatible provider or disconnected session;
`429 contact_crypto_recovery_cooldown` with `Retry-After: 300`; `502` failed or
unconfirmed operation, including RPC timeout. Timeout does not prove cancellation:
do not retry immediately. Logs `ZAPO_CONTACT_CRYPTO_RECOVERY_STARTED`,
`_COMPLETED` and `_FAILED` contain the session and LID, not keys or message content.

The contacts endpoint returns the cached directory for a Zapo session. Results
are cursor-paginated and use a canonical LID-first identity contract.

```http
GET /15551234567/contacts?cursor=0&limit=100&q=mar
Authorization: Bearer YOUR_TOKEN
```

```json
{
  "contacts": [
    {
      "user_id": "12345678901234@lid",
      "phone_number": "15557654321",
      "username": "maria",
      "name": "Maria"
    }
  ],
  "next_cursor": "100",
  "has_more": true
}
```

`user_id` is the canonical LID, `phone_number` contains digits only and
`username` is optional. A username complements the identity; it does not
replace the phone number or LID. Searches start after three characters in the
Manager.

Contact import is idempotent. When the network confirms a new canonical LID,
the local alias cache is updated and the response returns the resolved value.

## PN/LID mappings and group participant names

`GET /v15.0/{phone}/jidmap/{contact}` reads a phone/LID mapping.
`GET /v15.0/{phone}/jidmap` listing requires `JIDMAP_LIST_ENABLED`; its default
scope is `session`, while `scope=global` reads legacy shared records. Both retain
the route's session authentication and authorization scope.

For SQLite sessions, local records are read on the owning worker; the HTTP
process does not open its database. An absent key is a genuine cache miss.
SQLite/RPC failure, generation changes or an ongoing migration produce explicit
errors (`409` conflicts; `503` unavailability), not a silently incomplete HTTP
`200` listing or stale Redis fallback. Responses do not expose internal diagnostics.

With group-management routes enabled,
`GET /v15.0/{phone}/groups/{groupId}/join_requests` resolves participant names
through cached PN/LID aliases only. It visits at most four distinct identities
and stops cycles, including PN → LID → PN. Unknown names fall back to an already
available username, phone or LID; no identity is fabricated and no WhatsApp
lookup is performed solely to obtain a name. Group permissions, participant
approval and addressing contracts are unchanged.
