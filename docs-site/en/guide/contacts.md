# Contacts

## Recover a contact's encryption {#recover-contact-encryption}

In the session's **Contacts** tab, click **Recover encryption** on the affected
contact and confirm the warning. Use only when investigating encryption failures
such as “Waiting for this message”, not merely an offline recipient or a missing
delivery receipt.

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
