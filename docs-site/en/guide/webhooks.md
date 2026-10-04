# Webhooks

Connection events use a separate [session lifecycle contract](./session-webhooks).

## View-once media

Incoming image, video and audio messages include `message_type: "view_once"`
inside `value.messages[]` when identified as view-once. The existing `type`,
UnoAPI ID and media object are preserved. This ViperConnect extension is not
an edit or a later event: it adds neither edit context nor `edit_timestamp`.
Existing reply context remains unchanged.

Detection uses the original media's `viewOnce: true` or `viewOnceMessage`,
`viewOnceMessageV2`, and `viewOnceMessageV2Extension` wrappers before unwrapping.
There is no extra Redis lookup, media download or duplicate notification.
Ordinary messages, quoted view-once content and disappearing messages alone
are not marked. Unavailable media keeps the existing fallback; this does not
recover content or automatically replay previously delivered webhooks.

```json
{
  "id": "ORIGINAL_UNOAPI_ID",
  "from": "5566996269251",
  "timestamp": "1790672409",
  "type": "image",
  "message_type": "view_once",
  "image": {
    "id": "5566936183915/ORIGINAL_UNOAPI_ID",
    "mime_type": "image/jpeg",
    "url": "https://example.test/media.jpg"
  }
}
```

Consumers should persist the flag, show a view-once notice and deduplicate by
the normal message ID. Do not process it as an edit or wait for another event.
Avoid automatic previews until a viewing policy is defined. This metadata does
not enforce single access: existing storage and media URLs remain unchanged.

## Blacklist and history isolation

`POST /{phone}/blacklist/{webhook_id}` accepts phone numbers, `@s.whatsapp.net`,
`@lid` and `@g.us`. TTL is in **seconds**: positive expires, negative persists,
zero or omitted removes. Phone/LID aliases are matched only within the same session's
known contact mapping. Groups are independent from their participants. Legacy keys
remain effective as new events arrive; no re-registration is needed. HTTP success
acknowledges enqueueing when using AMQP, not immediate blacklist application.

History processing, delivery and transcription have dedicated queues with two
consumers per process/stage. Existing payloads and filters stay unchanged; live
messages may overtake history. CPU, network and Redis remain shared. AMQP publisher
confirms gate consumer ACKs, not WhatsApp delivery; duplicates remain possible.
VoIP audio/control do not go through this publication path.

Each session may have multiple independent destinations. Configure the URL,
authorization header, token, timeout and event switches in the Manager.

The common event envelope follows this structure:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "messages": []
      }
    }]
  }]
}
```

Media persisted by ViperConnect keeps both `id` and `url` for compatibility.
Consumers should prefer the authenticated download flow by ID when available.
Profile pictures additionally provide a stable `picture_id` and cache
information.

Interactive replies preserve their original context. Button and list replies
are sent as replies to the originating message and must not prepend an agent
name. Delivery statuses are normalized and lower-rank or repeated updates are
discarded.

Use the outgoing blacklist TTL to suppress selected follow-up events for a
recipient without disabling the entire webhook.
