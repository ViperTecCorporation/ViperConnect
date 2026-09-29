# Messages

## Editor-prepared video: Zapo HD and SD

Set `video.quality` to `hd` (default) or `sd`, alongside `video.link` or
`video.base64`. This ViperConnect extension does not guarantee WhatsApp's HD badge.

| Recommended parameter | HD | SD |
| --- | --- | --- |
| Landscape / portrait bounds | 1280×720 / 720×1280 | 854×480 / 480×854 |
| Quality | CRF 23 | CRF 27 |
| Video maxrate / VBV buffer | 2500 / 5000 kbps | 1200 / 2400 kbps |
| Audio | AAC-LC 96 kbps, 48 kHz | AAC-LC 64 kbps, 48 kHz |

64 kbps is the SD encoding target, not its acceptance ceiling. Both profiles
accept prepared AAC-LC up to **96 kbps + 5% (100,800 bps)** with no 64 kbps floor.
48 kHz and mono/stereo are still required. If only audio needs correction,
`-c:v copy` preserves encoded video packets; logs show `mode=audio-transcode`.
The existing `VIDEO_TRANSCODED` warning reports processing on the same message.

Both use MP4/H.264 `yuv420p`, `veryfast`, square pixels, preserved aspect ratio,
no cropping/upscaling, original FPS capped at 30, mono preserved (maximum stereo),
and `+faststart`. Bake rotation into pixels. Silent files remain silent. Use
CRF with VBV, not constant bitrate or a 15 MiB target. See
[FFmpeg libx264](https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb).

All sources are inspected, including browser-prepared files. Compatible streams
in a non-fragmented MP4 with `moov` before `mdat` reuse the original stored object:
no FFmpeg, remux, recompression or second storage upload. Local download, ffprobe,
box inspection and the WhatsApp upload still occur. Compatible files lacking
faststart are remuxed; incompatible files are transcoded. Logs distinguish
`mode=passthrough`, `mode=remux` and `mode=transcode`. Checks cover even
dimensions, FPS, rotation, pixel aspect ratio, reported bitrate and audio format.
AAC average bitrate allows 5% encoder tolerance. Original CRF and instantaneous bitrate peaks cannot be proven from ffprobe;
missing metadata or incompatible parameters trigger conversion. HD reduces 1080p.

Converted video emits `VIDEO_TRANSCODED` in
`entry[].changes[].value.statuses[].warnings` on the original message ID after
sending. This is informational, not a request to resend; no second message is
created. The warning outbox supports status replay without resending the video.

Input defaults to 256 MiB (Base64 also has separate HTTP limits). Output defaults
to **256 MiB**, independently configured with
`UNOAPI_VIDEO_MAX_OUTPUT_BYTES` on the worker. This operational ceiling is not a
universal WhatsApp limit and still needs real-channel validation.
`UNOAPI_VIDEO_TARGET_BYTES` is no longer used. No Compact mode or silent HD-to-SD
downgrade: oversized output emits `failed`, error 131053, and
`VIDEO_OUTPUT_TOO_LARGE` on the original ID, suggesting SD, trimming or a document
when supported. Other preparation failures use `VIDEO_PREPARATION_FAILED`.
Provider rejections still follow the regular failed-status flow. ViperChat is
not modified by this implementation.

Send messages through the Cloud API-compatible endpoint:

```http
POST /v15.0/{session}/messages
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
```

## Choose a format

Every message uses the same endpoint. The `type` field selects the required
content block.

| I want to send | `type` | Source |
| --- | --- | --- |
| plain text or a reply | `text` | `text` object |
| image, video, audio, document or sticker | media type | matching media object |
| buttons, lists or carousel | `interactive` | `interactive` object |
| poll or vote | `poll` / `poll_vote` | poll object |
| order or payment flow | interactive type | order/payment object |

::: info Compatibility
`link` and `id` preserve the existing contract. `base64` is a ViperConnect
extension. Never send more than one source for the same media object.
:::

## Send view-once media (Zapo)

Set `image.view_once`, `video.view_once` or `audio.view_once` to the boolean
`true`. This ViperConnect extension maps to Zapo's official `viewOnce` send
option. Omitted/false keeps normal media. Strings/numbers and unsupported
types (text, document, sticker) return HTTP 400 before enqueueing. Do not use
the webhook field `message_type` as an outgoing request flag.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "image",
  "image": { "link": "https://example.com/image.jpg", "view_once": true }
}
```

The flag survives video preparation and Base64 input. Audio `ptt` remains an
independent option. Normal media source rules and size limits apply. Enabled
outgoing echoes carry `message_type: "view_once"` in `messages` or
`message_echoes`, preserving the ID and media type. This does not make integration
storage URLs single-access. See [Zapo send options](https://zapo.to/en/guides/sending-messages#send-options-reference).

## Contact cards

Brazilian mobile numbers inside shared cards use the same canonical phone
resolver as message recipients: session cache first, then WhatsApp if needed.
When the confirmed identity uses an eight-digit local number, the vCard phone
and `wa_id` follow that form; the ninth digit is never removed by assumption.
Unavailable or unconfirmed lookups preserve the original card. Landlines and
foreign numbers remain unchanged. This applies to single and multiple cards,
without changing the envelope recipient `to`.

Use `type: "contacts"` and `contacts: [...]` in the public API, even for a single
card. The Zapo adapter sends one card as `contactMessage`, and two or more as
`contactsArrayMessage` in one message, preserving their order. Each card keeps
its display name and vCard data, including the phone's `wa_id`. Empty lists and
cards without a phone are rejected. No application payload change is required.
See the [Zapo raw-send contract](https://zapo.to/en/guides/raw-sends#contacts).

## Text and link previews

ViperConnect automatically renders a preview box for the first valid public URL
or domain. Existing `http://` and `https://` URLs are preserved; a bare domain
such as `example.com/page` is normalized to `https://example.com/page`. Email
addresses, IPs, `localhost`, filenames and malformed domains do not enable a
preview. The page and its Open Graph image must be publicly reachable. Do not
set `preview_url`.
Links from `youtube.com`, including Shorts, and `youtu.be` automatically use
YouTube's official `oEmbed` response for title and thumbnail metadata without
downloading the complete page. If that lookup fails, the generic preview path
is still used.

```json
{
  "messaging_product": "whatsapp",
  "to": "15557654321",
  "type": "text",
  "text": {
    "body": "Learn more: github.com/ViperTecCorporation/ViperConnect"
  }
}
```

## Media by URL

The existing `link` contract remains unchanged:

```json
{
  "messaging_product": "whatsapp",
  "to": "15557654321",
  "type": "image",
  "image": {
    "link": "https://cdn.example.com/photo.jpg",
    "caption": "Optional caption"
  }
}
```

## Direct Base64 media

As a ViperConnect extension, `image`, `video`, `audio`, `document` and
`sticker` accept raw Base64 or a Data URI. Use exactly one source: `link`, `id`
or `base64`.

```json
{
  "messaging_product": "whatsapp",
  "to": "15557654321",
  "type": "image",
  "image": {
    "base64": "/9j/4AAQSkZJRgABAQ...",
    "mime_type": "image/jpeg",
    "filename": "photo.jpg",
    "caption": "Optional caption"
  }
}
```

```json
{
  "messaging_product": "whatsapp",
  "to": "15557654321",
  "type": "document",
  "document": {
    "base64": "data:application/pdf;base64,JVBERi0xLjQK...",
    "filename": "contract.pdf"
  }
}
```

ViperConnect validates and stores the bytes before publishing the job. Base64
content is not copied into RabbitMQ, logs or webhooks. Videos continue through
the dedicated preparation worker. The default decoded limit is 32 MiB
(`UNOAPI_MEDIA_BASE64_MAX_BYTES`) and the message-route JSON limit defaults to
`48mb` (`UNOAPI_MESSAGES_JSON_LIMIT`).

Legacy PDFs generated by Oracle Reports can open on mobile while appearing as
unavailable in WhatsApp Web. The worker detects only that producer signature
and normalizes the PDF with `qpdf` before uploading it to WhatsApp. This applies
to both `link` and `base64`; the original storage object is never changed.
Ordinary PDFs bypass conversion, while encrypted, digitally signed or form PDFs
are preserved without modification.

## Addressing

The destination may be a phone number, LID, group ID or cached username. When
available, send all known identity fields:

```json
{
  "to": "15557654321",
  "user_id": "12345678901234@lid",
  "username": "maria",
  "type": "text",
  "text": { "body": "Hello" }
}
```

The canonical LID takes precedence, followed by the local identity cache and a
network lookup. Polls, reactions, interactive buttons, lists, carousels,
payments, order details and order status updates are available in the
[interactive API reference](/en/api-reference).

## Payment orders with a PDF header

Detailed `order_details/review_and_pay` orders can use a PDF document instead
of an image in the header:

```json
{
  "type": "document",
  "document": {
    "link": "https://cdn.example.com/boleto-1033239253.pdf",
    "filename": "boleto-1033239253.pdf",
    "mime_type": "application/pdf"
  }
}
```

This is the `interactive.header` object, not a complete request. See the
[complete boleto + PIX + PDF payload](/guide/messages#pedido-com-boleto-pix-e-pdf-no-header).
Replace the example destination, URL, payment placeholders and charge reference
before sending. The worker must be able to download the PDF bytes directly;
signed URLs must remain valid until download. Local file paths are not URLs.

The `order` object is required when the header contains media. Do not add this
header to a simplified order without `order`. Delivery and display on a phone
were confirmed through Zapo on September 19, 2026 for this payment flow. This
does not establish document support for every interactive type or equivalent
support in other providers. Sending the PDF separately remains optional.

## Payments and payment confirmation

Use the official simplified `order_details/review_and_pay` flow for a standalone
dynamic PIX charge. Always provide and persist your own `reference_id` if the
payment will be updated later. It must be unique for the charge, contain no more
than 60 characters, and use only ASCII letters, numbers, `_`, `-` or `.`.

```json
{
  "messaging_product": "whatsapp",
  "to": "15557654321",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "body": { "text": "Pay BRL 60.00 via PIX" },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "pix-charge-20260826-001",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "pix_dynamic_code",
            "pix_dynamic_code": {
              "code": "YOUR_FULL_PIX_COPY_AND_PASTE_CODE",
              "merchant_name": "Your Company",
              "key": "YOUR_KEY_OR_EVP",
              "key_type": "EVP"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": { "value": 6000, "offset": 100 }
      }
    }
  }
}
```

WhatsApp does not verify settlement with the bank. After your bank, gateway or
PSP confirms the payment, send `order_status/review_order` with the same
`reference_id`. Wait until the original message reaches `sent` or `delivered`
before sending the update.

```json
{
  "messaging_product": "whatsapp",
  "to": "15557654321",
  "type": "interactive",
  "interactive": {
    "type": "order_status",
    "body": { "text": "Payment confirmed." },
    "action": {
      "name": "review_order",
      "parameters": {
        "reference_id": "pix-charge-20260826-001",
        "order": {
          "status": "processing",
          "description": "Payment confirmed. Order in progress."
        },
        "payment": {
          "status": "captured",
          "timestamp": 1785125734
        }
      }
    }
  }
}
```

`captured` marks the payment as confirmed. Send another update with
`order.status: completed` when fulfillment finishes. The `order` object may be
omitted when only the payment status changes, but `reference_id` and
`payment.status` remain required. Use the real Unix timestamp in seconds from
your PSP instead of copying the example value.
