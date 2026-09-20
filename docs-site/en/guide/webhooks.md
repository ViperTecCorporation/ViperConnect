# Webhooks

Connection events use a separate [session lifecycle contract](./session-webhooks).

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
