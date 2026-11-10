---
description: Isolated SIP and TURN services for the mobile-primary laboratory.
---

# Mobile-primary VoIP laboratory

The optional `compose.lab.voip.yml` overlay uses images from the private lab
environment, without changing production. Initial import pins source digests;
`LAB_VOIP_IMAGE` may also select an existing experimental local image. Recreating
services does not upgrade that image automatically. Only authorized API/bridge
and TURN credentials are reused. Routing, extensions, recordings and the VoIP
database use the separate `viperconnect-mobile-lab_voip-data` volume.
Production sessions and customer settings are not copied.

## Setup

Run `node lab/import-voip-env.mjs` to read the source containers over SSH and create
`%LOCALAPPDATA%\ViperConnect\mobile-primary-voip.env` outside the repository. The
importer neither prints credentials nor overwrites an existing environment file.
It requires compatible API/bridge tokens because the current worker uses one token
for both contracts. `lab/lab.ps1` automatically includes the overlay when this file
is present beside the main environment file.

Keep the VoIP overlay when recreating `web` or `worker-zapo`; otherwise the
manager loses its telephony URL and the worker stops opening its bridge even
while the VoIP container is healthy. The launcher also includes the local admin
port and storage tools overlays when present, preserving port 9876 and lab Redis
backups. Do not remove data volumes when recreating services.

VoIP uses the same **local** RabbitMQ as the other lab services. The overlay sets
both `AMQP_URL` and the legacy `VOIP_AMQP_URL` alias to the lab broker and lab
credentials, never importing the production broker. The older experimental image
requires the alias and logs `voip_amqp_url_required` when it is empty. A successful
`/health` response alone is insufficient: check the authenticated bridge and event
transport logs too. These checks do not prove real call audio.
`voip-smoke` resolves WebRTC in both old and current image layouts and uses
`coturn:3478` inside Docker when the browser URL is loopback. This translation
applies only to the test, not to the URL delivered to the browser.

Use `./lab/lab.ps1 up`, `status`, and `voip-smoke`. The worker connects to
`ws://voip:3097/v1/bridge/zapo`; the manager uses `http://voip:3097`. Both require
authentication. Connected lab sessions automatically provision lines/extensions.

| Purpose | Local endpoint |
| --- | --- |
| SIP | `<VOIP_LAN_HOST_IP>:5060/UDP` |
| Console and SIP WebSocket | `127.0.0.1:3097`, `/sip/ws` |
| RTP | UDP `12000–12063` |
| WebRTC | UDP `13001–13064` |
| Authenticated STUN/TURN | `127.0.0.1:3478`, UDP/TCP |
| TURN relay | UDP `14001–14064` |

These reduced ranges are for laboratory testing, not production capacity claims.
For same-computer testing, use `VOIP_LAN_HOST_IP=127.0.0.1` (the default) and
point the local SIP client at that address. This survives Wi-Fi/Ethernet changes.
A client on another device needs the host's current LAN IPv4 address instead.
Internal binds remain `0.0.0.0` to receive Docker-published traffic, and services
still communicate using Docker names `voip`/`coturn`. SIP/RTP are published on
host interfaces; console, WebRTC and TURN remain loopback-only in this template.
This does not enable remote TURN. Retrieve extension credentials from the manager.

## Boundaries and validation

Internet access is not configured. The manager's HTTPS domain does not expose
SIP or media ports. HTTPS web clients require valid WSS; do not allow insecure
content to work around mixed-content restrictions. The initial test uses a SIP
client on the LAN. Connectivity from another machine still needs verification.

On September 25, 2026, eight environment/isolation tests passed. UDP SIP OPTIONS
and STUN Binding responded from Windows. Health returned 200 and unauthenticated
API access returned 401. Session `5566936183915` connected through the `mobile_lab`
worker and provisioned an automatic extension. An ephemeral WebRTC client obtained
an authenticated TURN relay candidate and was closed without making a call.

These checks do not validate two-way audio, incoming WhatsApp calls or recordings.
Complete those checks with a real call. Worker recreation can leave the prior
lease active for roughly 75 seconds; allow normal reconnection instead of deleting it.

## Worker media transport fix — September 25, 2026

The initial lab worker image lacked the native `relay-bridge` executable. The
08:34 Cuiabá call failed with `spawn ... ENOENT` and zero relay/PCM frames despite
working signaling. The lab Dockerfile now builds and tests the same Go relay as
production, installs it with execution permissions, and sets its path explicitly.
Both the image build and `voip-smoke` verify executable startup. A real call is
still required to confirm two-way audio.

## Experimental relay port

The mobile-primary call endpoints completed DTLS/SCTP on port 3480, but not
on advertised port 3478. On October 12, 2026, the same pattern was reproduced
on a second conventional line: calls using port 3478 received no relay packets,
while calls using port 3480 stayed active. After the `default` profile failed
on port 3480, selection became session-specific: `wa_personal`, `wa_business`
and mobile-primary enable `preferWebRelayPort` and dial 3480. Non-mobile-primary
`default` sessions retain the advertised WhatsApp port (3478 in these tests).
The global laboratory `VOIP_PREFER_WEB_RELAY_PORT` override was removed.
The option changes only the dial port while
preserving credentials, addresses and selection order. This does not change SIP,
TURN, firewall or production configuration.
On September 25, 2026, the user confirmed two-way audio over both 4G and Wi-Fi
after applying this policy in the lab. This does not constitute production deployment.
The `wa_business` policy is covered by automated tests; a real call still needs
validation. Rollback: restore the previous policy, recompile and recreate the lab worker
without removing volumes or credentials.

## Storage migration with telephony

Manual Zapo session migration to SQLite returns
`409 session_storage_active_calls` while a call is initiating, ringing,
connecting, active or waiting behind another call. An incoming offer or
already accepted call command still in progress also prevents migration.
The request does not hang up, disconnect WhatsApp or interrupt existing audio;
end the call normally before requesting migration again.

With no calls pending, the plugin closes admission before disconnecting. New
commands fail with `session_storage_operation_in_progress`; offers arriving
during this window are acknowledged and rejected without allocating media. If
pausing fails before disconnection, command admission and events reopen. An
older worker plugin without this fence returns
`session_storage_voip_gate_required` until updated.

Synthetic lab tests exercise these races using the compiled plugin, bridge and
actual SQLite store, with call transport/cryptography mocked. They do not replace
a real call after migrating a session.

## Reversible shutdown

Stop `voip` and `coturn` with the overlay loaded. Preserve the private environment
as a backup under a different name, then recreate `web` and `worker-zapo` using
only `compose.lab.yml`. Keep all volumes; never use `down -v` for this procedure.
No Windows firewall changes were needed for the checks on this host. If another
LAN device is blocked, scope any additional firewall rule to the laboratory LAN.
