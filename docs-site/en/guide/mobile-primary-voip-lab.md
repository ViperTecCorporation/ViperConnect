---
description: Isolated SIP and TURN services for the mobile-primary laboratory.
---

# Mobile-primary VoIP laboratory

The optional `compose.lab.voip.yml` overlay runs the production VoIP and coturn
images pinned by digest, without changing production. Only authorized API/bridge
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

Use `./lab/lab.ps1 up`, `status`, and `voip-smoke`. The worker connects to
`ws://voip:3097/v1/bridge/zapo`; the manager uses `http://voip:3097`. Both require
authentication. Connected lab sessions automatically provision lines/extensions.

| Purpose | Local endpoint |
| --- | --- |
| SIP | `192.168.0.112:5060/UDP` |
| Console and SIP WebSocket | `192.168.0.112:3097`, `/sip/ws` |
| RTP | UDP `12000–12063` |
| WebRTC | UDP `13001–13064` |
| Authenticated STUN/TURN | `192.168.0.112:3478`, UDP/TCP |
| TURN relay | UDP `14001–14064` |

These reduced ranges are for laboratory testing, not production capacity claims.
If the host address changes, update published ports and advertised addresses
together. Retrieve the lab extension credentials from the manager's telephony page.

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
on advertised port 3478. `preferWebRelayPort` now changes only the dial port,
preserving credentials, addresses and selection order. Uno enables it only
for sessions with `mobilePrimaryDraftId` when `UNOAPI_MOBILE_PRIMARY_LAB=true`
and `UNOAPI_SERVER_NAME=mobile_lab`. Conventional sessions retain advertised
ports. This does not change SIP, TURN, firewall or production configuration.
On September 25, 2026, the user confirmed two-way audio over both 4G and Wi-Fi
after applying this policy in the lab. This does not constitute production deployment.
Rollback: disable the plugin option, recompile and recreate the lab worker
without removing volumes or credentials.

## Reversible shutdown

Stop `voip` and `coturn` with the overlay loaded. Preserve the private environment
as a backup under a different name, then recreate `web` and `worker-zapo` using
only `compose.lab.yml`. Keep all volumes; never use `down -v` for this procedure.
No Windows firewall changes were needed for the checks on this host. If another
LAN device is blocked, scope any additional firewall rule to the laboratory LAN.
