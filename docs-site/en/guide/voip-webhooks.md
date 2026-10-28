# Integrate VoIP calls with ViperChat

The integration sends company-scoped extension call events to ViperChat. ViperChat maintains call history and, when configured, receives recordings, transcripts and AI summaries.

Transfer wake uses a separate offer linked to the active call, with no new
configuration/token. See the [rules and limits](/en/guide/voip-webhooks-contract#native-offers-and-transfers-to-an-unregistered-app)
and upgrade the receiver before the producer. This dev extension does not change
the parent state or treat REFER `202` as a confirmed answer.

Use this guide for setup. Technical details are separated into:

- [Events and states reference](/en/guide/voip-webhooks-contract): fields, limits and payload examples.
- [REST recovery and diagnostics](/en/guide/voip-webhooks-recovery): history synchronization, errors and replay.

## Prerequisites

You need administrative access to ViperChat and the ViperConnect Manager, a VoIP service registered in ViperChat, and HTTPS with a valid certificate.

The VoIP service must use SQLite on persistent storage and connect to RabbitMQ through `AMQP_URL`. A non-empty value enables event transport; an absent or empty value disables it. Independent installations must use separate RabbitMQ virtual hosts.

Configuration belongs to a **company**, not a WhatsApp line. Only participants whose extensions belong to that company may be sent to its configured destination. Internal calls do not require a WhatsApp line.

## 1. Register the ViperChat service

In the VoIP service settings:

1. Select the `viperconnect` integration.
2. Set a stable PBX identity in `webhook_source_instance_id`.
3. Save the service and copy its event receiver URL.
4. Obtain the API token of an administrator in that account. Prefer a dedicated technical user.

The URL has this format:

```text
https://chat.example.com/api/v1/accounts/1/voip/services/206/events
```

Keep the source identity unchanged across PBX restarts. Account and service identifiers belong to ViperChat; they are not the VoIP company ID.

## 2. Configure the company in Manager

Open **Telephony → Companies → Edit → ViperChat call events** and select the company webhook mode. The current interface labels may be Portuguese.

Paste the complete ViperChat-generated URL. The form extracts account and service identifiers. Enter the same source identity used in ViperChat, provide the administrator token and enable delivery.

The form accepts a complete URL, but the administrative API stores separate fields inside the company's `viperchatWebhook` object:

```json
{
  "viperchatWebhook": {
    "enabled": true,
    "baseUrl": "https://chat.example.com",
    "accountId": "1",
    "serviceId": "206",
    "sourceInstanceId": "pbx-company-a",
    "apiAccessToken": "<VIPERCHAT_ADMIN_TOKEN>",
    "artifactsDelivery": "webhook"
  }
}
```

| Field | Value |
| --- | --- |
| `enabled` | Enables delivery; defaults to `false`. |
| `baseUrl` | ViperChat HTTPS base URL, without the endpoint path, credentials, query or fragment. |
| `accountId` / `serviceId` | ViperChat account and VoIP service IDs, as positive-integer strings. |
| `sourceInstanceId` | Stable PBX identity, up to 200 characters, matching the receiver configuration. |
| `apiAccessToken` | Token of a ViperChat account administrator. Omitted or blank preserves the stored token. |
| `artifactsDelivery` | `legacy` keeps legacy recording/AI delivery; `webhook` uses the ViperChat processor. Defaults to `legacy`. |

To remove a token, disable delivery and use `clearApiAccessToken: true`. Administrative responses expose `hasApiAccessToken`, never the secret. The server manages `activatedAt`; clients must not change it.

Old line settings remain stored but are not automatically copied into company settings. Webhook artifact mode disables legacy recording and AI-note delivery, including already queued tasks. There is no automatic fallback on failure, preventing duplicates. AI generation and storage remain enabled according to their own settings.

## 3. Check credentials in each direction

| Communication | Authentication |
| --- | --- |
| VoIP service → ViperChat: event delivery | `api_access_token` header with the ViperChat administrator token. |
| ViperChat → VoIP service: history and recording | `Authorization: Bearer <VOIP_SERVICE_TOKEN>` header. |

Do not interchange these tokens or use the extension's SIP password. Event POSTs also require `Content-Type: application/json`. The token must belong to an administrator of the account in the URL; agent/bot tokens and browser sessions do not substitute for it.

HTTPS is mandatory in production. HTTP is only accepted on development/test loopback addresses. With Nginx, check `underscores_in_headers on;` so the proxy preserves `api_access_token`. For a private certificate authority, install a trusted chain rather than disabling TLS verification.

To recover missed deliveries, also configure [ViperChat REST consolidation](/en/guide/voip-webhooks-recovery#configure-recovery).

## What appears in the conversation

Each event contains a complete snapshot of the known call state. ViperChat consolidates events for the same call, preserves extension participants and avoids duplicate records.

In webhook artifact mode, one private note is updated with the available audio, transcript and summary. Audio is fetched separately through the authenticated VoIP API; the event contains neither audio bytes nor an arbitrary download URL.

Optional `call.business_phone` identifies the confirmed external business line, including in legacy artifact mode. Upgrade the ViperChat receiver to accept this field before upgrading the producer.

Opening or reopening conversations is controlled by the ViperChat VoIP service setting and is off by default. When enabled for live incoming calls, it follows the inbox policy. Historical terminal calls and late recording/AI updates do not reopen conversations. Linked inboxes use their primary inbox.

Without reliable phone/contact/conversation evidence, artifacts remain attached to the call pending resolution. Names or similar text are not sufficient evidence. An internal call without an external phone does not automatically create a WhatsApp note. This flow sends no customer messages.

## Verify delivery

1. Open **Companies → Edit → ViperChat delivery diagnostics** in Manager.
2. Inspect delivery states and errors. The panel shows up to 50 recent entries without call content or credentials.
3. Check the call and its updates in ViperChat history.
4. For pending deliveries, follow [recovery and replay](/en/guide/voip-webhooks-recovery#diagnostics-and-replay).

Manager also displays `viperconnect.voip.webhooks.outgoing` and `viperconnect.voip.webhooks.dead` for inspection. Purging queues is not a delivery recovery procedure.

## Integration limits

Webhooks record events; they do not answer, transfer or end calls. Audio and call control remain in SIP/WebRTC and the Zapo bridge. REST recovery covers only retained and authorized source events.

Receiving events while the browser is closed does not guarantee mobile background answering. That requires native integration, such as iOS PushKit/CallKit or Android native telephony, and a SIP offer that is still valid.

Legacy PBX integrators may produce the same contract. ViperChat does not connect to their AMI or databases. Realtime coverage and outage recovery depend on the producer's capabilities.

## Native app wake offer

Under **Companies → Edit → ViperChat call events**, a Manager administrator can select **Allow waking the app for incoming calls** (`viperchatWebhook.nativeWakeEnabled`). This per-company option is **off by default** and requires enabled event delivery and a compatible ViperChat receiver. It does not change other companies or the recording/AI transport.

**Native offer validity (seconds)** maps to `nativeWakeTimeoutSeconds`: an integer from **5 to 60**, default **30**. Editing restores the saved value; switching the option off retains the timeout. Partial API edits that omit these fields retain existing settings.

When enabled, an actual incoming-call offer can remain available while the authorized extension registers and receives its INVITE. Its deadline is also bounded by the current routing window: a late REGISTER or retry **never extends it**, reopens an ended call, or offers another company's call. The first valid answer still closes competing participations as answered elsewhere.

This option **does not itself enable push, CallKit, or background answering**. Those require an authorized device, verified native engine, and the ViperChat push transport configuration. Updating the software never activates live feature flags automatically. With the option off, previous SIP routing is preserved.
