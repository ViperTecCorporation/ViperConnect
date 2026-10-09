---
description: Isolated Docker Desktop development environment for the mobile-primary pilot.
---

# Local mobile-primary lab

## Registration library revision

### Device approval and session phone

After `device_confirm_or_second_code`, approve on the phone and click the explicit confirmation check. `POST /manager/mobile-devices/{id}/registration/check` with `{ "confirm": true }` calls only `/exist` with the existing keys, without SMS, calls or OTP submission. An `ok` response with a valid login and no pending challenge enables the existing Zapo connection action. Failed checks preserve resend deadlines; checks are throttled to 15 seconds.

New registrations retain the entered number as the session identifier in API, Redis and webhooks (`sessionPhone`). The server-confirmed `canonicalPhone`, which may omit Brazil's ninth digit, remains the authentication identity. Backup, restore, deletion and companion access preserve this distinction. Older registrations without `sessionPhone` retain their existing namespace and are not automatically migrated while online.

The lab pins whalibmob commit `8d16ce663664425611944a07e083b8553985fd08`
(declared version 5.33.8), installed without lifecycle scripts. The worker verifies
the source SHA-256 before its single-attempt shim, with no automatic SMS/voice
fallback. Changing the dependency without its reviewed hash fails closed.

Refused requests retain version and FCM/APNs push state in encrypted registration
storage, without changing keys, identity or code/registration flags. These values
are excluded from public status responses and logs.

This revision adds iOS APNs push and flash-call code parsing, not a proven fix for
Android SMS/voice `blocked` or `no_routes`. Our flow supplies no device attestation,
disables pacing and screen telemetry, and does not integrate `wa_old` or `flash`.
Upstream recommends `wa_old` for active accounts; its success guarantee has not
been validated here. Do not automatically change these options or request codes
to work around a refusal. Critical advisory GHSA-g2qq-9229-mhjq remains unpatched;
Git installation and disabled lifecycle scripts do not establish package safety.

## QR linking diagnostics

The experimental IPv6 tunnel is excluded from published images. Registration
uses the server's normal egress, without a relay or automatic address rotation.

For a refused code request (`fail / too_recent`), manual retry is enabled after
the provider's method-specific cooldown even when no code is pending. SMS and
voice deadlines are independent; consent and resend confirmation remain mandatory.
Unknown deadlines, pending challenges and uncertain outcomes do not enable retry.

When linking by QR image/camera or code, **Enviar histórico de mensagens** is
checked by default. Unchecking sends `sendHistory:false`, skipping old Redis
message export while keeping native bootstrap and mandatory keys. The admin-only
API accepts this boolean only for `qr`/`code`; omission defaults to `true` for
existing clients. It does not change existing links or cancel an ongoing export.
`MOBILE_COMPANION_HISTORY_SKIPPED` logs the choice. No extra permission or ENV is
required. This option does not guarantee that the phone completes initialization.
The worker prepares the Signal session even when history is disabled, then runs
the native bootstrap; the SDK continues with mandatory key sharing. Preparation
failures before publication permit an SDK retry. Uncertain publication failures
are not replayed automatically. `MOBILE_COMPANION_NATIVE_BOOTSTRAP_STARTED` and
`MOBILE_COMPANION_NATIVE_BOOTSTRAP_SUBMITTED` distinguish start and submission;
`MOBILE_COMPANION_HISTORY_ERROR` records the stage and sanitized diagnostics.
Submission does not prove that the phone applied keys or finished initialization.

The device list queries the account's server device inventory, independently of
the local ADV epoch, with concurrent deduplication and a 15-second cache.
The explicit **Atualizar vínculos** command bypasses completed cached results
after a remote unlink; concurrent in-flight requests still share one query. It
invalidates only this account's PN/LID device-list cache before a fresh query and
before SDK reconciliation, avoiding pre-link cached snapshots. Query failures
are not reported as an empty successful list. Server-only devices omit unknown
`keyIndex`/`addedAtSeconds` and return `canRevoke:false`: revoke them in WhatsApp
because the SDK requires their local epoch record. No cryptographic keys are
reconstructed. `source=server_device_list` is not an online-presence indication.

QR input accepts either the bare payload or the exact
`https://wa.me/settings/linked_devices#` envelope. Only this prefix is removed
before validation/queueing and SDK linking; it must not become part of `ref`.
References and Base64 fields are not URL-decoded or rewritten. Other URL
envelopes are rejected. The 4096-character limit includes the prefix.
Provider acceptance still needs validation with a new lab QR.

The lab worker opts into the SDK experimental `includePem` option using
`UNOAPI_MOBILE_COMPANION_PEM_LAB=true`; the adapter also requires
`UNOAPI_MOBILE_PRIMARY_LAB=true`. Both QR and code linking on this worker use it.
The `MOBILE_COMPANION_PEM_LAB_ENABLED` log confirms configuration; request
structure confirms the PEM node without logging its contents. This is not a
confirmed fix. This experiment also enables structure-only tracing for code
linking, allowing comparison under the same configuration without secret values.
Production is unchanged without both flags. Roll back by disabling
the option and recreating only the worker, preserving volumes and credentials.

The **Dispositivos conectados** panel supports QR images and camera capture with
confirmation before sending. Camera capture requires HTTPS or localhost and
permission. Controls wait for any pending operation. QR linking is still under
lab validation; enabling capture does not guarantee provider acceptance.

QR attempts log `MOBILE_COMPANION_QR_INPUT` (field count and key lengths),
`MOBILE_COMPANION_PAIR_REQUEST` and `MOBILE_COMPANION_PAIR_RESPONSE` (structure
only). QR contents, references, attribute values and keys are never logged.
Diagnostics do not modify SDK requests or retry linking. A remote `400`
rejection does not prove expiry; reproduce with a freshly generated QR.

## Delete a device

The **Excluir dispositivo** action is available on each card and in its overview. Enter the exact draft phone number and acknowledge permanent deletion and the need for a new SMS registration. `DELETE /manager/mobile-devices/{id}/full` requires an administrator and `{confirm:true, acknowledgeNewSms:true, phone:"..."}`.

The operation blocks new registration/import, suspends the connection and waits for exclusive worker ownership before removing native Zapo state, active configuration, encrypted SMS registration and draft. It does not delete the WhatsApp account. Stored media, webhook history and historical assignments remain. Partial failures leave a deleting card so the operation can be retried. New registration remains subject to provider cooldowns and validation.

## Integration suspension and resume

For an imported mobile primary, `POST /v15.0/{phone}/deregister` accepts an empty body and removes all active webhooks for that connection. The existing history mechanism archives the previous configuration for explicit administrator restoration. Archival failures are logged and do not block suspension. Reconnecting never restores those destinations automatically.

The API persists `autoConnect=false` and publishes reconciliation to the owning worker, which disconnects without WhatsApp logout or credential cleanup. Restarting the worker keeps the device offline. All integrations on that device are interrupted while suspended; offline message recovery is not guaranteed. Existing queues are not purged.

`register` saves supplied webhooks by ID before enabling reconnection. Omitted destinations remain unchanged. The panel's Connect action also resumes, without restoring removed webhooks. HTTP 200/204 confirms configuration and publication, not socket completion. Check connection status afterward. Ordinary linked sessions retain their previous deregistration behavior. The actual ViperChat request body must match this contract.

This lab implements the SMS registration pilot and import into the existing Zapo worker. Work is isolated on the `mobile-primary` branch. Confirmed registration and a connected session are distinct states.

After registration, an administrator may select **Connect to Zapo** and explicitly confirm. `POST /manager/mobile-devices/{id}/connection` accepts `{ "confirm": true }`, preserves the encrypted registration, refuses conflicting sessions and imports credentials once under the worker's session lease. Updated Zapo auth is never overwritten; removed auth is not resurrected. The existing worker selects mobile transport from persisted `deviceInfo`. Auto-connect is enabled only after import. `202 connection_requested` is not proof of a successful handshake; `GET` on the same endpoint reads the connection status. This operation is restricted to `mobile_lab`, does not send test messages and does not enable companion linking or mobile VoIP.

The SMS panel shows the remote wait and performs a read-only Uno status check when its countdown expires. SMS and code verification always require user action. **I did not receive the code** supports explicit resends while awaiting a code, respecting any wait returned with the accepted request. There is no five-attempt ceiling or fixed one-hour fallback for `too_recent`; a refusal with no reported wait has no invented deadline.

The `viperconnect-mobile-lab` Compose project uses fresh Valkey/RabbitMQ volumes, its own network and admin credentials, and the dedicated `viperconnect-lab` bucket. No production sessions or webhook destinations are imported. The S3 endpoint may be shared; preferably restrict its credentials to the lab bucket. VoIP, TURN and production ingress are not started in this phase.

Private configuration is stored outside the repository at `%LOCALAPPDATA%\ViperConnect\mobile-primary.env`. `node lab/environment.mjs` accepts S3 configuration as JSON on stdin, creates random lab tokens and refuses to overwrite existing files. Never pass secrets as command-line arguments or commit them. Protect the folder with Windows ACLs.

From the repository root in PowerShell:

```powershell
node --test lab/environment.test.mjs
./lab/lab.ps1 check
./lab/lab.ps1 build
./lab/lab.ps1 up
./lab/lab.ps1 status
```

The wrapper requires the local `desktop-linux` context. API/manager: `http://localhost:19876`; documentation: `http://localhost:18080`; RabbitMQ console: `http://localhost:15682`. Every published port binds to loopback. Redis and AMQP are not published.

The compiler watches backend, frontend, public assets and scripts. Compiled files live in Docker volumes; runtime processes restart after compilation. Refresh the browser after a frontend change. This is not application HMR. Dependency/configuration changes require rebuilding. Documentation dependencies occupy a separate persistent volume that must be updated deliberately when dependencies change.

`./lab/lab.ps1 stop` stops the lab; `up` resumes it. `down` removes containers but preserves volumes. There is no automatic reset. Default media retention only affects the lab bucket. Do not run the same account in the worker and another client concurrently. A phone cannot access the desktop's localhost; LAN/HTTPS testing needs explicit configuration.

## Encrypted device backup

Open the device overview and choose **Baixar backup**. Set a separate password
(12–128 characters) and confirm suspension. The browser downloads a `.viperdevice`
file protected with AES-256-GCM and scrypt. The source remains disconnected with
automatic reconnection disabled, including when download fails.

At the destination, use **Novo dispositivo principal → Restaurar dispositivo**,
select the file, enter its password and confirm the source is offline. The restored
device enables `autoConnect=true`, without webhooks, and requests a worker connection after releasing the restore lock. Never run both copies.
If the source is used again, create a fresh backup before transferring.

Includes registration, auth, Signal/prekeys, group sender keys, app-state and privacy
tokens. Excludes messages, media, webhooks, users and infrastructure credentials.
Registration is re-encrypted with the destination's own vault key. Existing data is
never overwritten. Credentials revoked by WhatsApp may still require a new registration.

Initial scope: `mobile_lab`, Redis, Zapo 1.9.0, store-redis 1.3.0, identical Redis
prefix and compatible Redis DUMP format; up to 50,000 keys, 8 MiB internal content
and a 16 MiB archive. SQLite and QR companion backups are not supported.

New linked-session `.vipersession` backups use **stream-v2**, without a fixed
total record/file size cap or truncation. SCAN and temporary deduplication feed
bounded encrypted frames into the existing media storage (S3/MinIO or local).
Redis holds task metadata, not the entire archive. Downloads are available for
24 hours; the broker schedules archive deletion. Swarm requires shared storage.
AES-256-GCM authenticates each frame, its sequence and a mandatory final frame.
Frames contain at most 100 records/4 MiB; individual Base64 DUMPs retain their
2,000,000-character limit. Passwords are never persisted. Storage capacity and
infrastructure timeouts still apply; configure the proxy for large files.
Session phone validation accepts only the Brazilian mobile ninth-digit alias
with the same area code and remaining digits. The native identity is not rewritten;
restored credentials must still match the backup's exact identity JID.

The panel uploads new files in separate **8 MiB HTTP parts**: create with
`POST /manager/session-transfers/restore-uploads` (`{size}`), send sequential
`PUT /restore-uploads/{upload}/parts/{part}` with `application/octet-stream` and
`X-Part-SHA256`, then `POST /restore-uploads/{upload}/complete` with password and
offline-source confirmation. Finalization returns 202; poll `GET /restore-uploads/{upload}`
for the actual result. A 576 MiB backup uses 72 parts; progress is displayed.
Selecting a file alone does not start restoration. HTTP 413 may still occur if
the proxy allows less than 8 MiB per request. Browser hashing requires HTTPS or
localhost. Redis holds metadata/receipts only; encrypted bytes use default media
storage, shared across web replicas and broker in Swarm. Temporary parts expire
with scheduled deletion after 24h (active broker required); confirmed parts are
also cleaned after success, failure or pre-restore cancellation. Passwords are
not persisted. A process crash reports `interrupted`, requiring destination review;
imports never restart automatically. Duplicate parts must be byte-identical.
The panel does not resume uploads after page reload. `restore-stream` remains
compatible for direct clients. Upload proceeds
without file.text(). Restore stages records and a metadata journal,
verifies identity and the authenticated end, promotes batches of up to 100 keys,
and activates the registration only at the end. Failed imports roll back their
own promoted batches. Lost fencing returns `session_restore_rollback_pending`
instead of deleting another process's data; review it before retrying.
The journal becomes durable during promotion and is deleted after success or
proven rollback. Process crashes or uncertain Redis responses retain diagnostic
metadata, not a second copy of DUMPs.
Export failure restores the previous auto-connect setting only while still
owning the suspension. Completed backups keep the source offline.
Legacy archives remain supported with 50,000 records, 8 MiB internal content and
16 MiB encrypted file limits. Mobile Primary `.viperdevice` backups are unchanged.
Legacy `POST /manager/session-transfers/restore` authenticates the administrator before
reading JSON with a **17 MiB HTTP body limit**, like Mobile Primary restore.
Other endpoints keep their own limits. Existing destination registrations or
credentials are never overwritten. Restores enable automatic connection; `connection_requested` is not proof of being online. If dispatch fails, `restore_connection_dispatch_failed` means the restore succeeded: do not import again, use Connect.

Linked-session overview exposes **Delete from this instance** to administrators. Completed backup, suspended source, destination validation and administrator password remain required; no remote logout is sent. Confirmation phone numbers trim surrounding whitespace only.

## Local VoIP overlay

**Local deletion** removes configuration, session index membership and the active
user assignment, retaining assignment audit history. The number no longer appears
as a pending/disconnected placeholder. Ordinary disconnect/deregistration retains
assignments. Migration removal never sends a remote logout.

### Registration code by SMS or voice call

Mobile Primary offers **Request SMS** and **Receive code by voice call**, useful
for landlines. Both require explicit consent and use the same six-digit code
verification field; QR-linked sessions are unchanged. Send
`{"confirm":true,"method":"voice"}` to
`POST /manager/mobile-devices/{id}/registration/request`; omitted method defaults
to `sms`. Resends additionally require `confirmResend:true` and the corresponding
`canResendVoice` or `canResendSms` permission. Existing keys are preserved.
There is no automatic delivery-method fallback or automatic code request.
`diagnostic.smsWaitSeconds` and `diagnostic.voiceWaitSeconds` retain independent
remote waits, including zero; `retryAt` and `retryAtVoice` are Unix milliseconds.
Pending challenges, in-flight operations and uncertain outcomes remain blocked.
Refresh status after the voice deadline. Missing method-specific waits use the
conservative provider wait; local availability does not guarantee a call.

`compose.lab.voip.yml` runs the VPS VoIP/coturn images pinned by digest, with a
separate local database and recording volume. Authorized credentials stay outside
the repository in `mobile-primary-voip.env`; `lab/lab.ps1` detects this file beside
the main lab environment. Run `./lab/lab.ps1 voip-smoke` to check the API, bridge,
automatic extension and authenticated TURN without placing a call.

LAN SIP uses `192.168.0.112:5060/UDP`; obtain extension credentials from the manager.
RTP uses UDP `12000–12063`, WebRTC `13001–13064`, relay `14001–14064`, STUN/TURN
`3478`, and the console/SIP WebSocket `3097`. Internet access is not configured.
HTTPS web clients need valid WSS, not a mixed-content exception. Two-way audio and
recordings still require a real call. See the [VoIP lab guide](/guide/mobile-primary-voip-lab)
for setup and rollback instructions in Portuguese.

An optional Zapo MCP could inspect library methods/events in a separate test runtime. It is not installed here and does not replace end-to-end tests of the application's queues, authorization or webhooks. Full operational details are maintained in the [Portuguese guide](/guide/mobile-primary-local-lab).


After `device_confirm_or_second_code`, an ordinary resend is allowed after the provider's method-specific wait (SMS or voice), without a local attempt ceiling. The SMS countdown refreshes eligibility; for voice, refresh status after the displayed deadline. Explicit consent and a click are required; keys are preserved. Missing waits or another pending challenge keep resends blocked. This does not automatically continue device approval.


After a `no_routes` failure, manually retry the failed method only after an explicit provider wait expires, including zero. Without a reported wait, only the alternate method may become available. SMS and voice deadlines are independent and displayed separately; the panel checks eligibility at each deadline even when the other method is already available. Consent is required, keys are preserved, and pending challenges remain enforced. Codes are never requested automatically.
After `fail / blocked` at the request stage, explicit SMS or voice retry is
allowed, including the same method, with `confirmResend:true`. No local delay is
invented when the provider supplies none; method-specific waits and pending
challenges remain enforced. Keys are preserved and retries are never automatic.
Local eligibility does not guarantee provider acceptance or prove an account ban.
