# Status/Broadcast — Behavior & Safeguards

This document details how Unoapi handles Stories (Status) through Baileys or Zapo and the protections added for large recipient lists.

## Inputs

- `to = "status@broadcast"`
- `type` is a content type supported by the selected provider (text, image, video, etc.)
- `options.statusJidList = [numbers | JIDs]` — the recipient list to relay after initial send

Auto-fill:
- If `statusJidList` is empty, Unoapi reads the compact temporal recipient index for the session.
- Legacy `contact-info` keys are imported once into that index and receive a TTL.
- If the list is still empty, the send is rejected with `status_recipients_required`.

## Validation & Normalization

Baileys validates recipients in `src/services/socket.ts`. Zapo resolves PN/username to canonical LID in `zapo_identity.ts` and publishes through `client.status`:

- For each entry in `statusJidList`, call `exists(raw)` which resolves to a valid JID if the number has WhatsApp, or `undefined` otherwise.
- Filter out all `undefined` (invalid numbers), log a warning with a small preview of skipped entries.
- Optionally normalize LID JIDs to PN based on `STATUS_ALLOW_LID` in `defaults.ts`.
- Deduplicate the final list.

If, after normalization, there are no valid recipients, the `relayMessage` step is skipped.

## Response Augmentation

To assist monitoring and client UX, the HTTP response includes two extra fields for Status sends:

- `status_skipped`: raw inputs that were removed for having no WhatsApp account.
- `status_recipients`: count of valid recipients relayed.

These fields are added without breaking the Cloud API response structure (`messages/contacts`).

## LID/PN Handling for Status

- Recipient normalization optionally converts LID JIDs to PN when `STATUS_ALLOW_LID=false`; when `true` (default), LIDs are allowed in the recipient list.
- Webhook payloads still prefer PN for `wa_id`/`recipient_id` whenever safely resolvable; unresolved LIDs are exposed through stable identifier fields where available instead of putting `@lid` in `wa_id`.
- Internally, the transport may use LID to improve session availability and reduce decrypt issues; this does not change the external webhook shape.

## Rationale

- Large lists may contain numbers without WhatsApp, which previously caused Baileys errors and could drop the socket.
- By filtering and normalizing upfront, Unoapi sends only to valid recipients and keeps the socket stable.

## Cache de destinatarios

Destinatarios recentes ficam em um unico sorted set por sessao, com timestamp e retencao
configuravel. Na primeira leitura, chaves legadas `contact-info` sao importadas uma vez e
recebem expiracao. Isso evita uma chave Redis permanente por contato usado em Status e
remove automaticamente destinatarios inativos.

- `STATUS_RECIPIENT_RETENTION_SEC`: retencao do indice (padrao 30 dias).
- `CONTACT_INFO_TTL_SEC`: TTL de compatibilidade das chaves antigas (padrao 30 dias).
