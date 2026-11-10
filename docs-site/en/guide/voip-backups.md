# VoIP database backup and restore

Open **Telephony → Backups** in the ViperConnect manager. This is an administrator-only
global backup, separate from each WhatsApp session's `.viperstorage` archive.

The `.vipervoip` package includes a consistent WAL-aware SQLite snapshot,
companies, accounts, extensions, credentials/configuration, routing, call history,
recording metadata, transcripts/summaries and referenced **hold audio files**.
**Call recording files are excluded**, as selected by the operator. Redis,
RabbitMQ queues and WhatsApp session credentials are not included.

## Generate and download

Select **Generate backup** and confirm. Success requires upload followed by an
S3 read-back with matching size and SHA-256. The panel displays the bucket,
`backups/voip/{instance}/` prefix, seven weekday slots and download controls.

With VoIP and S3 configured, one automatic backup runs per 12-hour window.
Workers share a Redis reservation and a lease. Each weekday retains its latest
verified backup; older copies are retired only after a verified replacement
and a safety interval. Manual backups also update the weekday slot.

```yaml
environment:
  VOIP_SERVICE_URL: http://voip:3097
  VOIP_SERVICE_TOKEN: "service-token"
  # Reuses the application's private STORAGE_* S3 settings.
  VOIP_BACKUP_INSTANCE_ID: voip-main
  VOIP_BACKUP_ENABLED: "true"
  SESSION_STORAGE_BACKUP_TIMEZONE: America/Cuiaba
```

Automatic VoIP backups default to enabled when VoIP/S3 are configured. Setting
`VOIP_BACKUP_ENABLED=false` disables scheduling only. The instance defaults to
`voip-main`; use different IDs for different VoIP services sharing Redis/S3.
This does not require SQLite storage for WhatsApp sessions, but the VoIP service
itself must use SQLite on a persistent volume. Redis remains required for manager
authentication, coordination, reservations and catalog data.

No encryption key is required: archives contain readable credentials after
decompression. Keep the bucket private and review/rotate credentials after
recovery. Missing, external or out-of-scope hold audio causes an explicit backup
failure. Restore limits: 256 MiB compressed, 512 MiB of files, 100 WAV/MP3 audio files.

## Restore here or on another server

1. Prepare Redis/S3 and an updated SQLite VoIP service with a persistent volume.
2. Restore an S3 slot or upload a `.vipervoip` file downloaded elsewhere.
3. End calls and wait for active jobs/deliveries; confirm the operation.
4. ViperConnect first generates and verifies a pre-change backup of the target.
5. VoIP validates framing, hashes, database integrity and schema compatibility,
   then replaces data transactionally. No uploaded paths or arbitrary SQL are run.
6. Review configuration and credentials. The destination's SIP addresses and local
   recording directory are retained; hold audio is relocated into the target volume.

No previous Redis catalog is required, but WhatsApp sessions must be recovered
separately through `.viperstorage`. Missing local recording files are not restored;
S3 recording references depend on the original objects and permissions remaining available.

Restoration rejects active calls/background work and blocks new admission while
applying data. Old SIP registrations are removed, requiring re-registration.
Company webhooks remain **disabled** for review. Artifact delivery resets to
`legacy` and native wake is disabled, keeping the configuration valid and
editable; review these modes when enabling the integration again.
Queues/outbox are not replayed.
Calls open in the snapshot become `failed`/`backup_restored`, not resumed calls.
Old REST synchronization cursors expire; consumers must request a fresh snapshot.

On timeout, **do not repeat**. Refresh status to check VoIP's persisted receipt.
Further restores remain blocked while the result is uncertain. No automatic
retry or WhatsApp call/message is part of recovery.

## Authentication and routes

Administrator manager login only; regular users, company-scoped access and
personal/API keys cannot export or restore this global database.

- `GET /manager/voip-backups`: capability, S3 location, slots and state.
- `POST /manager/voip-backups` with `{"confirm":true}`: verified backup.
- `GET /manager/voip-backups/{id}/download`: private archive download.
- `POST /manager/voip-backups/restore` with `{"backupId":"UUID","confirm":true}`.
- `POST /manager/voip-backups/restore-upload?confirm=true`: binary
  `application/octet-stream`, up to 256 MiB, with `Content-Length`.

ViperConnect authenticates internal `/v1/console/backups/*` requests using
`VOIP_SERVICE_TOKEN`, never sent to the browser. Both services must be updated;
a new frontend cannot enable backups in an old VoIP image. Local documentation
and DEV validation do not publish or deploy production.
