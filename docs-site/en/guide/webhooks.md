# Webhooks

## Status replies with media context

For Zapo sessions, incoming replies to the session's own image/video status
attempt media recovery before webhook delivery. The worker reuses stored media
or downloads through the active Zapo client and persists it in configured
storage. No WhatsApp message is sent and the status is not modified.
Ownership accepts a phone JID or LID. A LID is checked only against the native
contact record stored in the same Zapo session: its associated phone must match
the session phone. Unknown/foreign LIDs are rejected; lookup failures do not
block the reply. No WhatsApp network lookup is performed for this check.

The original reply retains its text, identity and ID. Its `context.status`
contains `id`, `type`, `available`, `caption` and, when recovered, `media.url`,
`media.mime_type` and `media.file_name`. For Chatwoot/ViperChat destinations
recognized by the existing adapter, two sequential POSTs carry one message each:

1. Status image/video labeled “Status publicado por você”, with a stable
   `status-media-<hash>` ID scoped to session, status and contact/conversation.
2. The original reply, with `context.id` and `context.message_id` referencing
   that synthetic parent. The parent does not quote or repeat the reply.

The existing receiver can render this using its quote/reply support; no
ViperChat change is required. Other webhooks receive only the enriched reply.
Existing credentials, filters and webhook/media authentication are unchanged.

Retries and further replies to the same status in the same chat reuse the
parent ID; receivers must deduplicate by ID. HTTP 2xx confirms acceptance, not
the processing order of the receiver's internal jobs. HTTP failures use normal
delivery retries without generating fresh IDs.

Missing/expired media or recovery failures do not block the reply: context has
`available=false` and no media bubble is emitted. View-once/protected ephemeral
content and third-party statuses are not recovered. Recovery depends on an
active client and quote/store data still being available. No historical chat
replay occurs automatically. Both worker and delivery adapter need updating;
local changes do not deploy this behavior to production.

## Canceling queued deliveries

Removing or disabling a session message webhook prevents pending deliveries
when updated consumers process them. Before fan-out and dispatch to HTTP/CB,
the worker reads persisted Redis configuration directly and checks the ID,
effective URL and enabled state. Removed, disabled or replaced bindings finish
with ACK, without HTTP, retries or dead-letter publication. Changing a URL
does not redirect old events to its replacement.

Valid bindings use current credentials, timeouts and filters. Newly added
destinations do not receive older queued fan-outs. An explicit `webhooks: []`
does not revive the environment default; legacy sessions without the property
still inherit environment configuration.

This applies to live and history queues, including retries. Transcription also
checks `sendTranscribeAudio` before downloading/processing audio and again after
processing, before publishing the result. Redis read failures remain retryable
errors, not evidence of removal. Drop logs include the session, ID and a
classified reason, never the URL, token or message contents.

Limits: already started HTTP or AI requests cannot be canceled. Existing dead
letters/quarantined items are not deleted. Separate session-lifecycle and VoIP
webhooks are unchanged. Removing then recreating the same ID and URL before
the next read is not distinguishable. No route or permission is added; source
publication alone does not deploy this behavior to production.

## Forwarded messages

When the current message received through Zapo carries
`contextInfo.isForwarded=true`, ViperConnect emits `context.forwarded=true` in
`entry[].changes[].value.messages[]`. Partial message example:

```json
{
  "type": "text",
  "text": { "body": "Received message" },
  "context": { "forwarded": true }
}
```

This is an additive, automatic change with no extra configuration or permission
beyond the existing webhook. The shared converter handles text, media, groups
and normalized wrappers. History/replay messages passing through that converter
retain the marker when present in stored content. No network lookup fills
missing metadata and previously delivered webhooks are not updated retroactively.

- Only boolean `true` is emitted. An absent marker is not proof of original authorship.
- `context` may contain only `forwarded`, without a reply `id` or `message_id`.
- Reply references retain `context.id`, `message_id` and optional
  `provider_message_id`. Forwarding flags on quoted content do not mark the reply.
- Delivery statuses do not gain this context. This does not mark ordinary sends
  as forwarded or prepend a label to the text.
- Neither `forwardingScore` nor `frequently_forwarded` is emitted by this contract.
  Do not infer counts, original authors, conversation chains or a “frequently forwarded” badge.

The Portuguese receiver handoff is maintained in the repository at
`docs/WEBHOOK_FORWARDED_CONTRACT.md`.

Connection events use a separate [session lifecycle contract](./session-webhooks).

## Original transport message ID

In the Zapo runtime, `provider_message_id` is **optional, additive correlation
metadata**. Existing message, echo, status, reference and media IDs and API
responses stay unchanged. Never replace the UnoAPI ID with this field when
sending, quoting, editing or deleting messages.

**Typebot:** webhooks marked as Typebot do not receive this field, including
context, reaction and status objects. It is removed only from that destination's
copy; ViperChat and other webhooks retain the metadata. Existing Typebot event
filters remain unchanged.

| Object | Meaning of `provider_message_id` |
| --- | --- |
| `value.messages[]` / `value.message_echoes[]` | Original message/event ID |
| `value.statuses[]` | Original ID of the message whose status changed |
| `message.context` | Original ID of the quoted or edited message |
| `message.reaction` | Original ID of the reaction target |

Deletion uses the existing `statuses[].status: "deleted"` contract: both `id`
and the new field refer to the **deleted message**, not the deletion event.
For edits, the message ID identifies the event; context identifies the target.

```json
{
  "id": "UNOAPI_EVENT_UUID",
  "provider_message_id": "PROTOCOL_EVENT_ID",
  "type": "text",
  "message_type": "message_edit",
  "text": { "body": "Corrected text" },
  "context": {
    "id": "ORIGINAL_UNOAPI_UUID",
    "message_id": "ORIGINAL_UNOAPI_UUID",
    "provider_message_id": "ORIGINAL_PROTOCOL_ID"
  }
}
```

Treat the value as an opaque string. Do not truncate, change case or add a `wamid`
prefix. Cross-transport correlation still requires production validation.
The ID is captured before UUID conversion and travels through normal webhook
delivery and retries. Queues, filters and sending rules are unchanged.
It is omitted without a proven original ID, including synthetic call notices,
failures before confirmation and old events. Previously delivered events are not
replayed; consumers must accept payloads without the field.
API sends are confirmed asynchronously by the worker: the additional ID arrives
in the corresponding echo/status, not the API enqueue response.

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
