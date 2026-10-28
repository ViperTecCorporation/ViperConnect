# VoIP events and states reference

Event contract version `1`, received by ViperChat. See [integration setup](/en/guide/voip-webhooks) and [REST recovery and diagnostics](/en/guide/voip-webhooks-recovery) for operational instructions.

## Receiving events

```text
POST /api/v1/accounts/:account_id/voip/services/:service_id/events
api_access_token: <VIPERCHAT_ADMIN_TOKEN>
Content-Type: application/json
```

The token must belong to an administrator of the URL account, with its API enabled and the service registered in that account. Authorization is checked for duplicates too. Do not use Bearer here or place credentials in the URL/body. The body limit is **256 KiB**.

The receiver validates and persists the event before acknowledging it:

| Response | Meaning |
| --- | --- |
| `202` with `{"event_id":"…","status":"accepted"}` | Event durably received for processing. |
| `200` with `{"event_id":"…","status":"duplicate"}` | Identical duplicate of a previously received event. |
| `401` | Missing or invalid token. |
| `403` | Missing administrator permission or account API disabled. |
| `404` | Account/service not found in the authorized scope. |
| `409` | Same event ID or revision with conflicting content. |
| `413` | Body exceeds the limit. |
| `422` | Invalid fields, source or integration configuration. |
| `408`, `429` or `5xx` | Temporary failure; the producer may retry. |

The receipt must contain the submitted `event_id`. An HTML page with HTTP `200` is not a valid receipt. HTTP acceptance does not mean history, private notes or recording downloads have finished processing.

## Event envelope

Each event contains a complete call snapshot, not just the changed field.

| Field | Required | Rule |
| --- | --- | --- |
| `schema_version` | Yes | Integer `1`. |
| `event_id` | Yes | Stable ID, 1–200 characters, without control characters. |
| `event_type` | Yes | One of the event types below. |
| `occurred_at` | Yes | UTC ISO 8601 timestamp ending in `Z` or `+00:00`, up to 40 characters. Time of observing the change, not the HTTP attempt. |
| `source_instance_id` | Yes | PBX identity, 1–200 characters, matching the destination configuration. |
| `call_id` | Yes | Stable technical call ID, 1–200 characters; not a phone number. |
| `revision` | Yes | Positive integer increasing per call, up to 9223372036854775807. Gaps are allowed. |
| `call` | Yes | Call state and participants. |

Retries preserve `event_id` and content. A new observation uses a new revision. Consumers consolidate by service/source/`call_id`, ignore stale revisions and never correlate calls by phone, name or nearby timestamps alone.

Only documented fields are accepted, including in nested objects. Omit unknown optional values; `null` does not replace a required field. Technical identifiers reject control characters.

## Call data

| `call` field | Required | Rule |
| --- | --- | --- |
| `direction` | Yes | `inbound`, `outbound` or `internal`. |
| `state` | Yes | Global call state, as listed below. |
| `started_at` | Yes | Actual call start time in UTC ISO 8601. |
| `answered_at` | No | Confirmed answer time. An IVR answer does not prove an agent answered. |
| `ended_at` | No | Confirmed end time. |
| `business_phone` | No | Confirmed external business line: 10–15 digits with optional leading `+`. Omitted for internal calls. |
| `from` / `to` | No | Source and destination addresses. |
| `end_reason` | No | Technical end reason, 1–128 characters; no closed value list. |
| `participants` | Yes | 0–100 participants with unique IDs. Empty when no participation is proven. |
| `recording` | No | Basic metadata: `status` and `record_id`. |
| `artifacts` | No | Recording, transcript, summary and private-note target. |

### Source and destination

`from` and `to` objects use:

| Field | Required in object | Rule |
| --- | --- | --- |
| `kind` | Yes | `phone`, `extension` or `unknown`. |
| `value` | Yes | 1–128 characters. For `phone`, 10–15 digits with optional leading `+`. |
| `name` | No | Display name, 1–128 characters; never a correlation key. |

Extensions preserve leading zeros and are not normalized as mobile phone numbers. LID/JID does not prove a phone: use `unknown`, without extracting digits to fabricate one. Account authorization comes from the service URL/configuration, not these addresses.

### Extension participants

A call may contain multiple SIP legs and multiple devices for the same extension. Each participant retains its identity throughout the call.

| Participant field | Required | Rule |
| --- | --- | --- |
| `id` | Yes | Stable leg ID, 1–200 characters. |
| `state` | Yes | `offered`, `ringing`, `active`, `completed`, `missed`, `failed`, `cancelled` or `answered_elsewhere`. |
| `extension` | No | Proven company extension, 1–128 characters. |
| `sip_call_id` | No | Actual SIP Call-ID for this leg, 1–256 characters. |
| `client_call_id` | No | Exact UUID of the authenticated outbound intent. Requires `extension` and `sip_call_id`; never infer it from a phone, the signed-in agent or a timestamp. |
| `offer` | No | Participant's native offer; format and limits are described below. |
| `started_at`, `answered_at`, `ended_at` | No | UTC ISO 8601 timestamps for observed participant facts. |

Transfers preserve earlier participants. Ending one leg does not end the entire call. Without an exact SIP Call-ID and unique binding, ViperChat stores the call without inventing an association with agent history.

### Native offers and transfers to an unregistered app

Additive v1 extension for the ViperConnect `4.0.40` / VoIP service `0.1.69`
delivery, linked to ViperChat `4.16.12-viper.38`. Upgrade the ViperChat receiver
before the producer; older receivers reject new fields with `422`.

An `offered/ringing` participant with an extension may include an `offer` with
a stable `id` (1–200 characters) and UTC `expires_at`. Initial offers omit purpose
and belong to a `routing/ringing` parent. Transfers keep parent and source `active`:

```json
{
  "id": "transfer-attempt-1-1001", "extension": "1001", "state": "offered",
  "offer": {
    "id": "transfer-attempt-1-1001", "expires_at": "2026-10-27T17:00:30Z",
    "purpose": "transfer", "source_participant_id": "source-leg-1010"
  }
}
```

Synthetic fragment. `source-leg-1010` must exist in the same snapshot, be active,
have a real SIP Call-ID and use a different extension. Only `transfer` is accepted
as purpose. A source field alone, invalid source or terminal participant cannot
wake a device. The window is at most 60 seconds, with a new ID for each attempt.

ViperChat generates a native UUID per device/attempt and retains it for retries.
The parent UUID, `call_id`, timestamps, history and recording remain unchanged.
Push stays schema-1 `voip.incoming`, without the new fields; no new token/relay.
Authenticated resolution uses that device's own delivery, including SIP-before-
push, returning `state: ringing` with the actual parent `call_state: active`.

After REGISTER, send the exact offer's INVITE without duplicating renewals/socket.
Release the source only after the target answers; REFER `202` alone is not success.
Rejection, expiry or revocation cancels the attempt and preserves the source; one
winner ends the other forks. Historical replay never sends another wake. The
bundled service covers incoming/outgoing external Zapo calls; internal direct-SDP
transfers and physical Wi-Fi/cellular audio retain separate acceptance gates.
No publication or deployment is implied.

## Events and states

| Event | Purpose |
| --- | --- |
| `call.created` | First observation of the call. |
| `call.ringing` | Alerting, without a confirmed answer. |
| `participant.answered` | Confirmed participant answer. |
| `participant.released` | One leg released; others may remain active. |
| `call.transferred` | Transfer-related change of legs. |
| `call.ended` | Global call termination. |
| `call.updated` | Supplement/correction, including a call known only at termination. |
| `recording.updated` | Basic recording metadata; does not itself publish a private note. |
| `call.artifacts.updated` | Recording and AI update handled by the private-note processor. |

The receiver supports these types, but a producer may represent release/transfer as `call.updated` with updated participants. Compare the revision and full snapshot rather than the name alone.

| Global state | Meaning |
| --- | --- |
| `routing` | Routing the call. |
| `ringing` | Alerting. |
| `active` | Confirmed answer. |
| `completed` | Ended after a confirmed answer. |
| `missed` | Incoming call ended without a confirmed answer. |
| `failed` | Call failure. |
| `cancelled` | Call cancelled. |

`completed`, `missed`, `failed` and `cancelled` are terminal states. `offered` and `answered_elsewhere` belong to participants, not the global state. Later revisions may add recordings/AI but must not make a finished call ring again. Preserve confirmed `answered_at`.

## Recordings, transcripts and summaries

With `artifactsDelivery: "webhook"`, data arrives in `call.artifacts`, normally through `call.artifacts.updated`. Recordings and AI may arrive in different revisions.

| Object/field | Rule |
| --- | --- |
| `recording` | Optional. Requires `status` and `record_id`; may include `mime_type`, `size_bytes`, `sha256`. |
| `recording.status` | `disabled`, `recording`, `processing`, `available` or `failed`. |
| `recording.record_id` | Stable media lookup ID, 1–200 characters. |
| `recording.mime_type` | `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/wave`, `audio/x-wav`, `audio/gsm`, `audio/x-gsm` or `audio/ogg`. |
| `recording.size_bytes` | Integer 1–52428800, up to 50 MiB. |
| `recording.sha256` | Optional actual-content hash, 64 lowercase hexadecimal characters. |
| `ai` | Optional. Requires `status`; may include the fields below. |
| `ai.status` | `disabled`, `queued`, `processing`, `completed` or `failed`. |
| `ai.transcript` | Up to 64000 characters; line breaks/tabs allowed, no executable HTML. |
| `ai.summary` | Up to 16000 characters; not automatically sent to the customer. |
| `ai.transcription_model` / `ai.summary_model` | Model identifiers up to 128 characters, never API keys. |
| `ai.completed_at` | UTC ISO 8601 completion time, when known. |
| `note_target` | Optional. Contains proven `business_phone` and `remote_phone`, each 10–15 digits with optional leading `+`. |

`call.business_phone` identifies the external business line even in legacy mode. `call.artifacts.note_target` belongs to artifact delivery. Do not use the customer's number as the business line number.

Events must not contain base64 audio, recording URLs, local paths, buckets, tokens, secret prompts, `conversation_id`, `inbox_id`, `agent_id` or a public-note flag.

ViperChat fetches recordings through the configured VoIP service route:

```text
GET /v1/console/history-records/{record_id}/recording
Authorization: Bearer <VOIP_SERVICE_TOKEN>
```

The client verifies size, MIME and any supplied hash without following redirects. One private note retains its IDs across updates. A proven conversation binding remains fixed even after the contact's phone changes. Without a reliable binding, artifacts stay pending on the call rather than being published to another conversation.

## Completed call example with artifacts

```json
{
  "schema_version": 1,
  "event_id": "company-a:artifacts-008",
  "event_type": "call.artifacts.updated",
  "occurred_at": "2026-10-22T16:01:05Z",
  "source_instance_id": "pbx-company-a",
  "call_id": "pbx-company-a:call-001",
  "revision": 8,
  "call": {
    "direction": "inbound",
    "state": "completed",
    "business_phone": "5511999991111",
    "started_at": "2026-10-22T16:00:00Z",
    "answered_at": "2026-10-22T16:00:05Z",
    "ended_at": "2026-10-22T16:01:00Z",
    "from": { "kind": "phone", "value": "+5511999990000" },
    "to": { "kind": "extension", "value": "1001" },
    "end_reason": "normal_clearing",
    "participants": [
      {
        "id": "call-001:leg-1001",
        "extension": "1001",
        "state": "completed",
        "sip_call_id": "actual-sip-leg-1001",
        "started_at": "2026-10-22T16:00:00Z",
        "answered_at": "2026-10-22T16:00:05Z",
        "ended_at": "2026-10-22T16:01:00Z"
      }
    ],
    "artifacts": {
      "recording": {
        "status": "available",
        "record_id": "recording-call-001",
        "mime_type": "audio/wav",
        "size_bytes": 16044
      },
      "ai": {
        "status": "completed",
        "transcript": "Example call transcript.",
        "summary": "Example summary.",
        "transcription_model": "transcription-model",
        "summary_model": "summary-model",
        "completed_at": "2026-10-22T16:01:05Z"
      },
      "note_target": {
        "business_phone": "5511999991111",
        "remote_phone": "5511999990000"
      }
    }
  }
}
```

Values are illustrative. `sha256` is omitted because it must be calculated from real audio. Unknown optional names, models and timestamps can also be omitted.

The contract does not include control commands, video, hold/mute, DTMF or quality metrics. A final-only record can consolidate history but cannot provide a realtime incoming-call alert.
