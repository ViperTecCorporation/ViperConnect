---
description: Isolated Docker Desktop development environment for the mobile-primary pilot.
---

# Local mobile-primary lab

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
device remains offline, without webhooks; connect it manually. Never run both copies.
If the source is used again, create a fresh backup before transferring.

Includes registration, auth, Signal/prekeys, group sender keys, app-state and privacy
tokens. Excludes messages, media, webhooks, users and infrastructure credentials.
Registration is re-encrypted with the destination's own vault key. Existing data is
never overwritten. Credentials revoked by WhatsApp may still require a new registration.

Initial scope: `mobile_lab`, Redis, Zapo 1.9.0, store-redis 1.3.0, identical Redis
prefix and compatible Redis DUMP format; up to 10,000 keys, 8 MiB internal content
and a 16 MiB archive. SQLite and QR companion backups are not supported.

## Local VoIP overlay

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
